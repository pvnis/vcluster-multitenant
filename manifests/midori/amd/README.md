# midori-amd-0: the AMD GPU node

    VM          midori-amd-0, 10.30.30.160, flavor plump-gpu-r9700 (16 vCPU, 64 GiB,
                PCI passthrough of the GPU and its audio function), hypervisor gpu1
    GPU         AMD Radeon AI PRO R9700: Navi 48, gfx1201 (RDNA4), 64 CUs, 32624 MiB
    kernel      7.0.0-38-generic (Ubuntu 24.04 HWE), held; the other nodes run 6.8
    driver      in-tree amdgpu + AMD's firmware (amdgpu-dkms-firmware, ROCm 7.2.4 repo)
    k3s         agent v1.36.5+k3s1, joined through the API load balancer 10.30.30.106
    label/taint gpu.vendor=amd, and gpu.vendor=amd:NoSchedule
    runsc       operator build 71a5612d7, systrap, amdproxy=true (below);
                prior e6a06cbce kept as /usr/local/bin/runsc.e6a06cbce for rollback
    driver-mod  operator-modified amdgpu (DKMS) so ROCm works under systrap (below)

Joined 2026-10-16. Verified on it:
- `rocminfo` lists gfx1201 with 64 CUs; KFD reports gfx_target_version 120001;
- Cilium agent healthy, Socket LB `Hostns-only`;
- a gVisor pod pulls from registry.midori, resolves DNS and reaches a ClusterIP;
- node-exporter and Alloy run on it.

## Setup

1. `amd-base.sh` (copy in this directory), run twice: phase 1 installs and holds
   the 7.0 kernel and reboots; phase 2 installs AMD's firmware package and
   `rocminfo` and loads amdgpu.
2. Files from the NVIDIA nodes, unchanged: `/etc/rancher/k3s/registries.yaml`,
   `/etc/rancher/k3s/resolv.conf`, and the containerd drop-ins `00-cni.toml` and
   `10-runsc.toml`; runsc and its shim in `/usr/local/bin`.
3. `k3s-config.yaml` here as `/etc/rancher/k3s/config.yaml`, with `token-file:
   /etc/rancher/k3s/token` (mode 600, never in git), and `runsc-config.toml` as
   `/etc/runsc/config.toml`. Then
   `curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION=v1.36.5+k3s1 INSTALL_K3S_EXEC=agent sh -`.
4. OpenStack: the port gets the `midori-nodeports` security group
   (`../OPENSTACK-GAPS.md`), like the other nodes.

## Why kernel 7.0, not ROCm's driver on 6.8

- Ubuntu's 6.8 has no RDNA4 support: its in-tree amdgpu fails with "Fatal
  error during GPU init".
- The cloud image's 6.8.0-88 no longer has `linux-modules-extra`, which carries
  `drm_display_helper` and `drm_buddy`.
- ROCm 7.2.4's `amdgpu-dkms` (6.16.13) does not build on the newest 6.8,
  6.8.0-147: "too few arguments to function `pci_resize_resource`". Ubuntu
  changed that signature within 6.8, and AMD's compatibility layer does not
  detect it.
- The HWE kernel's in-tree amdgpu supports RDNA4. The only missing piece was
  gfx12 firmware, which AMD's `amdgpu-dkms-firmware` puts in
  `/lib/firmware/updates/amdgpu`.

## AMD GPU pods under gVisor on systrap (resolved by the operator)

This VM has no `/dev/kvm` (the guest CPU is exposed without `svm`), so the
`--platform=kvm` path amdproxy originally needed was not available. Rather than
wait on nested virtualization, the operator made ROCm work under gVisor on the
default **systrap** platform, with an operator-provided modified `amdgpu`
driver and a matching gVisor (`runsc`) build on midori-amd-0. That work lives
outside this repo; its author (the midori-amd-0 session / the operator) owns
it. Verified end to end: an HSA queue retires packets through its doorbell and
ROCr kernels fill and read back VRAM on the R9700 (gfx1201) under systrap.

What this repo adds:

- **`device-plugin.yaml`** — the AMD device plugin. The node advertises
  `amd.com/gpu-vram-mib: 63` (63 x 512 MiB of 32624 MiB).
- **Per-pod limit** — the gVisor quota webhook (`../gvisor-webhook.yaml`,
  already deployed) injects `dev.gvisor.flag.amdproxy-gpu-memory-limit` from a
  pod's `amd.com/gpu-vram-mib` request, in namespaces labelled `gvisor` (every
  tenant namespace). Verified by dry-run: a 4-unit request annotated 2048 MiB.
- **Per-tenant cap** — `quota.amdGpuVramMiB` in the Tenant spec renders
  `requests.amd.com/gpu-vram-mib` (one unit = 512 MiB; floored to units).

Still open:

- The `gpu.vendor=amd:NoSchedule` taint stays until AMD tenancy is opened; an
  AMD GPU pod needs `runtimeClassName: gvisor`, a toleration for it, and an
  `amd.com/gpu-vram-mib` request.
- No `amd-tenant.yaml` values overlay yet (real node sync scoped to
  `gpu.vendor=amd`, per `../../../TWO-VENDOR-CLUSTER.md`), so tenants cannot
  schedule onto this node through their own vCluster until that exists.

The device plugin runs **privileged** (KFD hides a GPU's topology from a
container whose device cgroup excludes its render node); see `device-plugin.yaml`.

Kernel 7.0 and RDNA4 are newer than anything the earlier Navi 32 amdproxy work
(on 6.x) was tested against, so treat AMD GPU workloads here as freshly proven,
not long-soaked.
