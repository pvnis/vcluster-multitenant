"""Replay a workload trace against a live ModelPager.

Unlike simulate.py (analytic, instantaneous), this drives the *real* async
daemon: requests are fired as concurrent tasks at their scheduled arrival times
(compressed by `--speedup`), the pager wakes/evicts through a Backend, and we
report what actually happened. Runs anywhere with MockBackend; point it at
VLLMBackend on a GPU node (edit `make_backend`) for real numbers.

Run:  python3 replay.py            # default scenario
      python3 replay.py --help
"""

from __future__ import annotations

import argparse
import asyncio
import random
import time

import workload
from backend import MockBackend
from pager import ModelPager
from residency import CapacityError, ResidencyManager, Tier

DEFAULT_TIERS = [
    Tier("peer_vram", 150.0),
    Tier("pinned_ram", 64.0),
    Tier("nvme", 6.0),
    Tier("remote_rdma", 50.0),
]


def _pct(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[i]


async def _fire(pager, req, max_tokens):
    prompt = "word " * req.prompt_tokens
    try:
        await pager.generate(req.model.name, prompt, max_tokens)
    except CapacityError:
        pass   # recorded as a reject in pager.stats


async def drive(pager, trace, speedup):
    base = trace[0].arrival
    t0 = time.perf_counter()
    tasks = []
    for r in trace:
        elapsed_sim = (time.perf_counter() - t0) * speedup
        target = r.arrival - base
        if target > elapsed_sim:
            await asyncio.sleep((target - elapsed_sim) / speedup)
        tasks.append(asyncio.create_task(_fire(pager, r, max_tokens=16)))
    await asyncio.gather(*tasks, return_exceptions=True)


def summarize(pager, backend, models, budget):
    recs = [r for r in pager.stats.records if r.ok]
    setups = [r.setup_s for r in recs]
    setups_hit = [r.setup_s for r in recs if r.hit]
    setups_miss = [r.setup_s for r in recs if not r.hit]
    total_mib = workload.total_weight_mib(models)
    return {
        "requests": len(pager.stats.records),
        "served": len(recs),
        "rejects": pager.stats.rejects,
        "overcommit_x": round(total_mib / budget, 2),
        "hit_rate": round(pager.hits / max(1, pager.hits + pager.misses), 3),
        "wakes": backend.loads,
        "evicts": backend.evicts,
        "peak_vram_mib": backend.peak_mib,
        "budget_mib": budget,
        "peak_ok": backend.peak_mib <= budget,
        "setup_p50_ms": round(_pct(setups, 50) * 1000, 1),
        "setup_p99_ms": round(_pct(setups, 99) * 1000, 1),
        "setup_p50_hit_ms": round(_pct(setups_hit, 50) * 1000, 1),
        "setup_p50_miss_ms": round(_pct(setups_miss, 50) * 1000, 1),
    }


def make_backend(models, speedup):
    # swap this for VLLMBackend({name: path, ...}, ...) on a GPU node.
    return MockBackend(models, DEFAULT_TIERS, speedup=speedup)


async def main_async(args):
    rng = random.Random(args.seed)
    models = workload.make_models(
        args.models, args.tenants,
        [int(x) for x in args.sizes.split(",")], args.master_tier, rng)
    trace = workload.gen_trace(models, args.requests, args.rate, args.cv,
                               args.skew, args.prompt_mean, args.output_mean, rng)
    mgr = ResidencyManager(args.budget, DEFAULT_TIERS)
    backend = make_backend(models, args.speedup)
    pager = ModelPager(mgr, backend, models)

    wall0 = time.perf_counter()
    await drive(pager, trace, args.speedup)
    wall = time.perf_counter() - wall0

    s = summarize(pager, backend, models, args.budget)
    print(f"\n=== live replay (budget={args.budget} MiB, speedup={args.speedup}x, "
          f"wall={wall:.1f}s) ===")
    w = max(len(k) for k in s)
    for k, v in s.items():
        print(f"  {k:<{w}} : {v}")
    if not s["peak_ok"]:
        print("  !! physical VRAM exceeded budget — oversubscription bug")


def build_parser():
    p = argparse.ArgumentParser(description="Live replay against the ModelPager")
    p.add_argument("--models", type=int, default=24)
    p.add_argument("--tenants", type=int, default=6)
    p.add_argument("--sizes", default="6000,12000,24000")
    p.add_argument("--budget", type=int, default=48000)
    p.add_argument("--requests", type=int, default=1500)
    p.add_argument("--rate", type=float, default=2.5)
    p.add_argument("--cv", type=float, default=3.0)
    p.add_argument("--skew", type=float, default=1.1)
    p.add_argument("--prompt-mean", type=int, default=64, dest="prompt_mean")
    p.add_argument("--output-mean", type=int, default=32, dest="output_mean")
    p.add_argument("--master-tier", default="pinned_ram")
    p.add_argument("--speedup", type=float, default=300.0,
                   help="compress modeled latencies so the trace runs fast")
    p.add_argument("--seed", type=int, default=1)
    return p


if __name__ == "__main__":
    asyncio.run(main_async(build_parser().parse_args()))
