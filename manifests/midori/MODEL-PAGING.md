# Model paging: weights as a clean VRAM cache (design note)

A design sketch for VRAM overcommit on the shared, gVisor-sliced GPU nodes.
Not built yet. Companion to the GPU-slicing broker (`runsc gpu-scheduler`,
`runsc-gpu-scheduler.service`) and the per-tenant memory limits the quota
webhook injects.

## The insight

Model weights are **read-only during inference** — never written after load. So
the VRAM copy is a *clean* copy of an authoritative master in host RAM. In pager
terms weights are clean, read-only, file-backed pages: **evicting one is free (no
writeback); only fault-in costs bandwidth.** That asymmetry is the whole scheme.
It reframes VRAM overcommit from a quota-accounting trick into **caching against
a real backing store**.

Scope: **weights only.** KV cache and activations are *dirty* (written every
step) — they can't be dropped for free, so they stay explicitly managed per
active model (vLLM PagedAttention), dropped-and-recomputed on eviction. Two
bins: weights = clean cache; KV = managed.

Granularity: **whole-model**, not sub-model. Whole-model eviction needs **no
hardware page faulting** — "fault in" is a scheduler reloading an idle model, not
a GPU MMU fault. Sub-model (evict half a model) would need UVM-style faulting and
buys the page-thrash problem; rejected. See `#alternatives`.

## Architecture — how it slots in

Four pieces; only the first two are new.

1. **Host-master store (new).** Each model's weights pinned (page-locked) in the
   owning sandbox's host RAM — the authoritative clean copy, for fast
   host→device DMA on fault-in. Per-tenant, inside the tenant's gVisor sandbox:
   no cross-tenant weight sharing, so isolation is preserved by construction.
   (Shared base weights / LoRA adapters could share a master later; out of scope
   here.)
2. **Residency manager (new, in the broker).** The `runsc gpu-scheduler` already
   tracks per-sandbox VRAM on each node. Extend it to track, per model, whether
   weights are **resident** or **sleeping**, plus a hot/idle signal, and to own
   the eviction policy. It is the *brain*; it does not touch GPU memory itself.
3. **Evict/reload executor = vLLM sleep/wake.** vLLM's `sleep(level=1)` already
   offloads weights to pinned host RAM and frees KV; `wake_up()` re-DMAs them
   back. That is exactly clean-cache evict/fault-in, per engine. The broker calls
   it; vLLM quiesces its own engine (you cannot yank VRAM from under a running
   engine, so cooperative beats a driver-level free). An engine with no
   sleep/wake path gets a cruder stop/reload.
4. **Request router (exists, gains a hook).** On a request for a sleeping model:
   enqueue, `wake_up()`, then dispatch. Latency added = reload time; hide it with
   prefetch (wake on a traffic uptick, keep a warm set).

```
request ─▶ router ─▶ model resident? ─yes─▶ serve
                           │no
                           ▼
                    broker.wake(M):
                      need VRAM? ─▶ pick idle victim(s) by policy ─▶ vLLM.sleep(V)
                      vLLM.wake_up(M)  (host-master ─DMA▶ VRAM)
                           ▼
                        serve (KV rebuilt on first steps)
```

## Model state machine (per model)

```
RESIDENT(active) ──idle timeout──▶ RESIDENT(idle) ──evict──▶ SLEEPING
      ▲                                                          │
      └───────────────── wake (DMA from host master) ◀──request──┘
```
Only `RESIDENT(idle)` models are eviction candidates. `active` (in-flight
requests) is pinned. `SLEEPING` holds weights in host RAM, zero VRAM, KV
discarded.

## Capacity accounting — the wall moves, it doesn't vanish

- **VRAM:** Σ(resident weights + their live KV) ≤ physical VRAM. This is what
  paging lets you *overcommit against* — the resident set is the hot models, not
  all models.
- **Pinned host RAM (the new wall):** Σ(all models' weights, resident + sleeping)
  ≤ host RAM. Cheaper and bigger than VRAM, but finite. Backing with mmap'd files
  instead of pinned RAM is cheaper still, at the cost of a disk→host→device miss.
- **Reload cost:** pure pinned-host→device DMA. ~28 GB (14B/fp16) ≈ 0.44 s over
  PCIe Gen5 (~64 GB/s), ~30 ms over NVLink-C2C (~900 GB/s). No disk, no
  safetensors re-parse — that's the payoff of keeping the master in host RAM.

Reframe the quota model accordingly: a tenant's GPU-memory quota becomes its
**max resident** (the VRAM guarantee), with a separate, larger **host-master
allowance** (how many models it may keep paged). Overcommit ratio = host
allowance / resident guarantee.

## Multi-tenant fairness & isolation (the midori-specific part)

- **No noisy-neighbour eviction.** A tenant must not be able to force-evict
  another tenant's hot model to degrade it (a latency-DoS). Policy: evict the
  requesting tenant's *own* idle models first; cross-tenant eviction only of
  genuinely idle models, and never below each tenant's reserved resident set.
  This is a scheduling-fairness property the broker must enforce, alongside the
  GPU-time weights it already enforces.
- **Isolation holds.** Each host master lives in its own sandbox's host memory;
  weights are re-DMA'd only from the tenant's own master. No cross-tenant weight
  buffers, no shared clean copy — consistent with the existing gVisor isolation
  model and the CNP tenant floor.
- **Interaction with the GPU-time broker.** Residency (who's in VRAM) and
  time-slice weight (who gets GPU cycles) are orthogonal but both live in the
  broker: a model must be resident *before* it can be scheduled, so wake is a
  precondition the time-scheduler waits on.

## What stays vs changes

| | |
| --- | --- |
| **Unchanged** | gVisor nvproxy/amdproxy, per-pod VRAM limit enforcement, the GPU-time scheduler, PagedAttention KV management, tenant isolation. |
| **Changes** | Quota semantics: `max VRAM` → `max resident` + `host-master allowance`. The broker gains a residency manager + eviction policy. |
| **New** | Host-master store (pinned per sandbox), vLLM sleep/wake wired to the broker, router fault-in hook + prefetch. |

## Prototype plan (prove it before touching the broker)

1. **Out-of-band residency manager** driving vLLM `sleep`/`wake_up` on one node,
   no gVisor changes. A multi-model trace (N tenants, Zipfian arrival) against a
   VRAM budget that fits only K<N models resident.
2. **Measure:** wake latency vs model size and link (PCIe vs NVLink-C2C);
   p50/p99 first-token latency on a cold vs warm model; throughput vs N/K;
   thrash behaviour as the hot set exceeds the budget; host-RAM headroom.
3. **Then** fold the policy into `runsc gpu-scheduler` and tie quota to
   resident+allowance.

## Open questions

- **Cold-start SLO:** is a ~0.4 s (PCIe) first-token tail acceptable for cold
  tenants, or do we need a guaranteed warm set per tier? Prefetch accuracy?
- **Eviction policy:** LRU + hysteresis + active-pin is the start; do we need
  per-tenant reservations / priority tiers to avoid starvation?
- **Host-master lifetime:** per-vLLM pinned (simple, isolated) vs a shared mmap
  store for identical base weights / LoRA (cheaper, needs careful isolation).
- **Who quiesces:** rely on vLLM sleep/wake, or can the broker free device
  buffers at the driver level for engines without it (and how to make that safe)?
- **KV on wake:** always recompute, or swap-and-restore for long contexts?

## Alternatives considered

- **NVIDIA UVM** (`cudaMallocManaged` + GPU faults): transparent, but a generic
  pager — writes back on evict unless hinted (`SetReadMostly`), page-granular
  faults, opaque LRU, thrashes when the working set exceeds VRAM. Shines on
  NVLink-C2C; risky over PCIe for this pattern. We get the clean-cache win
  explicitly, whole-model, without fault storms.
- **vLLM `cpu_offload_gb`:** streams weights per layer every forward pass —
  unconditional, zero hit rate. A cache with reuse beats it whenever a model
  stays hot.
- **Status quo (static pin, quota-only overcommit):** one model pinned per
  engine, no eviction; can't host more models than fit. This scheme is what lets
  Σmodels > VRAM.

## Prior art
- **PipeSwitch** (OSDI '20) — weights in pinned host memory, streamed in
  layer-by-layer overlapped with compute; millisecond model-switching on a shared
  GPU. Essentially this scheme; read first.
- **ServerlessLLM** (OSDI '24) — multi-tier fast model loading for cold starts.
- **vLLM sleep mode** — the per-engine evict/fault-in mechanism we'd drive.
