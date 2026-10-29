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
   `MockBackend`; `replay.py` fires a trace at it live.
3. **The real serving path** (`serve.py`) — a paging-aware **OpenAI proxy** over
   per-model **vLLM** servers, wakes/sleeps them via vLLM's admin endpoints, and
   is driven by stock **`vllm bench serve`** (`benchctl.py`). See the GPU recipe
   below.

## Files

| file | what |
| --- | --- |
| `residency.py` | policy brain. Multi-tier masters, clean-cache (evict = free, no writeback), whole-model, pluggable policy (`LRU`; `CostAwareLRU` protects slow-to-reload masters; `FrequencyCost` is the admission cost model — frequency+refault-cost, scan-resistant) with fairness (own-idle-first; never below a tenant's reserved floor), pinned-never-evicted. `admit()` is atomic: it plans + applies all evictions and returns the victims, or raises `CapacityError` having changed nothing. |
| `workload.py` | N models across tenants, Zipfian popularity, bursty (Gamma/CV) arrivals. |
| `simulate.py` | analytic single-GPU sim + metrics + budget sweep. |
| `backend.py` | async engine backends: `MockBackend` (no GPU; tracks physical VRAM so tests can assert no oversubscription) and `VLLMBackend` (real vLLM sleep/wake, GPU-only) + `measure_wake()`. |
| `pager.py` | **ModelPager** — the online daemon: per-model transition locks, a global DMA-serializing lock, and a condition var so an admission whose victims are all pinned waits for an unpin. Inference holds only a pin, so resident models serve concurrently. |
| `replay.py` | drives a trace at the live pager at (compressed) real time; reports hit rate, wakes/evicts, peak VRAM vs budget, setup latency. |
| `serve.py` | **the real serving path** — a paging-aware OpenAI proxy over per-model vLLM servers (`ServerBackend` wakes/sleeps them via vLLM's `/wake_up` `/sleep` admin endpoints; streaming forwarded through). Driven by stock `vllm bench serve`. |
| `benchctl.py` | launches one `vllm bench serve` per model with Zipfian rates against the proxy, for a realistic multi-model load. |
| `models.example.json` | sample proxy config (name, url, size_mib, tenant). |
| `test_residency.py` | 14 policy unit tests. |
| `test_pager.py` | 6 async concurrency tests. |
| `test_serve.py` | 4 proxy integration tests (routing, wake/sleep on miss, no forward-to-sleeping under load, 404/503) with injected fakes — no GPU. |

## Run

```bash
python3 -m unittest             # all 24 tests (stdlib only, no GPU)
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

- **Policy is pluggable** — `LRU`; `CostAwareLRU` (`--policy cost`) protects
  slow-to-reload masters; `FrequencyCost` (`--policy freq`) is the admission cost
  model (frequency × refault cost; scan-resistant). On a single node the design's
  "load-from-tier vs evict vs migrate" collapses — migrate across nodes is the
  remaining piece.
- **One master tier** per run (default pinned host RAM); the manager supports
  per-model tiers — extend `make_models` for multi-tier / peer-VRAM studies.
- **Modeled latencies** in the sim / `MockBackend` (compressed by `speedup`).
  Calibrate against real hardware before trusting absolute numbers — the shapes
  are the result.
- Single GPU; decode assumed overlapped by continuous batching.

## Real vLLM + vllm-bench (GPU node)

The real serving path is `serve.py`: a paging-aware OpenAI proxy over per-model
vLLM servers, driven by the standard `vllm bench serve`. Each model is a normal
vLLM server (so batching + streaming are vLLM's); the proxy wakes/sleeps them
via the dev-mode admin endpoints as load shifts, overcommitting VRAM.

1. **Launch one vLLM server per model with sleep mode.** Size
   `--gpu-memory-utilization` so the *resident set* fits — if the budget holds 2
   models awake on an 80 GB GPU, give each ~0.45:
   ```bash
   VLLM_SERVER_DEV_MODE=1 vllm serve <path-a> --port 8101 --enable-sleep-mode --gpu-memory-utilization 0.45
   VLLM_SERVER_DEV_MODE=1 vllm serve <path-b> --port 8102 --enable-sleep-mode --gpu-memory-utilization 0.45
   # put the cold ones to sleep so VRAM starts free:
   curl -X POST localhost:8102/sleep?level=1
   ```
2. **Describe them** in a config (see `models.example.json`): `name, url,
   size_mib, tenant`.
3. **Start the proxy:**
   ```bash
   python3 serve.py --config models.json --budget <MiB> --policy cost --port 8000
   ```
   `--budget` is the VRAM the awake set may use (Σ resident `size_mib` ≤ it).
4. **Drive load across all models** with vllm-bench:
   ```bash
   python3 benchctl.py --config models.json --base-url http://127.0.0.1:8000 \
       --total-rate 20 --num-prompts 1500
   ```
   (one `vllm bench serve` per model, Zipfian rates; results in `bench-*.json`.)

**Calibrate** the simulator's tier bandwidths from real hardware with
`python3 backend.py <model>` (wall-clock wake latency), then the `simulate.py`
curves predict what the proxy does.

Caveats: the `/sleep` `/wake_up` endpoints and flags follow vLLM's dev-mode
[sleep docs](https://docs.vllm.ai/en/latest/features/sleep_mode/) — confirm for
your version. First wake of a never-slept server is a normal cold start;
thereafter level-1 wake is a weight DMA from CPU RAM.

## Next steps toward production

- cross-node placement/migration (the multi-node half of the cost model);
  master demotion across tiers; prefetch;
- per-tenant reserved floors wired to the controller's quota;
- integration into the gVisor broker as the residency manager;
- a first real GPU run: launch the per-model vLLM servers and `benchctl.py`,
  and compare measured hit-rate/latency to the `simulate.py` prediction.
