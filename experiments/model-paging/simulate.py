"""Discrete-event simulator for the model-paging POC.

One GPU, FCFS queue. On each request the server, at service start, asks the
ResidencyManager to make the model resident (evicting idle victims as needed and
paying a fault-in if it was sleeping), then runs prefill+decode. This validates
the *policy* — hit rate, cold-start tail, thrash, fairness — against a VRAM
budget smaller than the sum of all model weights, with no GPU required.

Simplifications (deliberate for a first POC):
  - single GPU, one request in service at a time (no intra-GPU concurrency /
    continuous batching). The question here is memory residency, not scheduler
    concurrency; a multi-server extension is noted in the README.
  - compute time is a crude linear model, scaled by weight size.
Run:  python3 simulate.py            # default scenario + budget sweep
      python3 simulate.py --help
"""

from __future__ import annotations

import argparse
import random
from dataclasses import dataclass

import workload
from residency import (CapacityError, CostAwareLRU, LRU, Model,
                       ResidencyManager, Tier)

# Default interconnect tiers (decimal GB/s). See MODEL-PAGING.md topology table.
DEFAULT_TIERS = [
    Tier("peer_vram", 150.0),   # NVLink-class peer HBM
    Tier("pinned_ram", 64.0),   # PCIe Gen5 x16
    Tier("nvme", 6.0),          # local NVMe
    Tier("remote_rdma", 50.0),  # 400G GPUDirect RDMA
]

REF_MIB = 13000.0  # a ~13 GiB model is the reference for the compute model


@dataclass
class ComputeModel:
    """Latency-critical, memory-sensitive path only. In a real server decode is
    overlapped across requests by continuous batching, so it does not block a new
    request's time-to-first-token; the POC therefore models GPU occupancy as
    fault + prefill and leaves decode out of the blocking path (a batching model
    is a later extension). Prefill scales with weight size."""

    prefill_s_per_tok: float = 0.00015   # at REF_MIB

    def prefill_s(self, m: Model, prompt):
        return prompt * self.prefill_s_per_tok * (m.size_mib / REF_MIB)


@dataclass
class Record:
    model: str
    tenant: str
    hit: bool
    fault_s: float
    queue_s: float
    ttft_s: float
    stalled: bool = False


def simulate(manager: ResidencyManager, requests, compute: ComputeModel):
    reqs = sorted(requests, key=lambda r: r.arrival)
    server_free = 0.0
    records = []
    for r in reqs:
        start = max(r.arrival, server_free)
        try:
            fault = manager.access(r.model, start)
        except CapacityError:
            records.append(Record(r.model.name, r.model.tenant,
                                  False, 0.0, 0.0, 0.0, stalled=True))
            continue
        manager.pin(r.model.name)
        prefill = compute.prefill_s(r.model, r.prompt_tokens)
        service = fault + prefill          # decode overlaps via batching
        finish = start + service
        manager.unpin(r.model.name)
        server_free = finish
        records.append(Record(
            model=r.model.name, tenant=r.model.tenant,
            hit=(fault == 0.0), fault_s=fault,
            queue_s=start - r.arrival,
            ttft_s=(start - r.arrival) + fault + prefill,
        ))
    return records, reqs


def _pct(xs, p):
    if not xs:
        return 0.0
    s = sorted(xs)
    i = min(len(s) - 1, max(0, int(round((p / 100.0) * (len(s) - 1)))))
    return s[i]


def summarize(manager, records, reqs, models, budget):
    served = [r for r in records if not r.stalled]
    stalls = sum(1 for r in records if r.stalled)
    ttft = [r.ttft_s for r in served]
    ttft_hit = [r.ttft_s for r in served if r.hit]
    ttft_miss = [r.ttft_s for r in served if not r.hit]
    queues = [r.queue_s for r in served]
    faults = [r.fault_s for r in served if not r.hit]
    makespan = (reqs[-1].arrival - reqs[0].arrival) if len(reqs) > 1 else 1.0
    total_mib = workload.total_weight_mib(models)
    return {
        "requests": len(records),
        "served": len(served),
        "stalls": stalls,
        "overcommit_x": round(total_mib / budget, 2),
        "models": len(models),
        "hit_rate": round(manager.hit_rate, 3),
        "evictions": manager.evictions,
        "evict_per_req": round(manager.evictions / max(1, len(served)), 3),
        "ttft_p50_ms": round(_pct(ttft, 50) * 1000, 1),
        "ttft_p99_ms": round(_pct(ttft, 99) * 1000, 1),
        "ttft_p50_hit_ms": round(_pct(ttft_hit, 50) * 1000, 1),
        "ttft_p50_miss_ms": round(_pct(ttft_miss, 50) * 1000, 1),
        "ttft_p99_miss_ms": round(_pct(ttft_miss, 99) * 1000, 1),
        "queue_mean_ms": round((sum(queues) / len(queues) * 1000) if queues else 0.0, 1),
        "fault_mean_ms": round((sum(faults) / len(faults) * 1000) if faults else 0.0, 1),
        "fault_total_s": round(sum(r.fault_s for r in served), 1),
        "gib_faulted": round(manager.mib_faulted / 1024, 1),
        "resident_end": len(manager.resident),
        "throughput_rps": round(len(served) / makespan, 2) if makespan else 0.0,
    }


def _print_summary(tag, s):
    print(f"\n=== {tag} ===")
    w = max(len(k) for k in s)
    for k, v in s.items():
        print(f"  {k:<{w}} : {v}")


def make_policy(name):
    return CostAwareLRU() if name == "cost" else LRU()


def run_scenario(args):
    rng = random.Random(args.seed)
    models = workload.make_models(
        args.models, args.tenants,
        size_choices_mib=[int(x) for x in args.sizes.split(",")],
        master_tier=args.master_tier, rng=rng, nvme_frac=args.nvme_frac)
    trace = workload.gen_trace(
        models, args.requests, args.rate, args.cv, args.skew,
        args.prompt_mean, args.output_mean, rng)
    compute = ComputeModel()

    mgr = ResidencyManager(args.budget, DEFAULT_TIERS, policy=make_policy(args.policy))
    records, reqs = simulate(mgr, trace, compute)
    _print_summary(f"scenario (budget={args.budget} MiB, policy={args.policy})",
                   summarize(mgr, records, reqs, models, args.budget))

    if args.nvme_frac > 0:
        print("\n=== policy comparison (same trace & budget, "
              f"{args.nvme_frac:.0%} masters on NVMe) ===")
        for name in ("lru", "cost"):
            m = ResidencyManager(args.budget, DEFAULT_TIERS, policy=make_policy(name))
            recs, rq = simulate(m, trace, compute)
            s = summarize(m, recs, rq, models, args.budget)
            print(f"  {name:>5}: hit_rate={s['hit_rate']}  "
                  f"fault_total_s={s['fault_total_s']}  ttft_p50_ms={s['ttft_p50_ms']}")

    if args.sweep:
        print("\n=== budget sweep (same trace) ===")
        total = workload.total_weight_mib(models)
        hdr = ("budget_MiB", "overcmt", "hit_rate", "ttft_p50_ms",
               "ttft_p99_ms", "evict/req", "stalls")
        print("  " + "  ".join(f"{h:>11}" for h in hdr))
        for frac in (1.0, 0.75, 0.5, 0.35, 0.25, 0.15):
            b = max(max(m.size_mib for m in models), int(total * frac))
            m2 = ResidencyManager(b, DEFAULT_TIERS, policy=make_policy(args.policy))
            recs, rq = simulate(m2, trace, compute)
            s = summarize(m2, recs, rq, models, b)
            row = (b, s["overcommit_x"], s["hit_rate"], s["ttft_p50_ms"],
                   s["ttft_p99_ms"], s["evict_per_req"], s["stalls"])
            print("  " + "  ".join(f"{str(v):>11}" for v in row))


def build_parser():
    p = argparse.ArgumentParser(description="Model-paging POC simulator")
    p.add_argument("--models", type=int, default=24)
    p.add_argument("--tenants", type=int, default=6)
    p.add_argument("--sizes", default="6000,12000,24000",
                   help="comma-separated model weight sizes in MiB")
    p.add_argument("--budget", type=int, default=48000,
                   help="VRAM budget in MiB (resident set must fit)")
    p.add_argument("--requests", type=int, default=4000)
    p.add_argument("--rate", type=float, default=2.5,
                   help="requests/sec (default keeps a single GPU stably loaded)")
    p.add_argument("--cv", type=float, default=3.0,
                   help="arrival coefficient of variation (1=Poisson, >1 bursty)")
    p.add_argument("--skew", type=float, default=1.1, help="Zipf popularity skew")
    p.add_argument("--prompt-mean", type=int, default=512, dest="prompt_mean")
    p.add_argument("--output-mean", type=int, default=128, dest="output_mean")
    p.add_argument("--master-tier", default="pinned_ram")
    p.add_argument("--policy", choices=["lru", "cost"], default="lru",
                   help="eviction policy; 'cost' protects slow-to-reload masters")
    p.add_argument("--nvme-frac", type=float, default=0.0, dest="nvme_frac",
                   help="fraction of masters on NVMe (enables the policy comparison)")
    p.add_argument("--seed", type=int, default=1)
    p.add_argument("--sweep", action="store_true", default=True)
    p.add_argument("--no-sweep", action="store_false", dest="sweep")
    return p


if __name__ == "__main__":
    run_scenario(build_parser().parse_args())
