# Model-paging POC

A proof-of-concept for the VRAM-overcommit scheme in
`../../manifests/midori/MODEL-PAGING.md`: treat model weights as a **clean cache**
of a host-resident master, so eviction is free and only fault-in costs bandwidth.

This is **step 1 of the prototype plan** — an out-of-band residency manager + a
discrete-event simulator that validates the *policy* (hit rate vs VRAM budget,
cold-start tail, thrash, fairness) with **no GPU required** — plus a real vLLM
backend seam (`vllm_backend.py`) you run on a GPU node to calibrate it.

## Files

| file | what |
| --- | --- |
| `residency.py` | the residency manager — pure policy + accounting. Multi-tier masters, clean-cache (evict = free), whole-model, LRU eviction with two fairness rules (own-idle-first; never below a tenant's reserved floor), pinned-never-evicted. Fault-in latency = weight bytes / master-tier bandwidth. |
| `workload.py` | N models across tenants, Zipfian popularity, bursty arrivals (Poisson or Gamma at a target CV). |
| `simulate.py` | single-GPU FCFS discrete-event sim + metrics + CLI (default scenario + budget sweep). |
| `vllm_backend.py` | **GPU-only** seam: drives a real vLLM engine via `sleep`/`wake_up`, and `measure_wake()` to get wall-clock wake latency. Not imported by the sim or tests. |
| `test_residency.py` | unit tests for the policy (stdlib `unittest`). |

## Run

```bash
python3 -m unittest            # 12 policy + smoke tests
python3 simulate.py            # default scenario + budget sweep
python3 simulate.py --help     # knobs: models/tenants/sizes/budget/rate/cv/skew/seed
python3 simulate.py --budget 24000 --cv 1.0 --no-sweep
```

Stdlib only (Python 3.12). No external deps for the sim or tests.

## What it shows (default: 24 models, 6 tenants, 6/12/24 GiB, bursty CV=3)

The budget sweep is the headline — one trace, shrinking VRAM:

```
budget_MiB   overcmt  hit_rate  ttft_p50_ms  ttft_p99_ms  evict/req  stalls
   312000       1.0     0.994        171          1701        0.0        0
   156000       2.0     0.765        426          3120        0.23       0
    78000       4.0     0.546        756          5258        0.45       0
    46800      6.67     0.354       1171          6996        0.65       0
```

So you can host **2× the models in the same VRAM at ~77% hit rate** and ~426 ms
p50 TTFT — memory overcommit works, and the cost curve is smooth, not a cliff.
The cold-start penalty is isolated as `fault_mean_ms` (~206 ms for a ~14 GiB
model over a 64 GB/s PCIe-Gen5 master), and shows up as the hit-vs-miss TTFT gap.

The tests pin the policy's correctness: clean eviction frees without writeback,
capacity is never exceeded, LRU picks the right victim, pinned/active models are
never evicted, a tenant's reserved floor is honored, requests evict their own
idle models first, and Σmodels > budget is served by re-faulting cold models.

## Simplifications (deliberate; see MODEL-PAGING.md for the full design)

- **Single GPU, one request in service at a time.** No continuous batching /
  intra-GPU concurrency — decode is assumed to overlap across requests, so the
  sim models GPU occupancy as *fault + prefill* (the latency-critical, memory-
  sensitive path) and leaves decode out of the blocking path. The question here
  is memory residency, not scheduler concurrency.
- **LRU eviction**, not yet the cost-model placement policy (load-from-tier vs
  evict vs migrate) the design calls for. LRU is the documented first cut.
- **One master tier** per run (default pinned host RAM). The manager supports
  per-model tiers; extend `make_models` for multi-tier studies.
- **Prefill/fault latencies are modeled**, not measured. Calibrate them on real
  hardware (below) before trusting absolute numbers; the *shape* of the curves is
  the point.

## Going live (GPU node)

`vllm_backend.py` is the seam. On a GPU node with vLLM:

```bash
python3 vllm_backend.py <hf-model-id-or-path>   # prints wall-clock wake latency
```

Feed the measured wake latency back into `simulate.py`'s `DEFAULT_TIERS`
(`pinned_ram` bandwidth) so the sim reflects your interconnect — then the
hit-rate curve predicts real TTFT. Wiring the manager to drive a live
`VLLMBackend` across a real request trace is the next step; the interfaces line
up (`access`/`pin`/`unpin` ↔ `load`/`evict`/`infer`).
```
