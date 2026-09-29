# B300 node (vm-jumbo-test-dmd): multi-GPU + fractional GPU under gVisor

The whole stack on one 8× B300 SXM6 AC box (NVSwitch/NVLink5, 275 GB each,
148 SMs = 74 TPCs), built 2026-09-29. It is the multi-GPU counterpart to
`../../SETUP.md` (sensai) and `gvisor/A100-CLUSTER.md` (single A100).

    OS / kernel   Ubuntu 24.04.5, 7.0.0-34-generic
    driver        610.43.02 open modules from ~/open-gpu-kernel-modules
                  (b300-multigpu, GHOST_TOTAL_TPC=74), userspace + FM 610.43.02
    k3s           v1.36.3+k3s1, flannel + kube-router netpol (no Cilium)
    runsc         ~/gvisor b300-multigpu (gpuslicing + per-device limit), systrap
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
| 2 GPUs × 50000 MiB (tenant-nv-b, after fix 3) | each GPU reports 50000; 45000 on each OK; +10000 on one refused |
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

## Defects found, and their status

Fixes are on the `b300-multigpu` branches of `pvnis/open-gpu-kernel-modules`
(2fb966df) and `pvnis/gvisor` (03dc87380). The node runs both.

1. **FIXED: the broker's group table never freed entries (fail-open).**
   `g_ghostGroups[256]` gained a slot per channel group and never released
   one. A 4-GPU NCCL pod takes ~56 slots and an 8-GPU pod ~110, so the table
   filled after 10 sandboxes; after that a 75/25 pair measured **645 : 644**,
   with nothing logged. Slots are now released in `kchangrpapiDestruct_IMPL`
   and reused, and a full table is logged. Verified: three 8-GPU NCCL pods in a
   row, and the table drains to 0 after each.
2. **FIXED: every broker RPC went to one GPU.** `g_ghostGpu` was whichever GPU
   last recorded a group, and all groups' controls were sent there, so groups
   on other GPUs got `OBJECT_NOT_FOUND`: 147 of 168 `SET_TIMESLICE` calls
   failed on an 8-GPU pod. A tenant opening a context on GPU B could take
   enforcement away from a pair on GPU A. Each group now carries its own
   `OBJGPU`. Verified: 155/155 `SET_TIMESLICE` OK, and 75/25 held **3.06 : 1**
   while another pod created 26 contexts on a different GPU.
3. **FIXED: multi-GPU fractional pods got 1/N of their memory.** HAMi's
   `gpumem` is per device; the webhook used it as the sandbox total. Now
   runsc has `--nvproxy-gpu-memory-limit-per-device`, which attributes VRAM
   to the device named in the `NV01_DEVICE_0` alloc it was made under.
   Unattributable VRAM counts against every GPU. Each GPU reports its own
   share. The webhook writes total = gpumem × GPUs, plus the per-device
   annotation for multi-GPU pods. Scaling the total alone was rejected, because
   a pod could then stack the whole total on one GPU, into another tenant's
   memory. Verified from tenant-nv-b (`tenant-b-frac-2gpu.yaml`): each GPU
   reports 50000 MiB, 45000 fits on both, and +10000 on GPU0 is refused.
   Unit tests: `TestPerDeviceLimit*`, `TestDeviceOfResolvesThroughParents`,
   `TestVirtualFBPerDevice`, `TestInjectGPUMemoryLimitMultiGPU`.
4. **Open: broker control is per pid, not per GPU.** `detach <pid>` acts on
   all of a sandbox's GPUs, while the scheduler decides per GPU. So a
   multi-GPU sandbox that shares one GPU would be paused on all of them. This
   comes from reading the code and has not been measured. The fix needs a GPU
   qualifier in the procfs protocol and in `pkg/gpusched`.
5. Open, minor: about 27% of `RESTART_RUNLIST` calls return `0x40`
   (INVALID_STATE) on an 8-GPU pod (previously hidden behind the 0x57s);
   detach and timeslice are unaffected. `nvidia-smi topo -m` fails inside the
   sandbox. `SETUP.md` §7b says the webhook mints its own CA; this revision
   does not (step 6). A driver `srcversion` does not change for edits under
   `src/nvidia/`; check the build date in the `NVRM: loading` line instead.

### Deploying the fixes

Driver: build `b300-multigpu` (plus the local `GHOST_TOTAL_TPC 74`), then run
the reload sequence: stop k3s + `k3s-killall.sh`, the scheduler, DCGM, FM and
persistenced; `rmmod`; copy the `.ko`s to `updates/nvidia-ghost`; `depmod`;
`modprobe`; start FM, wait for fabric `Completed`, start everything else.
gVisor: `bazel build //runsc:runsc //shim:containerd-shim-runsc-v1
//webhook:webhook`. Install runsc/shim by `cp` to `.new` + `mv` (tenant
control planes run under runsc). Rebuild and import the webhook image, delete
the webhook pod, and restart `runsc-gpu-scheduler`.

## Tear-down / revert of the driver

`sudo apt-get install nvidia-headless-595-server-open nvidia-fabricmanager-595
nvidia-utils-595-server` (after removing the 610 packages and the pinning
package), delete `/lib/modules/$(uname -r)/updates/nvidia-ghost` and
`/etc/modprobe.d/nvidia-ghost.conf`, `depmod -a`, reboot.
