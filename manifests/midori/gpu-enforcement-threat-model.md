# GPU slicing: enforcement boundaries & threat model

What the GPU **command-submission path** means for what midori's slicing can and
cannot enforce, and where the real trust boundary actually sits.

Prompted by Maxime Peim's **"Rebuilding CUDA From Scratch"** series (6 parts, *AI
Infrastructure*, Medium, 2026), which rebuilds NVIDIA Hopper (H100) command
submission from scratch against the open `nvidia.ko`/`nvidia-uvm.ko` driver. It is,
in effect, a measured study of exactly the boundary our `nvproxy` enforcement sits
near.

## The core fact

**GPU command submission bypasses the kernel.** The author measures 12 `cudaMemcpy`
(3 GiB moved) and counts, during the copies themselves: **0 RM ioctls, 0 UVM ioctls,
0 GSP RPCs** — only doorbell writes ("*Zero ioctls. Zero RPCs. Zero kernel entries…
the kernel does not know the copies happened.*"). A submission is:

- a userspace **MMIO doorbell store** — a plain `*(volatile u32*)doorbell = token`
  into a BAR window (`HOPPER_USERMODE_A`, offset `+0x90`) the driver mapped into the
  process at setup; plus
- **shared-memory ring writes** — pushbuffer (host DRAM), GPFIFO ring + `GPPut`/
  `GPGet` indices + `USERD` (HBM via a BAR1 alias), ordered with `sfence`.

Part 6 goes further: an **SM thread rings a doorbell itself** (`STG.E.STRONG.SYS` to
the GPU-side mapping of the aperture), submitting Copy-Engine work with **no CPU
instruction** — and, being "internal MMIO," possibly **no PCIe transaction** a host
monitor could even see.

**Therefore:** our `nvproxy` (the gVisor **ioctl boundary**) sees **setup** —
allocations, channel/object creation, the doorbell-aperture mapping
(`NV_ESC_RM_MAP_MEMORY_DMA` of `HOPPER_USERMODE_A`) — but **none of the per-submission
stream**. (Note: libcuda issues `open`/`mmap` of `/dev/nvidia0` via a *raw* syscall,
defeating `LD_PRELOAD` shims — but **not** a kernel syscall-trap like gVisor, which
still sees the syscall at setup.)

## What it means for each enforcement

### 1. Memory limits — sound by construction ✅
midori caps VRAM at the **allocation ioctls** (`nvproxy` refusing
`NV01_MEMORY_LOCAL_USER` over the per-sandbox limit;
`--nvproxy-gpu-memory-limit[-per-device]`). Allocations cross the ioctl boundary;
there is **no allocation without the ioctl `nvproxy` gates**, so no doorbell or
self-ring trick bypasses the cap. The series is independent proof this design is in
the right place.

### 2. Compute / time limits — correctly placed ✅
We enforce weighted time-slicing in the **driver broker + GHOST fork**
(`runsc gpu-scheduler`: `SET_TIMESLICE`, runlist control, TPC partitioning), which
meters **channel execution time at the runlist**, *independent of how work was
submitted*. A tenant flooding its own rings — by CPU doorbell **or** Part-6 SM
self-ring — still gets only its weighted slice. The series' implicit warning is that
**you cannot gate compute by watching submissions at the ioctl boundary** (the author
can't even catch the self-ring with a CPU hardware watchpoint); our runlist-based
choice sidesteps that entirely.
→ **Verify:** enforcement is execution-time-metered, not submission-counted.

### 3. Cross-tenant isolation — the real trust boundary, and it is GPU-side ⚠️
Software slicing shares **one physical GPU among untrusted tenants**. Every tenant
runs arbitrary CUDA/SASS and, as the series shows, operates largely **below the
driver's visibility** (authoring commands, ringing doorbells, submitting from an SM).
So cross-tenant security rests on:

- **`nvproxy` scoping each sandbox's channels / VA space / doorbell apertures** so
  tenant A can never *map or address* tenant B's doorbell or memory; and
- **the GPU MMU**, which faults any out-of-VA-space access (Xid 31). Direct
  cross-tenant memory/doorbell access is **hardware-blocked by the MMU** — that holds.

What software slicing does **not** give you, that MIG does: isolation of **SMs,
caches, copy engines, and the scheduler**. So there is **side-channel and
performance-interference exposure**, and a **large trusted surface** (the entire
driver/GSP command path the series spends six parts mapping).

**Posture:** between tenants, *memory* isolation is MMU-hardware-enforced and sound;
*engine / side-channel* isolation is **absent** under software slicing. For untrusted
tenants that need hardware isolation, the answer is **MIG or a dedicated GPU** — which
is where this meets NVIDIA's own line (MIG = hardware isolation for untrusted;
time-slicing/MPS = trusted co-tenancy). This series is the deep "why": everything
below the driver is tenant-controllable and invisible to the host.

## The doorbell trap (Part 4) — optional observability, not enforcement
The author's shadow-RAM-diversion + x86 `DR0–DR3` watchpoint catches **every
CPU-side submission at full bandwidth** (174/174, no slowdown). We could borrow it
for **per-submission auditing / forensics**. Limits: it **misses the GPU self-ring**
(Part 6 — wrong side of the bus), burns scarce debug registers (contended with other
tooling), and is per-CPU-thread. File under telemetry, not enforcement.

## AMD path mirrors this
The series is Hopper-specific, but AMDKFD **user-mode queues + doorbells** bypass the
kernel after setup the same way. `amdproxy` conclusions are identical: memory at
allocation, compute at the scheduler/CU level via the broker, cross-tenant via the
AMD GPU MMU, same no-engine-isolation caveat.

## Action items
- [ ] **Audit** that `nvproxy` scopes the doorbell/`USERMODE` apertures and channel
  VA spaces strictly per-sandbox (no cross-map) — the Part-6 "ring another channel"
  concern; blocked by the MMU only if we never cross-map.
- [ ] **Confirm** compute enforcement is execution-time-metered at the runlist
  (robust to submission flooding), not submission-counted.
- [ ] Keep this posture documented; offer a **MIG / dedicated-GPU tier** for untrusted
  tenants that need hardware (engine + side-channel) isolation.

## Source
Maxime Peim, "Rebuilding CUDA From Scratch," Parts 1–6, *AI Infrastructure*
(Medium), 2026. Cites Y. Yan et al. (2026), "Revealing NVIDIA Closed-Source Driver
Command Streams for CPU-GPU Runtime Behavior Insight." Code:
`maxime-peim/libcuda-research`, `maxime-peim/libmc`.
