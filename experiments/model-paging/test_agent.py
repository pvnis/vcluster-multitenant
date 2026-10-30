"""End-to-end tests for the proxy-less path: per-model ResidencyAgents talking to
the reference ResidencyBroker over real unix sockets, all sharing one MockBackend
(the single physical GPU) so we can assert the budget is never oversubscribed.
No GPU, no vllm. Run: python3 -m unittest test_agent -v"""

import asyncio
import os
import random
import tempfile
import unittest

from agent import AgentModel, RejectedError, ResidencyAgent
from backend import MockBackend
from broker import ResidencyBroker
from residency import ResidencyManager, Tier

TIERS = [Tier("pinned_ram", 64.0), Tier("nvme", 6.0)]


class Harness:
    """A broker on a unix socket + one agent per model, sharing a MockBackend."""

    def __init__(self, sizes, budget, speedup=1e5):
        self.sizes = sizes            # name -> (tenant, size_mib)
        self.budget = budget
        self.speedup = speedup

    async def __aenter__(self):
        self.models = [AgentModel(n, t, s) for n, (t, s) in self.sizes.items()]
        self.be = MockBackend(self.models, TIERS, speedup=self.speedup)
        self.mgr = ResidencyManager(self.budget, TIERS)
        self.broker = ResidencyBroker(self.mgr)
        self.dir = tempfile.mkdtemp()
        self.path = os.path.join(self.dir, "resid.sock")
        self.server = await asyncio.start_unix_server(self.broker.serve, self.path)
        self.agents = {}
        for m in self.models:
            r, w = await asyncio.open_unix_connection(self.path)
            a = ResidencyAgent(m, self.be, r, w)
            await a.start()
            self.agents[m.name] = a
        return self

    async def __aexit__(self, *exc):
        for a in self.agents.values():
            await a.close()
        self.server.close()   # not awaiting wait_closed(): the test loop tears tasks down
        try:
            os.remove(self.path)
            os.rmdir(self.dir)
        except OSError:
            pass


class TestProxyless(unittest.IsolatedAsyncioTestCase):
    async def test_cold_request_wakes_then_hits(self):
        async with Harness({"a": ("t0", 4000)}, budget=8000) as h:
            await h.agents["a"].handle_request("hi")
            self.assertEqual(h.be.loads, 1)           # cold -> one wake
            self.assertTrue(h.agents["a"].resident)
            await h.agents["a"].handle_request("hi")
            self.assertEqual(h.be.loads, 1)           # still resident -> no new wake

    async def test_eviction_under_pressure(self):
        # budget fits one; serving B must evict idle A across the socket.
        async with Harness({"a": ("t0", 4000), "b": ("t1", 4000)}, budget=4000) as h:
            await h.agents["a"].handle_request("hi")  # A resident
            self.assertTrue(h.agents["a"].resident)
            await h.agents["b"].handle_request("hi")  # evicts A, wakes B
            self.assertFalse(h.agents["a"].resident)  # A slept
            self.assertTrue(h.agents["b"].resident)
            self.assertLessEqual(h.be.peak_mib, 4000) # never both at once
            self.assertEqual(h.be.loads, 2)

    async def test_concurrent_same_model_one_wake(self):
        async with Harness({"a": ("t0", 4000)}, budget=8000) as h:
            await asyncio.gather(*[h.agents["a"].handle_request("hi") for _ in range(10)])
            self.assertEqual(h.be.loads, 1)           # wake coalesced at the agent

    async def test_reject_too_big(self):
        async with Harness({"big": ("t0", 9000)}, budget=8000) as h:
            with self.assertRaises(RejectedError):
                await h.agents["big"].handle_request("hi")

    async def test_no_oversubscription_under_load(self):
        sizes = {f"m{i}": (f"t{i%3}", 4000) for i in range(6)}  # 24000 total
        async with Harness(sizes, budget=8000) as h:            # fits 2
            rng = random.Random(0)
            names = [rng.choice(list(sizes)) for _ in range(120)]
            await asyncio.gather(*[h.agents[n].handle_request("hi") for n in names])
            self.assertLessEqual(h.be.peak_mib, 8000)           # never oversubscribed
            self.assertLessEqual(h.be.resident_mib, 8000)
            self.assertGreater(h.be.loads, 2)                   # real paging churn


if __name__ == "__main__":
    unittest.main()
