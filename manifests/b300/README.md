# B300 node (vm-jumbo-test-dmd): multi-GPU + fractional GPU under gVisor

The whole stack on one 8× B300 SXM6 AC box (NVSwitch/NVLink5, 275 GB each,
148 SMs = 74 TPCs), built 2026-09-29. It is the multi-GPU counterpart to
`../../SETUP.md` (sensai) and `gvisor/A100-CLUSTER.md` (single A100).

    OS / kernel   Ubuntu 24.04.5, 7.0.0-34-generic
    driver        610.43.02 open modules from ~/open-gpu-kernel-modules
                  (gpuslicing, GHOST_TOTAL_TPC=74), userspace + FM 610.43.02
    k3s           v1.36.3+k3s1, flannel + kube-router netpol (no Cilium)
    runsc         ~/gvisor gpuslicing @ 2d4885967, systrap
    HAMi          2.9.0 upstream chart
    vCluster      0.36.1: tenant-nv-a (:31943), tenant-nv-b (:32043)

## What was done, in order

1. **Driver: 595.91.07 → 610.43.02 fork.** nvproxy knows 610.43.02
   (unsupported-but-known) and not 595.x. On an NVSwitch box Fabric Manager must
   match the driver exactly, so the whole userspace moved too:
   `nvidia-driver-pinning-610.43.02`, then `libnvidia-compute libnvidia-cfg1
   libnvidia-gpucomp nvidia-persistenced nvidia-kernel-common nvidia-firmware
   nvidia-modprobe nvidia-fabricmanager libnvidia-nscq nvidia-imex` all
   `=610.43.02-1ubuntu1` from the CUDA repo, removing every Ubuntu `*-595-server`
   / `*-590*` package (including the DKMS one). `nvidia-imex` is installed but
   disabled (single node).
   Fork modules live in `/lib/modules/$(uname -r)/updates/nvidia-ghost/`,
   `depmod`'d, listed in `/etc/modules-load.d/nvidia.conf`, so they survive
   reboot.
   The build is `gpuslicing` @ 0591164d with one local edit, deliberately not
   committed because it is a per-GPU knob:
   `src/nvidia/src/kernel/gpu/fifo/kernel_ctxshare.c`:
   `#define GHOST_TOTAL_TPC 74` (was 24 for the RTX 5070). Then
   `make modules -j64`, which takes about 1 minute on 224 cores.
2. **`/etc/modprobe.d/nvidia-ghost.conf`: `GhostTpcCount=0`.** The hooked build
   otherwise grants every CUDA context a 27-TPC partition, silently capping a
   74-TPC B300 at about a third.
3. **runsc build deps** beyond the A100 list: `g++-aarch64-linux-gnu` (vdso
   genrule needs `cc1plus`) and `libbpf-dev` (`bpf/bpf_helpers.h`).
4. `/etc/runsc/config.toml` (nvproxy, nvproxy-docker, allow-unsupported-driver,
   scheduler socket, weight ceiling 100, **no node memory ceiling**, so a
   whole-GPU pod gets the whole 275 GB), containerd template
   `/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.tmpl`, and
   `runsc-gpu-scheduler.service` with `--runlist-control`.
5. HAMi 2.9.0: `devicePlugin.passDeviceSpecsEnabled=true`,
   `devicePlugin.runtimeClassName=nvidia`, `createRuntimeClass=true`; scheduler
   strategy patched to `Recreate`; `ld.so.preload` emptied in the ConfigMap,
   then the plugin pod deleted. Advertises 80 `nvidia.com/gpu` (8 × split 10).
6. Webhook: `gvisor-webhook.yaml`. **This revision does not mint its own CA**:
   it reads `caKey.pem caCert.pem serverKey.pem serverCert.pem` from its cwd, so
   they are generated with openssl (SAN
   `gvisor-injection-admission-webhook.e2e.svc`), stored in secret
   `e2e/gvisor-webhook-certs`, and mounted as `workingDir`. The image is a
   `FROM scratch` docker build imported with `k3s ctr images import`.
7. Tenants: namespaces labelled `gvisor=` and PSA `baseline`; host-side
   `tenant-quota.yaml` (a: 4 GPUs / 1.1M MiB, b: 2 GPUs / 200k MiB) and
   `tenant-netpol.yaml`; `vcluster create … --values tenant.yaml nv-tenant.yaml
   b300-tenant.yaml b300-<t>.yaml`. `b300-tenant.yaml` turns *off* tenant
   NetworkPolicy sync, because there is no Cilium deny floor here.
   Kubeconfigs are in `~/tenants/`.

## Results (all pods under runsc, `uname -r` = 4.19.0-gvisor)

| test | result |
| --- | --- |
| fractional, 1 GPU, 40000 MiB / 50 cores | sees 40000 MiB; 1316 TFLOPS bf16 alone |
| 4-GPU pod (host and from tenant-nv-a) | 4 devices, all-pairs P2P, ~715 GiB/s NVLink copy, NCCL all-reduce 624 GB/s busbw, 5.4 PFLOPS |
| 8-GPU pod | 10.86 PFLOPS, ~718 GiB/s to every peer, NCCL 8-way **696 GB/s** |
| 75/25 on one GPU, cuBLAS matmul (host) | 1015 : 346 = **2.94 : 1**, sum ≈ solo |
| 75/25 from inside tenant-nv-b | 1002 : 357 = 2.80 : 1; after reload 994 : 354 = 2.81 : 1 |
| tenant asks runtimeClass `nvidia` + self-annotates 256 GiB / weight 100 | still gVisor; narrowed to 20000 MiB / weight 20 |
| tenant-b asks 3 GPUs (quota 2) | rejected by the host ResourceQuota |
| whole-GPU pod vs fractional pods on the same GPU | HAMi keeps fractional pods Pending until the whole-GPU pod is done |
| cross-tenant pod IP, tenant → host API | blocked; own service/pod reachable |

The cuBLAS split binding is the driver broker at work (dmesg shows
DETACH/ATTACH → 0x0). Without the broker, the A100 run split the same
workload 1 : 1.

## Defects found

1. **The broker's group table never frees entries (fail-open).**
   `g_ghostGroups[GHOST_MAX_GROUPS=256]` in `kernel_channel_group_api.c` gains a
   slot per channel group and never releases one when a client goes away. A
   4-GPU NCCL pod takes ~56 slots and an 8-GPU pod ~110, so the table filled
   after 10 sandboxes. After that, new sandboxes are silently untracked: the
   same 75/25 pair measured **645 : 644**. Nothing logs it. Only a module reload
   clears it (stop k3s + `k3s-killall.sh`, FM, persistenced, DCGM, the
   scheduler; `rmmod`; `modprobe`; restart). The ~450 `RESTART_RUNLIST`
   / `SET_TIMESLICE` errors (`0x23` INVALID_CLIENT, `0x57` OBJECT_NOT_FOUND) are
   the scheduler still acting on those dead entries. On a busy multi-GPU node
   this is hours, not weeks.
2. **The broker is single-GPU and keyed by pid.** `g_ghostGpu` is whichever GPU
   last recorded a group, and `detach <pid>` acts on every channel that pid owns
   on every GPU. `runsc gpu-scheduler` divides each GPU separately, so a
   multi-GPU sandbox that shares one of its GPUs gets detached on all of them
   during the other tenant's window. Not yet measured. Every test here kept
   shared GPUs single-GPU per pod.
3. **Multi-GPU fractional pods get 1/N of their memory.** HAMi's
   `nvidia.com/gpumem` is per device, but the webhook (`gpushare.peakRequest`)
   writes it as the sandbox-wide `nvproxy-gpu-memory-limit`. For
   `gpu: 2, gpumem: 50000`, HAMi reserves 2 × 50000 but the sandbox is capped at
   50000 in total. Each device still *reports* 50000 MiB, so after allocating
   45000 on GPU0 an allocation on GPU1 OOMs with 3.7 GiB free. The error is on
   the safe side (under-grant), but the per-device report is misleading. The
   fix: multiply by the container's `nvidia.com/gpu` count, or make the Sentry
   limit per device.
4. Minor: `nvidia-smi topo -m` fails inside the sandbox ("Failed to run
   topology matrix"); NCCL/P2P are unaffected. `SETUP.md` §7b says the webhook
   mints a fresh CA; this revision does not (step 6).

## Tear-down / revert of the driver

`sudo apt-get install nvidia-headless-595-server-open nvidia-fabricmanager-595
nvidia-utils-595-server` (after removing the 610 packages and the pinning
package), delete `/lib/modules/$(uname -r)/updates/nvidia-ghost` and
`/etc/modprobe.d/nvidia-ghost.conf`, `depmod -a`, reboot.
