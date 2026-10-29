"""Async tests for the ModelPager concurrency control (MockBackend, no GPU).
Run: python3 -m unittest test_pager -v"""

import asyncio
import random
import unittest

import workload
from backend import MockBackend
from pager import ModelPager
from residency import CapacityError, Model, ResidencyManager, Tier

TIERS = [Tier("pinned_ram", 64.0), Tier("nvme", 6.0)]


def mk(name, tenant, size, tier="pinned_ram"):
    return Model(name, tenant, size, tier)


def pager_for(models, budget, speedup=1e6, reserved=None):
    mgr = ResidencyManager(budget, TIERS, reserved_mib=reserved)
    be = MockBackend(models, TIERS, speedup=speedup)
    return ModelPager(mgr, be, models), be, mgr


class TestPager(unittest.IsolatedAsyncioTestCase):
    async def test_hit_then_miss(self):
        a = mk("a", "t0", 4000)
        p, be, _ = pager_for([a], budget=8000)
        await p.generate("a", "hello world", 4)
        await p.generate("a", "hello world", 4)
        self.assertEqual(be.loads, 1)           # second is a hit, no wake
        self.assertEqual(p.hits, 1)
        self.assertEqual(p.misses, 1)

    async def test_wake_coalescing(self):
        # 10 concurrent requests to a cold model -> exactly one wake.
        a = mk("a", "t0", 4000)
        p, be, _ = pager_for([a], budget=8000, speedup=50.0)
        await asyncio.gather(*[p.generate("a", "hi there", 4) for _ in range(10)])
        self.assertEqual(be.loads, 1)
        self.assertEqual(p.misses, 1)
        self.assertEqual(p.hits, 9)

    async def test_no_oversubscription_under_load(self):
        models = [mk(f"m{i}", f"t{i%4}", 4000) for i in range(20)]  # 80000 MiB
        budget = 8000                                              # fits 2
        p, be, _ = pager_for(models, budget, speedup=1e5)
        rng = random.Random(0)
        reqs = [rng.choice(models).name for _ in range(300)]
        await asyncio.gather(*[p.generate(n, "a b c", 4) for n in reqs])
        self.assertLessEqual(be.peak_mib, budget)                  # never oversubscribed
        self.assertLessEqual(be.resident_mib, budget)
        self.assertEqual(p.stats.rejects, 0)                       # each model fits
        self.assertGreater(be.loads, 2)                            # real paging happened

    async def test_rejects_model_bigger_than_budget(self):
        big = mk("big", "t0", 9000)
        p, be, _ = pager_for([big], budget=8000)
        with self.assertRaises(CapacityError):
            await p.generate("big", "x", 1)
        self.assertEqual(p.stats.rejects, 1)
        self.assertEqual(be.loads, 0)

    async def test_pinned_victim_blocks_until_freed(self):
        # Budget fits exactly one. 'a' is held in a gated infer; a request for
        # 'b' must wait (can't evict pinned a), then proceed once a finishes.
        a = mk("a", "t0", 4000)
        b = mk("b", "t1", 4000)
        gate = asyncio.Event()

        class GatedBackend(MockBackend):
            async def infer(self, name, prompt, max_tokens):
                if name == "a":
                    await gate.wait()
                return await super().infer(name, prompt, max_tokens)

        mgr = ResidencyManager(4000, TIERS)
        be = GatedBackend([a, b], TIERS, speedup=1e5)
        p = ModelPager(mgr, be, [a, b])

        ta = asyncio.create_task(p.generate("a", "hi", 4))
        while be.loads < 1:                      # wait until a is resident+in infer
            await asyncio.sleep(0)
        tb = asyncio.create_task(p.generate("b", "hi", 4))
        await asyncio.sleep(0)                   # let b reach its wait
        self.assertFalse(tb.done())              # b is blocked on pinned a
        self.assertTrue(mgr.is_resident("a") and not mgr.is_resident("b"))

        gate.set()                               # a finishes -> unpins -> b proceeds
        await asyncio.gather(ta, tb)
        self.assertEqual(be.loads, 2)            # a then b
        self.assertLessEqual(be.peak_mib, 4000)  # never both at once
        self.assertFalse(mgr.is_resident("a"))   # a evicted for b
        self.assertTrue(mgr.is_resident("b"))

    async def test_smoke_replay(self):
        import replay
        rng = random.Random(0)
        models = workload.make_models(10, 3, [4000, 8000], "pinned_ram", rng)
        trace = workload.gen_trace(models, 200, 4.0, 2.0, 1.0, 32, 16, rng)
        budget = max(max(m.size_mib for m in models),
                     workload.total_weight_mib(models) // 3)
        mgr = ResidencyManager(budget, replay.DEFAULT_TIERS)
        be = MockBackend(models, replay.DEFAULT_TIERS, speedup=1e5)
        p = ModelPager(mgr, be, models)
        await replay.drive(p, trace, speedup=1e5)
        s = replay.summarize(p, be, models, budget)
        self.assertEqual(s["served"] + s["rejects"], 200)
        self.assertTrue(s["peak_ok"])
        self.assertGreater(s["overcommit_x"], 1.0)


if __name__ == "__main__":
    unittest.main()
