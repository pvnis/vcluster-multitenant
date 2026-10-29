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

1. **Host-master store (new), multi-tier.** The authoritative clean copy of each
   model's weights, held in the fastest tier with room: **pinned host RAM** (hot
   master, direct DMA) → **local NVMe** → **remote/object store** (cold). This is
   ServerlessLLM's hierarchy (OSDI '24): the colder tiers only hurt if the loader
   is slow, so store weights in a **loading-optimized format** (chunked,
   word-aligned, a name→offset index) and load with `O_DIRECT` + pinned buffers +
   parallel I/O threads, pipelined and overlapped with engine init — **not**
   `mmap` (page-fault stalls; ServerlessLLM measured 112K faults for a 7B model).
   Per-tenant, inside the tenant's gVisor sandbox: no cross-tenant weight sharing,
   so isolation holds by construction. (Shared base weights / LoRA could share a
   master later; out of scope.)
2. **Residency manager (new, in the broker).** The `runsc gpu-scheduler` already
   tracks per-sandbox VRAM on each node. Extend it to track, per model, **which
   tier** holds its weights (VRAM / pinned RAM / NVMe / remote) and a hot/idle
   signal, and to own a **cost-model placement policy**, not just LRU: on a miss
   it estimates *time to make M resident here* — load-from-tier (ServerlessLLM's
   `q + n/b`: queue + size/bandwidth) vs evict an idle victim vs **migrate** a
   running inference off this GPU — and picks the minimum, subject to per-tenant
   reserved resident sets. It is the *brain*; it never touches GPU memory itself.
   (This is ServerlessLLM's scheduler, scoped to one node's VRAM.)
3. **Evict/reload executor = vLLM sleep/wake.** vLLM's `sleep(level=1)` already
   offloads weights to pinned host RAM and frees KV; `wake_up()` re-DMAs them
   back. That is exactly clean-cache evict/fault-in, per engine. The broker calls
   it; vLLM quiesces its own engine (you cannot yank VRAM from under a running
   engine, so cooperative beats a driver-level free). An engine with no
   sleep/wake path gets a cruder stop/reload. PipeSwitch (OSDI '20, Table 1)
   measured the dominant switch cost as CUDA-context + process init (5.5–7.3 s),
   *not* the weight transfer — so keeping the engine and its CUDA context warm
   and moving only weights is the right mechanism; a from-scratch reload pays
   that multi-second tax on every fault.
4. **Request router (exists, gains a hook).** On a request for a sleeping model:
   enqueue, `wake_up()`, then dispatch. Latency added = reload time; hide it two
   ways: **prefetch** (wake on a traffic uptick, keep a warm set) and **pipelined
   streaming** — DMA the weights in PipeSwitch-style layer groups overlapped with
   the first forward pass, instead of blocking on the whole transfer before any
   compute.

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
- **Host tiers (the new wall), not a single number.** Σ(weights kept warm in
  pinned RAM) ≤ host RAM; colder models spill to NVMe, then remote. The wall is
  *per tier*, and a miss's cost is which tier the master sits in — so the
  eviction/placement policy reasons about tiers, not a binary resident/sleeping
  (ServerlessLLM's `q + n/b` per-tier load-time model).
- **Reload cost:** pure pinned-host→device DMA. ~28 GB (14B/fp16) ≈ 0.44 s over
  PCIe Gen5 (~64 GB/s), ~30 ms over NVLink-C2C (~900 GB/s). No disk, no
  safetensors re-parse — that's the payoff of keeping the master in host RAM.
- **The LLM regime inverts PipeSwitch.** Its CNNs were ~240 MB, so the weight
  transfer (~80 ms) was negligible against the 5–7 s init, and it pipelined
  mostly for latency polish. Our weights are 10–100+ GB, so transfer is
  **seconds** and becomes the dominant fault cost. That makes PipeSwitch's
  pipelined, layer-grouped streaming *essential* on the fault-in path, not
  optional — and reframes vLLM's `cpu_offload_gb` as exactly that streaming half,
  just without the residency cache in front of it.

Reframe the quota model accordingly: a tenant's GPU-memory quota becomes its
**max resident** (the VRAM guarantee), with a separate, larger **host-master
allowance** (how many models it may keep paged). Overcommit ratio = host
allowance / resident guarantee.

## Topology adaptation — degrades to PCIe, improves with the fabric

The scheme bets on fault-in bandwidth, which the interconnect sets. It absorbs
that because it is already a **multi-tier store + cost-model policy** keyed on
each link's `(bandwidth, latency, capacity, scope)`. Topology doesn't change the
*mechanism*; it reparameterizes the tiers and picks whether a fault-in is a
**copy** or a **coherent no-copy**. So the residency manager must be
**topology-aware**: read the node/domain interconnect map (the same one HAMi's
`devicepairscore` now produces — see `README.md` step 6, NVLink topology
scores), order tiers by *measured* BW/latency, and per link choose the fault
mechanism.

Tiers, by example hardware (order by measured BW, not this list):

| tier | link | ~BW | fault mechanism | scope |
| --- | --- | --- | --- | --- |
| peer VRAM | NVLink / Infinity Fabric / SUP | 0.9–1.8 TB/s | copy (or direct access) | node / rack domain |
| coherent host | NVLink-C2C / unified HBM (MI300A) | ~0.9 TB/s | **no-copy, HW migrate** | node |
| CXL pool | CXL.mem | ~64 GB/s | no-copy (HBM caches it) | node / cluster |
| pinned host DRAM | PCIe Gen4/5 | 32–64 GB/s | copy (DMA) | node |
| remote mem / VRAM | RDMA 400/800G, NDR IB | 50–100 GB/s | copy (GPUDirect) | cluster |
| NVMe / object | PCIe / network | 2–12 GB/s / less | copy | node / cluster |

Three regimes:

1. **PCIe-only — the floor the first cut targets.** 32–64 GB/s; a 28 GB model is
   ~0.4–0.9 s and the transfer dominates. Earn it with a big resident set,
   prefetch, pipelined layer-grouped streaming, and an accepted cold tail.
   Fault-in = explicit DMA from pinned host RAM. Everything below relaxes this.
2. **Coherent CPU↔GPU — the inversion (Grace/C2C, MI300A, CXL.mem).** ~900 GB/s
   coherent links and large coherent host memory. Two shifts: fault-in is ~14×
   cheaper *and* you can stop copying — let HBM be a hardware cache of the
   coherent host/CXL master, the GPU's migration engine faulting pages on access.
   Here the note's rejection of UVM / page-granular / sub-model paging
   **reverses**: HW-managed migration (UVM + `ReadMostly`) is the right mechanism
   and overcommit becomes cheap and fine-grained; the manager sets residency
   hints instead of copying whole models.
3. **GPU↔GPU fabric & scale-up — pooled VRAM (NVLink/NVSwitch, IF, UALink,
   NVL72).** Other GPUs' HBM becomes a fast tier; evict to a peer at fabric speed,
   not PCIe. "Resident" widens from per-GPU → per-node pool → per-rack domain, and
   the manager runs at domain scope. Cross-GPU rebalancing is cheap — and this is
   where the temporal axis **converges with AlpaServe's spatial one** (on a fast
   uniform fabric, "move the model" and "split it across GPUs" are the same cheap
   op). Fast RDMA / CXL pooling extends this *across nodes*: store each master
   once in a memory server or CXL pool, GPUDirect it into HBM on a miss —
   ServerlessLLM's cross-node tier at RDMA speed.

**Invariant.** Clean-cache semantics, whole-model default, vLLM sleep/wake, and
the cost-model placement policy are unchanged across all of this; only the tier
parameters and the per-link copy-vs-coherent choice vary.

midori today:
- **A6000 (`midori-nv-0/1`)** — PCIe host path + a *weak* NVLink bridge (NV4,
  ~49 GiB/s D2D within a pair; the paired GPU's VRAM is itself scarce). Regime 1:
  bandwidth-starved — lean on prefetch + resident-set sizing.
- **B300** — NVSwitch ~1.8 TB/s, ~275 GB HBM/GPU. Regime 3, the strong case: a
  big pooled-VRAM tier makes paging cheap and attractive.
- **Future Grace / MI300 / CXL** — regime 2, where we'd stop copying and let
  coherent hardware page.

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
  model and the CNP tenant floor. One caveat borrowed from PipeSwitch: its
  task-cleaning frees only pointers, not the bytes, so a successor task could read
  the prior model's VRAM. gVisor sandbox isolation contains that here, but any
  device buffer freed on eviction and later handed to a *different* tenant must be
  zeroed first (sub-millisecond at GPU bandwidth — ~240 MB in their example).
- **Interaction with the GPU-time broker.** Residency (who's in VRAM) and
  time-slice weight (who gets GPU cycles) are orthogonal but both live in the
  broker: a model must be resident *before* it can be scheduled, so wake is a
  precondition the time-scheduler waits on.
- **Cross-node rebalancing (optional, fleet-level).** A hot node can shed load by
  *migrating* a tenant's inference to another node — ship the tokens (10–100 KB)
  and **recompute** KV at the destination (ServerlessLLM: ~10× cheaper than moving
  the 1–10 GB KV; recomputing 1000 tokens ≈ generating ~100). Orthogonal to
  within-node eviction; a lever the broker gains once it spans nodes.

## What stays vs changes

| | |
| --- | --- |
| **Unchanged** | gVisor nvproxy/amdproxy, per-pod VRAM limit enforcement, the GPU-time scheduler, PagedAttention KV management, tenant isolation. |
| **Changes** | Quota semantics: `max VRAM` → `max resident` + `host-master allowance`. The broker gains a residency manager + eviction policy. |
| **New** | Multi-tier host-master store (pinned RAM → NVMe → remote, per sandbox), vLLM sleep/wake wired to the broker, router fault-in hook + prefetch/pipelined streaming. |

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
- **Eviction/placement policy:** cost-model (load-from-tier vs evict vs migrate)
  over plain LRU — how accurate must the cost estimates be, and do we need
  per-tenant reserved resident sets / priority tiers to avoid starvation?
- **Host-master lifetime & tiering:** per-tenant tiered masters (simple,
  isolated) vs a shared store for identical base weights / LoRA (cheaper, needs
  careful cross-tenant isolation). Which tiers per node — RAM-only, or RAM+NVMe?
- **Who quiesces:** rely on vLLM sleep/wake, or can the broker free device
  buffers at the driver level for engines without it (and how to make that safe)?
- **KV on wake:** default to **recompute from tokens** — ServerlessLLM and vLLM
  show it's ~10× cheaper than moving KV. Open only for very long contexts, where
  swap-and-restore of the KV may still win.
- **Topology map source:** reuse HAMi's `devicepairscore`/NVML for the
  interconnect graph and per-link bandwidths, or probe them directly at broker
  start? And on coherent fabrics, where's the copy-vs-let-hardware-migrate line?

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

## Scope boundary: paging vs. model-parallel multiplexing

Two orthogonal ways to share GPUs across many models:
- **Temporal** (this note) — page models in/out of VRAM over time; attacks the
  *memory* limit (Σmodels > VRAM).
- **Spatial** (AlpaServe, OSDI '23) — keep all models resident but split them
  across GPUs via model parallelism, so a burst to one model borrows idle GPUs;
  attacks *burst latency*, and assumes everything already fits.

**Decision (first cut): pursue temporal paging; defer model-parallel
multiplexing.** Our bottleneck on sliced nodes is memory capacity (many idle
tenants, Σ > VRAM), which is paging's regime — AlpaServe explicitly assumes all
models fit and does no swapping. The two could compose later
(model-parallel-colocate the *resident* hot set for burst tolerance), but that
pins a model across several GPUs, enlarging its footprint and making clean
whole-model eviction coarser — a second-phase question, not now.

## Prior art
- **PipeSwitch** (OSDI '20) — the mechanism this builds on. Weights in pinned
  host memory (a shared *memory daemon*, model stored once), streamed to the GPU
  in model-aware layer groups overlapped with compute, and *active-standby*
  workers that keep a CUDA context warm. Switch overhead **5.4–34.6 ms**, 10–50×
  better than NVIDIA MPS, ~100% utilization (ResNet-152/Inception/BERT, V100/T4).
  It is a *context switch* between a small active set (one model + two standbys),
  not a *cache*; our scheme adds pressure-driven eviction and a hit/miss rate on
  top (the ServerlessLLM direction).
- **ServerlessLLM** (OSDI '24) — the storage/cluster substrate this would feed.
  Multi-tier near-GPU checkpoint cache (DRAM→NVMe→remote) with a loading-optimized
  format + `O_DIRECT`/pinned/pipelined loader (3.6–8.2× vs PyTorch/Safetensors),
  live migration by token-replay + KV recompute, and a startup-time cost-model
  scheduler. 10–200× lower cold-start latency than KServe/Ray Serve. It does
  cold-start-from-storage and cross-node scheduling, *not* within-GPU clean-cache
  overcommit — the two compose.
- **AlpaServe** (OSDI '23) — the orthogonal *spatial* axis: statistical
  multiplexing via model parallelism (split resident models across GPUs for burst
  tolerance), assuming all models fit in VRAM, no swapping. 10× rate / 6×
  burstiness / 2.5× tighter SLO. Deferred — see Scope boundary.
- **vLLM sleep mode** — the per-engine evict/fault-in mechanism we'd drive.
