# amdvm: a single-node AMD GPU cluster (one VM, two MI355X)

k3s server and GPU node in one VM (`gpu-test-dmd` on `mi355-gpu-31`), its two
MI355X reaching it as GIM SR-IOV VFs (`1002:75b3`, one per physical GPU, each
a full card: 256 CUs, ~288 GiB). Built 2026-11-12, verified 2026-11-16.

    kernel     Ubuntu 24.04, 6.8.0-149, Secure Boot on (DKMS MOK enrolled)
    driver     pvnis/amdgpu kfd-mmap (DKMS amdgpu/7.1.9.kfdmmap), firmware amdgpu 31.60
    ROCm       7.2.4 userspace
    runsc      pvnis/gvisor gpuslicing, systrap (runsc-config.toml)
    k3s        v1.36.5+k3s1 (k3s-config.yaml), Cilium 1.19.8 (cilium-values.yaml)
    tenants    tenant-amd-a :31543, tenant-amd-b :31643 (create-tenant.sh)

## Build order

1. `apt install build-essential dkms autoconf automake libtool linux-modules-extra-$(uname -r)`.
   The cloud kernel lacks `drm_display_helper` and `cec` without the extra modules.
2. Driver: `assemble-amdgpu-dkms.sh ~/amdgpu /usr/src/amdgpu-7.1.9.kfdmmap`,
   set `PACKAGE_VERSION` in its `dkms.conf`, then `dkms add` / `dkms install`.
   AMD's packaging runs `autogen.sh`; without it the KCL compatibility checks
   never run and the build fails on kernel API mismatches.
3. Firmware and ROCm from repo.radeon.com (`amdgpu/31.60` for the firmware,
   `rocm/apt/7.2.4`). Pin `amdgpu-dkms` to -1 so apt never replaces the module.
4. Secure Boot: `mokutil --import /var/lib/shim-signed/mok/MOK.der`, then enroll
   at the console on reboot. Re-creating the VM wipes the enrollment.
5. runsc + shim from pvnis/gvisor `gpuslicing`, `runsc-config.toml` to
   `/etc/runsc/config.toml`, `runsc-gpu-scheduler.service`, the containerd
   drop-ins from `../midori/containerd-{00-cni,10-runsc}.toml`.
6. k3s with `k3s-config.yaml`, Cilium with `cilium-values.yaml`, the
   `gvisor` RuntimeClass, `amd-device-plugin.yaml`, `gvisor-webhook.yaml`,
   `../midori/platform-guard.yaml`, then `create-tenant.sh` per tenant.

Images are built locally (no registry): a static binary layered with `crane
append` and imported with `k3s ctr images import --all-platforms` (without that
flag the import is silently filtered out).

## Things that bit

- **The VM's address is DHCP and changes when the VM is re-created.** Hence no
  `node-ip` in k3s, Cilium on `127.0.0.1:6443`, and `tenant-kubeconfig.sh` to
  rewrite the tenant kubeconfigs.
- **The device plugin does not re-register after a k3s restart or reboot**:
  allocatable `amd.com/gpu-vram-mib: 0` until its pod is deleted. It also
  advertises only the first GPU (575 units, renderD128).
- **A guest kernel crash under GIM took all eight physical GPUs on the host
  down** (firmware boot failed, GPU lost); the host needed recovering. Treat
  any test that can oops the guest as affecting every VM on the host.

## Verification

- `gpu-vecadd.yaml` (host-admin, hostPath) and `tenant-gpu-vecadd.yaml`
  (applied with a tenant kubeconfig, image `localhost/gpu-vecadd`, built from
  `vecadd.hip`): one GPU visible, the webhook's 4 GiB limit seen as
  `vram_total`, correct results.
- Two such pods at once, in `gpu-test` and then one per tenant: ~450-490
  `suspend_queues` calls per run (ftrace function profile), no oops. This is
  the case that crashed the unpatched driver.
- `../../test-isolation.sh` with the tenant names substituted: 10/10.

- GPU programs run one after another in one pod each get the GPU and the
  full quota (pvnis/gvisor gpuslicing `bb6b53408`): amdproxy gives back what
  an exited program held and lets the next take its address space over.
  Programs running at the same time in one pod still need the
  `dev.gvisor.flag.amdproxy-share-kfd-vm: "true"` annotation.
