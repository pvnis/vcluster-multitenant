"""Unit tests for the residency policy. Run: python3 -m unittest -v
(stdlib only; no GPU, no vLLM)."""

import random
import unittest

import workload
from residency import (CapacityError, CostAwareLRU, LRU, Model,
                       ResidencyManager, Tier)

TIERS = [Tier("pinned_ram", 64.0), Tier("nvme", 6.0)]


def mk(name, tenant, size, tier="pinned_ram"):
    return Model(name, tenant, size, tier)


class TestResidency(unittest.TestCase):
    def test_hit_is_free_miss_costs(self):
        mgr = ResidencyManager(10000, TIERS)
        a = mk("a", "t0", 4000)
        self.assertGreater(mgr.access(a, 0.0), 0.0)   # miss faults
        self.assertEqual(mgr.access(a, 1.0), 0.0)     # hit is free
        self.assertEqual(mgr.hits, 1)
        self.assertEqual(mgr.misses, 1)

    def test_fault_latency_scales_with_size_and_bw(self):
        mgr = ResidencyManager(100000, TIERS)
        slow = mk("s", "t0", 6000, "nvme")
        fast = mk("f", "t0", 6000, "pinned_ram")
        self.assertAlmostEqual(mgr.fault_seconds(slow) / mgr.fault_seconds(fast),
                               64.0 / 6.0, places=5)

    def test_capacity_never_exceeded(self):
        mgr = ResidencyManager(10000, TIERS)
        for i in range(10):
            mgr.access(mk(f"m{i}", "t0", 4000), float(i))
            self.assertLessEqual(mgr.used_mib, mgr.budget)
        self.assertLessEqual(len(mgr.resident), 2)   # only two 4000-MiB fit

    def test_clean_evict_frees_without_writeback(self):
        mgr = ResidencyManager(8000, TIERS)
        mgr.access(mk("a", "t0", 4000), 0.0)
        mgr.access(mk("b", "t0", 4000), 1.0)
        mgr.access(mk("c", "t0", 4000), 2.0)          # evicts LRU 'a'
        self.assertFalse(mgr.is_resident("a"))
        self.assertTrue(mgr.is_resident("b") and mgr.is_resident("c"))
        self.assertEqual(mgr.evictions, 1)

    def test_lru_victim(self):
        mgr = ResidencyManager(8000, TIERS)
        mgr.access(mk("a", "t0", 4000), 0.0)
        mgr.access(mk("b", "t0", 4000), 1.0)
        mgr.access(mk("a", "t0", 4000), 5.0)          # touch a -> b is now LRU
        mgr.access(mk("c", "t0", 4000), 6.0)          # evicts b
        self.assertTrue(mgr.is_resident("a"))
        self.assertFalse(mgr.is_resident("b"))

    def test_pinned_never_evicted(self):
        mgr = ResidencyManager(4000, TIERS)             # fits exactly one
        mgr.access(mk("a", "t0", 4000), 0.0)
        mgr.pin("a")
        with self.assertRaises(CapacityError):          # only victim is pinned
            mgr.access(mk("b", "t0", 4000), 1.0)
        self.assertTrue(mgr.is_resident("a"))

    def test_overcommit_sum_exceeds_budget(self):
        mgr = ResidencyManager(8000, TIERS)
        models = [mk(f"m{i}", "t0", 4000) for i in range(6)]  # 24000 MiB total
        for t, m in enumerate(models):
            mgr.access(m, float(t))
        self.assertGreater(sum(m.size_mib for m in models), mgr.budget)
        self.assertLessEqual(mgr.used_mib, mgr.budget)
        self.assertGreaterEqual(mgr.misses, 6)          # each re-admit is a miss

    def test_model_bigger_than_budget_raises(self):
        mgr = ResidencyManager(3000, TIERS)
        with self.assertRaises(CapacityError):
            mgr.access(mk("big", "t0", 4000), 0.0)

    def test_reserved_floor_protects_tenant(self):
        # t0's floor == budget: its model must never be evicted for t1, even when
        # it is the only possible victim.
        mgr = ResidencyManager(4000, TIERS, reserved_mib={"t0": 4000})
        mgr.access(mk("a", "t0", 4000), 0.0)
        with self.assertRaises(CapacityError):          # can't evict protected a
            mgr.access(mk("b", "t1", 4000), 1.0)
        self.assertTrue(mgr.is_resident("a"))

    def test_reserved_floor_still_allows_evicting_own_idle(self):
        # A floor protects a tenant's *total*, not each model: t0 (floor 4000)
        # holding 8000 may still give up one idle model for another request.
        mgr = ResidencyManager(8000, TIERS, reserved_mib={"t0": 4000})
        mgr.access(mk("a", "t0", 4000), 0.0)
        mgr.access(mk("b", "t0", 4000), 1.0)            # t0 at 8000
        mgr.access(mk("c", "t0", 4000), 2.0)            # evict one, t0 stays >=4000
        self.assertEqual(mgr.tenant_resident_mib("t0"), 8000)
        self.assertEqual(mgr.evictions, 1)

    def test_evicts_requesting_tenants_own_idle_first(self):
        # Budget fits 2. t0 holds one idle, t1 holds one idle; t1 asks for a 2nd.
        # Fairness rule 1: t1 should evict its OWN idle first, sparing t0.
        mgr = ResidencyManager(8000, TIERS)
        mgr.access(mk("a", "t0", 4000), 10.0)           # t0, newer
        mgr.access(mk("b", "t1", 4000), 0.0)            # t1, older (LRU globally)
        mgr.access(mk("c", "t1", 4000), 20.0)           # t1 asks -> evict own 'b'
        self.assertTrue(mgr.is_resident("a"))           # t0 spared
        self.assertFalse(mgr.is_resident("b"))          # own idle evicted


    def test_cost_aware_keeps_expensive_master(self):
        # b's master is on slow NVMe (expensive to refault), a's on fast RAM;
        # b is the older. LRU evicts the older b; cost-aware keeps b (costly to
        # reload) and evicts the cheap-to-reload a instead.
        def run(policy):
            m = ResidencyManager(8000, TIERS, policy=policy)
            m.access(mk("b", "t0", 4000, "nvme"), 1.0)        # older, expensive
            m.access(mk("a", "t0", 4000, "pinned_ram"), 5.0)  # newer, cheap
            m.access(mk("c", "t0", 4000), 6.0)                # evict one
            return m
        lru = run(LRU())
        self.assertFalse(lru.is_resident("b"))   # plain LRU drops the older b
        self.assertTrue(lru.is_resident("a"))
        cost = run(CostAwareLRU(beta=30.0))
        self.assertTrue(cost.is_resident("b"))   # cost-aware keeps expensive b
        self.assertFalse(cost.is_resident("a"))


class TestSimSmoke(unittest.TestCase):
    def test_simulator_runs_and_overcommits(self):
        import simulate
        rng = random.Random(0)
        models = workload.make_models(12, 4, [4000, 8000], "pinned_ram", rng)
        trace = workload.gen_trace(models, 300, rate_rps=5, cv=2.0,
                                   popularity_s=1.0, prompt_mean=256,
                                   output_mean=64, rng=rng)
        budget = workload.total_weight_mib(models) // 3
        budget = max(budget, max(m.size_mib for m in models))
        mgr = ResidencyManager(budget, simulate.DEFAULT_TIERS)
        records, reqs = simulate.simulate(mgr, trace, simulate.ComputeModel())
        s = simulate.summarize(mgr, records, reqs, models, budget)
        self.assertEqual(s["served"], 300)
        self.assertGreater(s["overcommit_x"], 1.0)
        self.assertGreaterEqual(mgr.used_mib, 0)
        self.assertLessEqual(mgr.used_mib, budget)
        self.assertTrue(0.0 <= s["hit_rate"] <= 1.0)


if __name__ == "__main__":
    unittest.main()
