# Model-paging POC + runtime

An implementation of the VRAM-overcommit scheme in
`../../manifests/midori/MODEL-PAGING.md`: model weights are a **clean cache** of a
host-resident master, so eviction is free and only fault-in costs bandwidth.

Two layers, same policy core:

1. **Analytic simulator** (`simulate.py`) — a fast, instantaneous discrete-event
   sweep for exploring the policy (hit rate vs VRAM budget, cold-start tail,
   thrash) over whole traces in milliseconds. No GPU.
2. **The real daemon** (`pager.py`) — an online, concurrent request server that
   actually drives engine sleep/wake through a `Backend`. Runs anywhere against
   `MockBackend`; runs on a GPU against `VLLMBackend`. `replay.py` fires a trace
   at it live.

## Files

| file | what |
| --- | --- |
| `residency.py` | policy brain. Multi-tier masters, clean-cache (evict = free, no writeback), whole-model, pluggable eviction policy (`LRU`, or `CostAwareLRU` which protects slow-to-reload masters) with fairness (own-idle-first; never below a tenant's reserved floor), pinned-never-evicted. `admit()` is atomic: it plans + applies all evictions and returns the victims, or raises `CapacityError` having changed nothing. |
| `workload.py` | N models across tenants, Zipfian popularity, bursty (Gamma/CV) arrivals. |
| `simulate.py` | analytic single-GPU sim + metrics + budget sweep. |
| `backend.py` | async engine backends: `MockBackend` (no GPU; tracks physical VRAM so tests can assert no oversubscription) and `VLLMBackend` (real vLLM sleep/wake, GPU-only) + `measure_wake()`. |
| `pager.py` | **ModelPager** — the online daemon: per-model transition locks, a global DMA-serializing lock, and a condition var so an admission whose victims are all pinned waits for an unpin. Inference holds only a pin, so resident models serve concurrently. |
| `replay.py` | drives a trace at the live pager at (compressed) real time; reports hit rate, wakes/evicts, peak VRAM vs budget, setup latency. |
| `test_residency.py` | 12 policy unit tests. |
| `test_pager.py` | 6 async concurrency tests (wake coalescing, no oversubscription under load, pinned-victim blocking, rejects). |

## Run

```bash
python3 -m unittest             # all 18 tests (stdlib only, no GPU)
python3 simulate.py             # analytic scenario + budget sweep
python3 simulate.py --policy cost --nvme-frac 0.4   # cost-aware vs LRU comparison
python3 replay.py               # live daemon replay (MockBackend)
python3 simulate.py --help      # knobs for both sim and replay
```

Python 3.12, stdlib only for the sim/daemon/tests. `VLLMBackend` needs `vllm`.

## What it shows

**Analytic sweep** (`simulate.py`, 24 models, 6.5× total weight vs VRAM, bursty):

```
budget_MiB   overcmt  hit_rate  ttft_p50_ms  ttft_p99_ms  evict/req
   312000       1.0     0.994        171          1701        0.0
   156000       2.0     0.765        426          3120        0.23
    78000       4.0     0.546        756          5258        0.45
    46800      6.67     0.354       1171          6996        0.65
```

→ **2× the models in the same VRAM at ~77% hit rate**, smooth cost curve.

**Live daemon** (`replay.py`): same overcommit, the real async server serves the
whole trace with **0 rejects and peak VRAM == budget** (`peak_ok: True`) — the
concurrency control never oversubscribes — while doing real wake/evict churn.

The tests pin both the policy (clean eviction, capacity bound, LRU victim,
pinned/reserved protection, Σmodels > budget served) and the runtime (concurrent
requests to a cold model trigger exactly one wake; 300 concurrent requests across
20 models never exceed the budget; a request whose only victim is pinned waits
and proceeds when it frees).

## Daemon concurrency model (pager.py)

- one asyncio lock **per model** serializes that model's transitions, so
  concurrent requests for a sleeping model trigger exactly one wake (and
  resident-in-manager implies physically loaded, since the admitter holds the
  lock across the whole wake);
- one global **transition** lock serializes the actual DMAs (sleep/wake share
  the PCIe link);
- a **condition var** guards the manager and lets an admission whose victims are
  all pinned wait for an in-flight request to unpin one;
- **inference holds only a pin**, so many requests to resident models run
  concurrently and the backend batches them.

## Simplifications (first cut; see MODEL-PAGING.md)

- **Eviction is pluggable** — `LRU`, or `CostAwareLRU` which protects
  slow-to-reload masters (`--policy cost`). The fuller cost-model placement
  (choosing load-from-tier vs evict vs migrate on admission) is still ahead.
- **One master tier** per run (default pinned host RAM); the manager supports
  per-model tiers — extend `make_models` for multi-tier / peer-VRAM studies.
- **Modeled latencies** in the sim / `MockBackend` (compressed by `speedup`).
  Calibrate against real hardware before trusting absolute numbers — the shapes
  are the result.
- Single GPU; decode assumed overlapped by continuous batching.

## Going live (GPU node)

1. **Calibrate**: `python3 backend.py <hf-model-id-or-path>` sleeps/wakes a real
   vLLM engine and prints wall-clock wake latency. Feed it into the
   `pinned_ram` tier bandwidth in `simulate.py` / `replay.py`.
2. **Serve**: in `replay.py`, swap `make_backend` to
   `VLLMBackend({name: path, ...}, tensor_parallel_size=..., gpu_memory_utilization=...)`.
   The pager drives it unchanged — `access`/`pin`/`unpin` ↔ `load`/`evict`/`infer`.

## Next steps toward production

- full cost-model placement (load-from-tier vs evict vs migrate on admission),
  building on the pluggable policy; master demotion across tiers; prefetch;
- per-tenant reserved floors wired to the controller's quota;
- an HTTP front end (FastAPI, available with vLLM) over `ModelPager.generate`;
- integration into the gVisor broker as the residency manager.
