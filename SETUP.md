# Full-stack setup: two-vendor GPU slicing under gVisor

How to stand up the **entire stack** that divides a single GPU among
mutually-untrusting containers — NVIDIA (`nvproxy`) and AMD (`amdproxy`) — with
every limit enforced in the gVisor Sentry or a trusted host component, never
inside the container. This is the reference recipe for the two-node cluster
(`sensai` = NVIDIA, `sens1` = AMD, one k3s control plane). A single-vendor setup
is a strict subset: build the same gVisor, skip the other vendor's
driver/plugin, and follow the matching column.

For **why** the stack is shaped this way (the governing constraint, the four
layers, the space-vs-time mechanisms), read `../gvisor/GPU-ISOLATION.md` first.
This document is the *how*.

> **What is trusted vs. what enforces.** Only two layers enforce isolation
> against a hostile tenant: **gVisor** (the Sentry) and, for NVIDIA compute, the
> **driver broker**. The cluster scheduler (HAMi), the device plugins, the
> webhook, and vCluster are *trusted placement/translation* — they decide where a
> pod runs and what quota it carries, but a tenant that evades them still hits the
> Sentry's cap. This is why the webhook's `failurePolicy: Fail` is a security
> property, not an availability one.

---

## 1. Components and repositories

Every fork is under `github.com/pvnis`; clone the fork, not upstream.

| Component | Repo / source | Branch | What it provides |
| --- | --- | --- | --- |
| **Modified gVisor** | `pvnis/gvisor` | `gpuslicing` | `runsc` with `nvproxy`, `amdproxy`, `pkg/gpusched`, the `runsc gpu-scheduler` daemon, and the in-tree `webhook/`. The core. |
| **NVIDIA open driver fork** | `pvnis/open-gpu-kernel-modules` | `gpuslicing` | The driver broker: `/proc/driver/nvidia/gpusched` (runlist detach/attach + per-TSG timeslice + `RESTART_RUNLIST` + the per-tenant `tsgs` report) and per-tenant UVM eviction. Required for NVIDIA *compute* isolation; not needed for memory quota alone. See `../open-gpu-kernel-modules/DRIVER-CHANGES.md`. |
| **HAMi** | **upstream `projecthami/hami:v2.9.0`** (unmodified) | — | `hami-scheduler` (placement) + `hami-device-plugin` (advertises `nvidia.com/gpu`) + `hami-webhook`. Runs the whole NVIDIA path and the AMD *time-slicing* path unmodified. |
| **HAMi fork** *(AMD spatial only)* | `pvnis/HAMi` | `gvisor-amd-timeslice` | Adds automatic **disjoint AMD CU-mask** assignment (`pkg/device/amd/cualloc.go`, `cusForRequest`). The *only* reason to run the fork instead of upstream; needed only if you use AMD spatial partitioning. It emits a weight **or** a mask, never both. |
| **Quota webhook** | in-tree: `pvnis/gvisor` → `webhook/pkg/gpushare` | `gpuslicing` | Mutating admission webhook that restates a pod's GPU request — **both vendors** — as `dev.gvisor.flag.*` annotations (narrow-only). No separate repo. (The standalone `gpu-quota-webhook` is retired.) |
| **AMD device plugin** *(AMD node only)* | `ROCm/k8s-device-plugin` fork at `~/amdgpu-device-plugin` | `master` | Advertises `amd.com/gpu-vram-mib`. Topology treats VRAM `heap_type` 1 and 2 alike (needed for RDNA). Its `Allocate()` env is **not** used for enforcement — gVisor reads annotations. |
| **Cluster config / vCluster** | this repo (`vcluster-multitenant`) | — | k3s config, Cilium values, containerd drop-ins, vCluster tenant values + network policies. `TWO-VENDOR-CLUSTER.md` + `CILIUM-DESIGN.md` are the cluster runbooks; `README.md` is the tenancy deep-dive. |

Third-party, installed as-is: **k3s** v1.36.2 (pin agent ≤ server), **Cilium**
(Helm, VXLAN, `kubeProxyReplacement`), **vCluster**, **containerd** (k3s-bundled),
**Tailscale** (the only path between the NAT'd nodes).

> **On HAMi and AMD:** upstream HAMi's `resourceCountName` is `amd.com/gpu`, which
> the AMD plugin here does not advertise, so on upstream HAMi does *no*
> HAMi-level accounting for AMD — ordinary Kubernetes extended-resource
> accounting refuses oversubscription of `amd.com/gpu-vram-mib`, and the Sentry
> enforces the real per-pod limit. HAMi is effectively vestigial for AMD; keep it
> for NVIDIA and for uniform placement. (To make HAMi actually account AMD, the
> device plugin would have to advertise `amd.com/gpu` too — a plugin change.)

---

## 2. Reference topology and node prerequisites

| | sensai (NVIDIA) | sens1 (AMD) |
| --- | --- | --- |
| Role | k3s **control plane** | k3s **agent** |
| OS / kernel | Ubuntu 22.04, 6.8.x | Ubuntu 24.04, **7.0.0-28+** (KVM device-memory fix needs ≥ 6.13) |
| GPU | RTX 5070, driver **610.43.02**, 12 GiB | Navi 32 (gfx1101), 54 CUs, 12 GiB; **ROCm 7.2** |
| gVisor platform | `systrap` (or `kvm`) | **`kvm`** (required) |
| container runtime | containerd only (no docker) | docker + containerd |
| default GPU scheduler | `hami-scheduler` | `hami-scheduler` (or `default-scheduler`) |

**Why AMD requires `--platform=kvm`.** `/dev/kfd` binds each mapping to the
process holding the KFD context; systrap maps from a stub process, so the mapping
`mmap` returns `EINVAL`. Only KVM presents the Sentry as the mapping process. On
kernels **< 6.13**, KVM also has a device-memory bug (tail pages of a compound
amdgpu allocation `SIGBUS`); sens1 runs 7.0.0-28 to avoid it. See
`../gvisor/UPSTREAM-NOTES.md`.

---

## 3. k3s cluster + Cilium

Full runbook: `TWO-VENDOR-CLUSTER.md` and `CILIUM-DESIGN.md`. Load-bearing points:

- **Both nodes use their Tailscale address as `node-ip`.** sensai is NAT'd and
  unreachable from sens1 over LAN; Cilium's VXLAN tunnel needs two-way
  reachability. Do not "fix" a node IP back to a LAN address. The apiserver cert
  needs the Tailscale IP in `tls-san`; Cilium's `k8sServiceHost` must be the
  Tailscale IP too.
- **Label the nodes:** `gpu.vendor=nvidia,gpu=on` on sensai; `gpu.vendor=amd` on
  sens1. Device plugins and node-scoped scheduling key on these.
- **CNI paths (agent node).** With `flannel-backend: none`, k3s omits the
  containerd CNI block and the node stays `NotReady` with `cni plugin not
  initialized` while Cilium is healthy. The `10-runsc.toml` drop-in (Part 5)
  points containerd at the k3s CNI paths.

Config files: `manifests/twovendor/sensai-k3s-config.yaml`,
`sens1-k3s-config.yaml`.

---

## 4. GPU drivers (per vendor)

### 4a. NVIDIA — the open driver fork

For **memory quota only**, any stock 610.43.02 driver (open or proprietary)
suffices. For **compute isolation** (the runlist broker in Part 7c — the only
thing that binds a doorbell/cuBLAS ML tenant), you need the fork.

```sh
git clone git@github.com:pvnis/open-gpu-kernel-modules.git
cd open-gpu-kernel-modules && git checkout gpuslicing
# per-GPU spatial knob (TPCs = SMs / 2): RTX 5070 = 24, A6000 = 42, A100 = 54
#   src/nvidia/src/kernel/gpu/fifo/kernel_ctxshare.c: #define GHOST_TOTAL_TPC <N>
make modules -j$(nproc)
sudo bash ../gvisor/ghost-experiment/reload.sh    # unloads + insmods the built .ko, restarts k3s + the scheduler
```

The fork is *unpackaged* — it reverts on reboot unless the modules are placed in
`/lib/modules/.../updates`. Sandboxes must run with
`--nvproxy-allow-unsupported-driver` (610.43.02 is unsupported-but-known).
Confirm the new build actually loaded (`cat /sys/module/nvidia_uvm/srcversion`
and count `GHOST` lines in `dmesg` — 0 means the hook is absent).

> **Stale-module trap.** `rmmod nvidia` fails while `nvidia_modeset`←`nvidia_drm`
> hold refs; a following `insmod` then says "File exists" while the **old** module
> stays resident and you silently measure the previous build. `reload.sh` unloads
> drm/modeset first and hard-aborts if `nvidia` is still resident.

### 4b. AMD — amdgpu / ROCm host stack

Install the host amdgpu driver + **ROCm 7.2** the usual way; confirm `/dev/kfd`
exists and `rocm-smi` sees the card. Nothing gVisor-specific here — the Sentry
proxies `/dev/kfd` and the render node. The `/dev/kfd` major and `gpu_id` are
**dynamic** (change on reboot); never hardcode them (`~/amdtest/gputest.sh` reads
them from sysfs).

---

## 5. Build and install gVisor, containerd config, and the scheduler daemon

### 5a. Build `runsc`

```sh
git clone git@github.com:pvnis/gvisor.git && cd gvisor && git checkout gpuslicing
```

**sensai (no docker):** `bazel build //runsc:runsc`.
**sens1 (docker via sudo):**
```sh
PATH=/home/dmd/amdtest/bin:$PATH make build TARGETS=//runsc:runsc \
    DOCKER_CLI_PATH=/home/dmd/amdtest/bin/docker
```
**Verify the build changed** (bazel reports "0 actions" for a changed output and
its symlink can be stale): `sha256sum bazel-bin/runsc/runsc_/runsc` against the
deployed copy, and `strings … | grep <a string you added>`. Install to
`/usr/local/bin/runsc` on each node (atomic rename if a sandbox is running:
`cp … runsc.new && mv -f runsc.new /usr/local/bin/runsc`).

### 5b. containerd + runsc runtime config (per node)

Two files per node; both traps are silent if wrong.

**The runsc config** — decoded into `pkg/shim/v1/runsc.Options`; flags **must**
live under a `[runsc_config]` table or they are dropped without a word.

`sensai:/etc/runsc/config.toml` (NVIDIA):
```toml
log_level = "info"
[runsc_config]
  nvproxy = "true"
  nvproxy-allow-unsupported-driver = "true"
  nvproxy-docker = "true"
  nvproxy-gpu-scheduler-socket = "/run/runsc-gpu-scheduler.sock"
  nvproxy-gpu-weight = "100"                 # node ceiling; webhook lowers per-pod
  debug-log = "/var/log/runsc/%ID%/"
```

`sens1:/etc/runsc/config.toml` (AMD) — note the AMD side now also carries a
**weight + scheduler socket** for time-slicing (Part 8):
```toml
[runsc_config]
  platform = "kvm"
  amdproxy = "true"
  amdproxy-gpu-memory-limit = "..."          # node ceiling; webhook lowers per-pod
  amdproxy-gpu-scheduler-socket = "/run/runsc-gpu-scheduler.sock"   # for time-slicing
  amdproxy-gpu-weight = "100"                 # node ceiling; webhook lowers per-pod
  # amdproxy-cu-mask = "0xfff"                # ONLY if using spatial instead of time-slicing
```
A sandbox may carry a CU mask **or** a weight, never both (Part 8, the RDNA3
rule). runsc refuses a sandbox configured with both at startup.

**The containerd runtime handler** — register `runsc` and forward annotations, via
a k3s drop-in that survives upgrades
(`/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-runsc.toml`):
```toml
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc]
  runtime_type = "io.containerd.runsc.v1"
  pod_annotations = ["dev.gvisor.*"]         # WITHOUT THIS every pod silently
  container_annotations = ["dev.gvisor.*"]   # runs at the node-wide ceiling
[plugins."io.containerd.cri.v1.runtime".containerd.runtimes.runsc.options]
  TypeUrl = "io.containerd.runsc.v1.options"
  ConfigPath = "/etc/runsc/config.toml"
```

> **Trap — `pod_annotations`.** CRI copies only its own `io.kubernetes.cri.*`
> annotations by default. Without those two lines, every `dev.gvisor.flag.*`
> annotation is dropped and each pod runs at the node-wide ceiling (measured on
> AMD: a pod asking for 4 × 512 MiB got 12032 MiB). And the `[runsc_config]`
> table: flags at the top level are dropped silently — a pod then runs with no
> proxy at all and `open("/dev/kfd")` returns `ENXIO` with no log.

**Verify the flags arrived** (never infer from a plausible number):
```sh
sudo grep -m1 Args: $(sudo ls -t /var/log/runsc/*.boot.txt | head -1)
```

**The `RuntimeClass`** (one serves both vendors — each node resolves `runsc`
through its own `ConfigPath`):
```yaml
apiVersion: node.k8s.io/v1
kind: RuntimeClass
metadata: { name: gvisor }
handler: runsc
```

### 5c. The `runsc gpu-scheduler` daemon — on **every GPU node**

`runsc gpu-scheduler` is one host daemon per GPU node; sandboxes connect over a
Unix socket and it hands each a weighted time window. It is required on **both**
the NVIDIA node (runlist enforcement) and the AMD node (time-slicing
coordination — a Sentry cannot see how many other tenants compete, so
work-conserving division needs this coordinator).

```ini
# /etc/systemd/system/runsc-gpu-scheduler.service
[Service]
# NVIDIA node — drive the hardware runlist:
ExecStart=/usr/local/bin/runsc gpu-scheduler --socket /run/runsc-gpu-scheduler.sock \
    --measure-usage=false --runlist-control=/proc/driver/nvidia/gpusched
# AMD node — same daemon WITHOUT --runlist-control (amdproxy drives DBG_TRAP itself):
# ExecStart=/usr/local/bin/runsc gpu-scheduler --socket /run/runsc-gpu-scheduler.sock --measure-usage=false
Restart=always
```

`--measure-usage` defaults **on** and misprices the ordinary two-tenant case
(31/618 instead of 324/324); the documented setup passes `--measure-usage=false`.

> **Operational SPOF — fail-closed by design.** With `*-gpu-scheduler-socket` set,
> a GPU pod **cannot start** while `runsc-gpu-scheduler` is down (sandbox creation
> fails with `connection refused`). Failing open would mean an unlimited sandbox,
> so this is deliberate — but the service is a single point of failure for every
> GPU pod on the node. Never `pgrep -f gpu-scheduler | kill` (it matches and kills
> your own shell); kill by explicit pid. For a no-scheduler baseline, comment the
> socket out of the runsc config — the shim re-reads it per sandbox, no k3s
> restart needed.

---

## 6. HAMi (control plane)

Deploy **upstream** `projecthami/hami:v2.9.0` — `hami-scheduler`,
`hami-device-plugin`, `hami-webhook`. It runs the NVIDIA path and the AMD
time-slicing path unmodified.

- NVIDIA (and AMD, for uniform placement) pods set `schedulerName: hami-scheduler`.
- **Strip the `libvgpu.so` preload** from the device-plugin ConfigMap so it is
  gone from the node entirely; the webhook additionally stands it down with
  `CUDA_DISABLE_CONTROL` (the real limit is in the Sentry).
- If (and only if) you use **AMD spatial CU masks**, run the **fork**
  (`pvnis/HAMi`, `gvisor-amd-timeslice`) instead — it adds automatic disjoint
  CU-mask assignment (`cusForRequest`). For AMD time-slicing, upstream is enough.
- Snapshot before switching between fork and upstream — it is a shared-cluster
  change and a `runsc gpu-scheduler` must stay up throughout or GPU pods fail to
  start. A reference snapshot lives at `~/amdtest/k8s/pre-upstream-snapshot/` on
  sens1 (one `apply` to roll back).

---

## 7. Device plugins and the quota webhook

### 7a. AMD device plugin (AMD node only)

Deploy from `manifests/twovendor/amd-device-plugin.yaml`
(`nodeSelector: gpu.vendor=amd`). It advertises `amd.com/gpu-vram-mib` in
**512-MiB units** (~23 for a 12 GiB card).

> **After a kubelet/k3s restart the plugin does not re-register** (no
> re-register loop): the node advertises `amd.com/gpu-vram-mib: 0` and GPU pods sit
> `Pending`. Delete the plugin pod to re-register.

### 7b. The quota webhook — the piece that makes limits mandatory

Neither HAMi nor the AMD plugin writes the `dev.gvisor.flag.*` annotations, so
without this webhook a pod that omits them runs at the node ceiling — the whole
GPU. Build and deploy the **in-tree** webhook (`webhook/pkg/gpushare` from the
gVisor tree; image `gvisor-webhook:local`, deployed as
`gvisor-injection-admission-webhook`). It is two-vendor and narrow-only, and
performs the `libvgpu` stand-down. It translates, at admission:

| request | annotation written |
| --- | --- |
| `amd.com/gpu-vram-mib: N` | `amdproxy-gpu-memory-limit = N × 512 MiB` |
| `amd.com/gpu-vram-mib: N` (time-slicing) | `amdproxy-gpu-weight = N` (the requested unit count *is* the ratio — admission runs before placement, so no device size is known and a ratio is all the scheduler needs) |
| `nvidia.com/gpumem: M` (MiB) | `nvproxy-gpu-memory-limit = M × 1 MiB` |
| `nvidia.com/gpucores: C` | `nvproxy-gpu-weight = min(C, 100)` |

Requests are summed across a pod's containers (flags are per-**sandbox**), init
containers taken with `max()`. **Narrow-only:** a pod may lower its own limit,
but an annotation *higher* than the computed value is overwritten (verified: an
8 GiB self-annotation rewritten to the 1 GiB requested; an attacker claiming the
whole card + weight 100 while requesting 6 slices got its slice limit and
weight 6). The webhook deliberately does **not** assign disjoint CU masks — that
needs placement state admission cannot see (the HAMi fork does it, Part 6).

> **`failurePolicy: Fail` is a security property.** A pod admitted *without* being
> mutated carries no `dev.gvisor.flag.*` and runs at the node-wide ceiling. `Fail`
> makes an unreachable webhook block pod creation (fails closed, loudly); `Ignore`
> turns it into a silent quota escape. Keep it `Fail`.

**Deployment gotchas** (each blocks the webhook silently):
- Pass **`--port=8443`** (defaults to 0 while the Service targets 8443).
- The webhook mints a fresh CA on start and **reconciles the
  `MutatingWebhookConfiguration.caBundle`** — needs `get`+`update` on
  `mutatingwebhookconfigurations` in its ClusterRole (alongside `create`).
- Scope with `--pod-namespace-labels=<label>`; an *empty* selector is rejected by
  the apiserver. **Label the target namespaces** (`kubectl label ns … gvisor=`);
  vCluster-synced namespaces are **not** labeled by default → silent quota escape.

---

## 8. Choosing the AMD compute mechanism: spatial XOR temporal

On RDNA3 a sandbox may have a CU mask **or** a time slice, **never both** — the
amdgpu driver refuses a debug session's CWSR workaround on a CU-masked queue
(`kfd_dbg_set_queue_workaround`, `-EBUSY`, GC 11.0.0–11.0.3). A time slice is
enforced through exactly such a session, so the two are mutually exclusive per
device. runsc refuses a sandbox configured with both at startup. Memory quota
composes with either.

| | Spatial — CU masks | Temporal — time-slice |
| --- | --- | --- |
| Config | `amdproxy-cu-mask` (fork auto-assigns disjoint masks, or set manually) | `amdproxy-gpu-weight` + `amdproxy-gpu-scheduler-socket` (Part 5c) |
| HAMi | needs the **fork** for automatic disjoint assignment | runs on **upstream** HAMi |
| Execution | concurrent on disjoint CUs | interleaved, whole device, by weighted duty cycle |
| Work-conserving | no (idle CUs idle) | **yes** (via `runsc gpu-scheduler`) |
| Isolates | compute pipelines, not memory bandwidth | wall-clock time; partitions the bus |

Time-slicing is measured to divide accurately (300:100 → 3.05:1, Jain 1.0000 at
equal weights) and be work-conserving; `vecadd` stays correct while sliced (CWSR
preempts mid-kernel). See `../gvisor/CLAUDE.md` ("Time-slicing AMD from
userspace") and `../gvisor/GPU-ISOLATION.md`.

---

## 9. NVIDIA compute isolation — the driver runlist broker

This is the **production** path for imposing a compute share on an arbitrary
(doorbell/cuBLAS/graph-replay) CUDA workload, which the Sentry compute gate
cannot bind on Volta+. It requires the Part-4a driver fork, driven by
`runsc gpu-scheduler --runlist-control` (Part 5c).

- The **credit scheduler** (`pkg/gpusched/credit.go`) charges each tenant
  per-tenant credit, weighting charge-back by the driver's per-tenant TSG count
  (the `tsgs` report), and detaches/attaches whole tenants from the runlist. This
  closes the process-*packing* share-theft (a low-weight tenant forking N
  processes to multiply its channel groups), verified on GA100, GA102, GB205.
- Manual runlist control for probing:
  ```sh
  echo poll            | sudo tee /proc/driver/nvidia/gpusched   # list tenant PIDs + tsgs
  echo "ts <pid> 3000" | sudo tee /proc/driver/nvidia/gpusched   # weight → timeslice µs
  echo "detach <pid>"  | sudo tee /proc/driver/nvidia/gpusched   # evict / restore with attach
  ```

Under gVisor+KVM the driver attributes a sandbox's objects to the Sentry PID
(which appears as `exe`), so that PID is the per-sandbox handle the broker keys
on. Details: `../gvisor/NVIDIA-COMPUTE-ISOLATION.md`,
`../open-gpu-kernel-modules/DRIVER-CHANGES.md`.

---

## 10. Multi-tenant isolation layer (vCluster)

Cluster-level tenancy on top of host-level slicing — each tenant gets its own API
server and NetworkPolicy boundary. Orthogonal to the GPU enforcement (verified:
neither weakens the other). This repo's `README.md` is the tenancy deep-dive;
`TWO-VENDOR-CLUSTER.md` is the two-vendor runbook. Essentials:

```sh
vcluster create tenant-amd-a -n tenant-amd-a \
  --values values/tenant.yaml --values values/amd-tenant.yaml \
  --values values/tenant-amd-a.yaml --connect=false
# then apply manifests/tenant-netpol-amd.yaml AND manifests/tenant-cnp-amd.yaml
```

- **`sync.toHost.pods.runtimeClassName: gvisor`** is load-bearing — it forces
  every synced pod onto runsc regardless of what the tenant asked for.
- **Label synced namespaces `gvisor=`** or the webhook does not fire (silent quota
  escape).
- **Scope node sync to the vendor node** (`sync.fromHost.nodes.selector.labels:
  {gpu.vendor: amd}`) so a tenant's scheduler sees only the real allocatable.
- **Cross-node vCluster netpol needs Cilium `fromEntities: [remote-node]`** — a
  control plane on the agent node crosses Cilium's overlay, resolved to the
  reserved `remote-node` identity before any `ipBlock` CIDR is checked. Plain
  `NetworkPolicy` cannot express it; only `CiliumNetworkPolicy`
  (`tenant-cnp-amd.yaml`). Diagnose with `hubble observe --pod <ns>/<pod>`.

---

## 11. Verification

```sh
kubectl apply -f manifests/twovendor/both-vendors-quota.yaml
kubectl logs -n gpu-test amd-mem       # reports its quota (e.g. 2048 MiB), not 12272
kubectl logs -n gpu-test nv-compute    # cuMemGetInfo total = the limit, not 12227
```

Reference results: two AMD tenants on disjoint CU halves (`0x03f`/`0xfc0`) each
held their 2048 MiB ceiling; two NVIDIA pods at weights 300/100 divided 486/162
launches/s (3.00:1) at 99% of solo aggregate; AMD time-slicing 300:100 → 3.05:1,
Jain 1.0000 equal; a 3-good-+-1-attacker run contained the attacker to its
entitlement, zero driver faults. No cross-vendor interference.

---

## 12. Consolidated gotchas

Each reads like a different bug than it is:

- **A wedged GPU sandbox does not clean up.** `kubectl delete --force` /
  `runsc delete --force` return while the Sentry keeps `/dev/kfd` and the VRAM. It
  appears as `exe`; find with `sudo lsof /dev/kfd` / `sudo fuser -v /dev/nvidia*`
  and kill it, or the next pod fails with a "free memory" error that looks like a
  quota bug.
- **The `gpu-scheduler` is a fail-closed SPOF on every GPU node** (Part 5c). No
  gVisor GPU pod starts without it.
- **`pod_annotations` and the `[runsc_config]` table** — get either wrong and
  every pod silently runs at the node ceiling (Part 5b).
- **Namespace labels** — the webhook only fires on namespaces labeled `gvisor`;
  vCluster-synced ones are unlabeled by default (Part 7b / 10).
- **The AMD device plugin does not re-register** after a kubelet restart (Part 7a).
- **AMD CU masks must select whole workgroup processors** on RDNA (2-CU
  granularity; `0x7` is rejected at startup). `AMDKFD_IOC_SVM` is denied
  deliberately (forwarding it crashes ROCr).
- **CU mask and time slice are mutually exclusive on RDNA3** (Part 8).
- **`gpu_id` / `/dev/kfd` major are dynamic** — never hardcode (`~/amdtest/gputest.sh`).
- **Sentry warnings go to `/var/log/runsc/`**, not the pod's `gvisor.log`.
- **containerd's `k8s.io` image store is separate from docker's** — a stale image
  invisible to `docker images` can fail *after* the sandbox enumerates the GPU.

---

## 13. How the projects relate

- **`../gvisor`** — the Sentry enforcement + `runsc gpu-scheduler` + the in-tree
  webhook. Start at `../gvisor/GPU-ISOLATION.md`.
- **`../open-gpu-kernel-modules`** — the privileged NVIDIA driver broker
  (`DRIVER-CHANGES.md`).
- **`../HAMi-gvisor`** — the placement fork (only for AMD spatial CU masks;
  everything else runs on upstream HAMi).
- **this repo** — the cluster and tenancy layer (`README.md`, `TWO-VENDOR-CLUSTER.md`,
  `CILIUM-DESIGN.md`).

The two enforcement layers (Sentry + driver broker) are orthogonal to the
tenancy layer in what they guarantee, and neither weakens the other.
