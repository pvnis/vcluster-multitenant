"""Integration tests for the paging proxy control flow, with injected fakes for
the wake/sleep HTTP calls and the request forwarding — no GPU, no vllm, no httpx.
Run: python3 -m unittest test_serve -v"""

import asyncio
import random
import unittest

import serve
from residency import Model, Tier

TIERS = [Tier("pinned_ram", 64.0)]


class FakeCluster:
    """Emulates the per-model vLLM servers: tracks which are awake and asserts
    the proxy never forwards a request to a sleeping one."""

    def __init__(self, servers):              # name -> url
        self.url2name = {u: n for n, u in servers.items()}
        self.awake = set()
        self.posts = []                       # (name, "wake"|"sleep")
        self.forwards = []                    # names forwarded to
        self.max_awake = 0

    async def post(self, url):
        base, _, tail = url.rpartition("/")
        name = self.url2name[base]
        if tail.startswith("wake_up"):
            self.awake.add(name)
            self.posts.append((name, "wake"))
        elif tail.startswith("sleep"):
            self.awake.discard(name)
            self.posts.append((name, "sleep"))
        self.max_awake = max(self.max_awake, len(self.awake))

    async def forward(self, base_url, path, body, stream):
        name = self.url2name[base_url]
        assert name in self.awake, f"forwarded to SLEEPING server {name}"
        self.forwards.append(name)
        return 200, {"model": name, "choices": [{"text": "ok"}]}


def setup(sizes, budget):
    models = [Model(n, "t0", s, "pinned_ram") for n, s in sizes.items()]
    servers = {n: f"http://10.0.0.1:{8100 + i}" for i, n in enumerate(sizes)}
    fake = FakeCluster(servers)
    service, pager, backend = serve.build_service(
        models, servers, budget, tiers=TIERS,
        http_post=fake.post, forward=fake.forward)
    return service, pager, backend, fake


class TestProxy(unittest.IsolatedAsyncioTestCase):
    async def test_routes_and_pages(self):
        service, _, be, fake = setup({"a": 4000, "b": 4000}, budget=4000)  # fits one
        st, resp = await service.handle("/v1/completions", {"model": "a"})
        self.assertEqual(st, 200)
        self.assertEqual(resp["model"], "a")
        self.assertIn("a", fake.awake)
        # b forces a's eviction (sleep) and its own wake
        st, resp = await service.handle("/v1/completions", {"model": "b"})
        self.assertEqual(resp["model"], "b")
        self.assertIn(("a", "sleep"), fake.posts)
        self.assertIn(("b", "wake"), fake.posts)
        self.assertEqual(fake.max_awake, 1)          # never both at once
        self.assertEqual(be.loads, 2)

    async def test_unknown_model_404(self):
        service, *_ = setup({"a": 4000}, budget=8000)
        st, resp = await service.handle("/v1/chat/completions", {"model": "nope"})
        self.assertEqual(st, 404)

    async def test_too_big_returns_503(self):
        service, *_ = setup({"big": 9000}, budget=8000)
        st, resp = await service.handle("/v1/completions", {"model": "big"})
        self.assertEqual(st, 503)

    async def test_no_forward_to_sleeping_under_load(self):
        sizes = {f"m{i}": 4000 for i in range(6)}     # 24000 MiB
        service, _, be, fake = setup(sizes, budget=8000)   # fits 2
        rng = random.Random(0)
        names = [rng.choice(list(sizes)) for _ in range(120)]
        results = await asyncio.gather(
            *[service.handle("/v1/completions", {"model": n}) for n in names])
        self.assertTrue(all(st == 200 for st, _ in results))
        self.assertLessEqual(fake.max_awake, 2)       # never oversubscribed
        self.assertEqual(len(fake.forwards), 120)     # every request served
        self.assertGreater(be.loads, 2)               # real paging churn


if __name__ == "__main__":
    unittest.main()
