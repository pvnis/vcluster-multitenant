# midori-amd-0: the AMD GPU node

    VM          midori-amd-0, 10.30.30.160, flavor plump-gpu-r9700 (16 vCPU, 64 GiB,
                PCI passthrough of the GPU and its audio function), hypervisor gpu1
    GPU         AMD Radeon AI PRO R9700: Navi 48, gfx1201 (RDNA4), 64 CUs, 32624 MiB
    kernel      7.0.0-38-generic (Ubuntu 24.04 HWE), held; the other nodes run 6.8
    driver      in-tree amdgpu + AMD's firmware (amdgpu-dkms-firmware, ROCm 7.2.4 repo)
    k3s         agent v1.36.5+k3s1, joined through the API load balancer 10.30.30.106
    label/taint gpu.vendor=amd, and gpu.vendor=amd:NoSchedule
    runsc       e6a06cbce (as the NVIDIA nodes), systrap, no amdproxy (below)

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

## Blocked: AMD GPU pods under gVisor need nested virtualization

ROCm under gVisor (amdproxy) needs `--platform=kvm`. On systrap, KFD binds each
mapping to the process that owns the KFD context, but systrap maps from a stub
process, so `mmap` of `/dev/kfd` fails with `EINVAL` (gvisor fork, commit
87e2dfe49, "KFD mappings are impossible on the systrap platform").

This VM has no `/dev/kvm`: the guest CPU (EPYC-Genoa model) is exposed without
`svm`. So the node runs CPU sandboxes only, and `runsc-config.toml` leaves
amdproxy off; with it on, every AMD sandbox would fail.

**Ask (site admins, hypervisor gpu1):**
- nested virtualization for AMD: `kvm_amd nested=1`;
- a guest CPU with `svm`: libvirt `cpu_mode = host-passthrough`, or
  `cpu_model_extra_flags = svm` for the EPYC-Genoa model;
- then a hard reboot of midori-amd-0.

PCI passthrough and nested virtualization work together.

When `/dev/kvm` appears:
- runsc `platform = "kvm"` and `amdproxy = "true"`, with the node's VRAM and CU
  mask as ceilings (as `../../twovendor/sens1-runsc-config.toml`);
- an AMD device plugin and the quota webhook's AMD resources, per
  `../../../TWO-VENDOR-CLUSTER.md`;
- tenant quotas for AMD memory in the controller;
- lift the taint.

Kernel 7.0 is newer than anything amdproxy was tested on (the Navi 32 work was
on 6.x), so that part needs testing.
