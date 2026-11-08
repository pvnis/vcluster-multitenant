# GPU slice scaling: density ceiling and GHOST-scheduling overhead

Two measurements on **one RTX A6000 (midori-nv-1)** under gVisor + HAMi + the
`runsc-gpu-scheduler` (GHOST) broker: (1) how many slices fit on a card, and
(2) what the broker's time-slicing costs as the slice count grows. Run
2026-11-07. Manifests: `overhead-bench.yaml`, `collect-overhead.sh`,
`slice-density.yaml`.

## Setup

- **Node:** midori-nv-1, 2× A6000 (46068 MiB each), 16 vCPU / 64 GiB VM.
  Drained + tainted `slice-test:NoSchedule` so the test owns it; all slices
  pinned to ONE physical GPU via `nvidia.com/use-gpuuuid`.
- **HAMi:** `devicesplitcount` raised 10 → 128 on nv-1 (advertises 256) so more
  than 10 slices/GPU can schedule. Each slice goes through `hami-scheduler`
  (never `nodeName` — HAMi's webhook rejects a pre-assigned node).
- **Overhead workload:** `pytorch:2.10-cuda13`, a sustained fp16 cuBLAS matmul
  loop (M=4096, tensor cores — compute-bound), **equal weight** (`gpucores: 1`)
  so we measure pure overhead, printing TFLOPS over ≥2 s windows.
  `R(N)` = Σ per-slice TFLOPS; `overhead(N) = 1 − R(N)/R(1)`. Broker load =
  `rate(gpusched_cmds_ok_total)` on nv-1.

## Density — how many slices fit (host-bound, not table-bound)

- **slice-density probe** (idle kernel): ceiling **36 slices at `cpu:250m`**,
  Pending reason `Insufficient cpu` — **host-CPU-bound**, not GPU.
- With less CPU per slice, **VRAM binds**: each CUDA context needs ~700–950 MiB
  of real VRAM (context ~600–800 + buffers), so **~45 slices/GPU** at
  `gpumem:950` (45 of 48 fit; 3 couldn't).
- **The 256-entry broker group table (`g_ghostGroups[256]`, node-wide) was never
  approached** — `table_full` stayed 0 through every run. At ≤45 contexts
  (~4–5 group slots each) it has ~5× headroom. **On an A6000 the table is not
  the constraint; host CPU/VRAM is.**

## Overhead — what time-slicing costs vs. slice count

| N (running) | R(N) TFLOPS | overhead | per-slice | % fair share | broker cmds/s |
| --- | --- | --- | --- | --- | --- |
| 1  | 106.2 | —    | 106.2 | —   | 2  |
| 2  | 102.3 | 3.7% | 51.1  | 96% | 2  |
| 4  | 101.9 | 4.0% | 25.5  | 96% | –* |
| 8  | 101.4 | 4.5% | 12.7  | 96% | 8  |
| 16 | 101.6 | 4.3% | 6.3   | 95% | 34 |
| 24 | 100.3 | 5.6% | 4.2   | 95% | 51 |
| 32 | 98–99.6 | ~7% | 3.1 | 93% | 68 |
| ~45 ("48") | 99.3 | 6.5% | 2.2 | 94% | 96 |

\* the N=4 broker sample (45.8) was a scale-up transient; ignore.

**Findings**
1. **Flat ~4% through 16 slices** — aggregate throughput holds ~101–102 TFLOPS;
   the tax is independent of N in this range.
2. **Ramp then plateau** — 4.3% (16) → 5.6% (24) → ~7% (32), then **flat at ~7%
   through 45** (the per-GPU ceiling). The tax rises once past ~16 and then
   **saturates** — it does not keep climbing with density, and it never exceeds
   ~7% even at max slices.
3. **Fair** — each slice gets ≥93% of its ideal `R(1)/N`; the tax is spread
   evenly (equal weights → equal slices).
4. **Broker control cost is linear in N** — ~2 cmds/s per slice (8→34→51→68→96
   for 8→16→24→32→45), even while the throughput tax saturates.
5. **Per-GPU ceiling ~45 slices** on an A6000 (VRAM/context floor ~950 MiB/slice).

## Measurement limits (read before trusting high-N)

- **High-N needs a long collection window.** The Σ-per-slice-TFLOPS method sums
  per-slice windows read sequentially; a short (30 s / 10-sample) collection
  summed non-contemporaneous windows and at ~45 contexts over-counted — R read
  **98.4 and 111.3** on two tries (111.3 is impossible on one GPU). A **60 s /
  15-sample median** resolved it (R≈99.3 at 45, stable and physical), so the
  high-N points here are clean. Watch for this when sampling many bursty slices.
- **Compute-bound, big-kernel favorable** (M=4096 → long time-slices, few
  switches). Launch-heavy or latency-sensitive workloads would show more.
- The ~4–8% **bundles the broker time-slicing and the gVisor/nvproxy path**; no
  broker-off control was run to separate them.
- Single A6000, single GPU, fp16.

## Implications for the "100 slices" target

- **Scheduling overhead saturates, it does not explode** — flat ~4% to 16, ramps
  to ~7% by 32, then **plateaus at ~7% through the ~45-slice ceiling**. Even at
  max density on an A6000 you pay only ~7%. The scheduler is not the barrier.
- **The barrier is host resources:** ~45 slices/GPU on an A6000 (VRAM), fewer if
  CPU-starved. **100 slices needs big-VRAM cards (B300-class) and fatter hosts**,
  where the tax would be proportionally larger but still bounded.
- **Practical sweet spot on current hardware: a few dozen slices at single-digit
  % overhead.**
