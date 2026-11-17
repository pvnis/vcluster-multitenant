# Bare-metal deployment design — provision from the router

> First cut. Several forks are still open (see **Decisions** and **What I need
> from you**); this is the architecture to react to, not a finished plan.

## Why — bare metal is the goal, the VMs are a stopgap

midori is **designed for bare metal**. It runs in OpenStack VMs today only because
no suitable bare-metal environment was available yet; the VMs are a stopgap. The
recent fabric work — the three Midori VPCs, Cilium BGP to router0, CephFS over the
storage VLAN (`FABRIC-BRINGUP.md`, `NETWORKING-BAREMETAL.md`, `ceph-csi/README.md`)
— gave those VMs *direct* fabric access. That is both the first real step toward
the target and a dress rehearsal for it: the Cilium-BGP / LB-IPAM / CephFS edge we
just proved works unchanged on bare metal.

What bare metal unlocks (the body of `NETWORKING-BAREMETAL.md`, now the active plan
rather than a someday): no Neutron overlay tax — native routing, jumbo end-to-end,
DSR / source-IP, routable public VIPs, BGP/ECMP HA — plus real GPU passthrough
without the VM's VFIO ceiling (`gvisor-du-fronthaul` note) and full NUMA/NVLink
visibility.

## The deploy-from-the-router model

The router is the **provisioning hub**: it hosts the Hedgehog control node and has
OOB reach to both the switches and the servers' BMCs. Two provisioning planes run
from it — but only one is Hedgehog's.

### Plane 1 — the fabric (Hedgehog's job)

The **Hedgehog control node** (on/at the router) is a dedicated Flatcar appliance
running k3s + the Fabric controller + a DHCP + a small HTTP server + a private
registry, built with `hhfab` (`hhfab init` → edit `fab.yaml` → `hhfab validate` →
`hhfab build` → an install ISO/USB). Current release 26.05: hhfab v0.51.4, fabric
v0.144.1 (SONiC 4.5.2), control-node k3s v1.36.4.

- **Switches** are declared in the **wiring diagram** (YAML: Switches, Servers,
  Connections, Fabric ASN ranges, VLAN/IPv4 namespaces), booted into ONIE install
  mode, and **ZTP-provisioned over the OOB management network** — the control
  node's DHCP+HTTP, keyed on each switch's serial or first mgmt-MAC. The mgmt
  network is a private L2: control-node 10 GbE + each switch's 1 GbE mgmt port via
  a small management switch.
- **The fabric is declarative config.** The three Midori VPCs (bgp / internal /
  storage) and each server's **server↔leaf Connection** (unbundled / bundled-LAG /
  ESLAG) become wiring-diagram + VPCAttachment objects — the same VPCs we built by
  hand for the VMs, now modeled. `hhfab build` assigns switch IPs and ASNs.

### Plane 2 — the servers (we build this)

Hedgehog **models** servers but does **not** install their OS. It knows a server
exists and how it's cabled (so it can attach VPCs), but OS + k3s + drivers + gVisor
are ours. So we add a server-provisioning plane, driven from the router over OOB:

1. **BMC control** — Redfish (preferred) or IPMI to each server's BMC: set one-time
   boot to network / virtual-media and power-cycle. Hedgehog already uses BMC
   virtual-media to install its own control node and "gateway node," so the OOB
   reach and pattern exist.
2. **OS install** — PXE/iPXE → a base **Ubuntu 24.04** image + `cloud-init`.
3. **Node bootstrap** — `cloud-init` hands off to a role-parameterized bootstrap
   that runs today's `SETUP.md` steps automatically (below).

**DHCP coexistence (watch this):** the control node already runs DHCP on the mgmt
network for switch ZTP, and that network is meant to be *exclusive*. Put the server
**BMCs + boot NICs on a separate provisioning segment** (or a filtered proxyDHCP
answering only known server MACs) so our PXE/DHCP never races Hedgehog's ZTP.

### Provisioner choice

Decouple "get Ubuntu + cloud-init onto the disk" (the provisioner) from "turn it
into a midori node" (the bootstrap). The bootstrap is the same work either way and
dominates the effort.

- **Tinkerbell (recommended).** k8s-native, runs on the control node's k3s (or a
  sibling) — matches Hedgehog's model and the "deploy from the router" idea. Rufio
  drives Redfish/IPMI, Smee does DHCP/iPXE, Hook is the in-memory installer, Tink
  workflows stream the image + write cloud-init. Its declarative Hardware objects
  mirror Hedgehog's declarative servers. Best for repeatability and growth.
- **Metal3 + Ironic (+ Cluster API).** Full bare-metal lifecycle; CAPI has a k3s
  bootstrap provider. Heavier — choose only if we want CAPI-managed node lifecycle.
- **MAAS.** Mature, but a large separate appliance, not k8s-native — another
  control plane to run.
- **Minimal iPXE + Ubuntu autoinstall + cloud-init.** Fewest moving parts; very
  viable at our ~7–10-node scale. Least inventory/lifecycle tooling; the pragmatic
  fallback if Tinkerbell is more than we want to operate.

### The node bootstrap (automating SETUP.md)

The piece that must exist regardless of provisioner: a role-parameterized bootstrap
(cloud-init + a script or Ansible derived from `SETUP.md`), keyed by role — `cp`,
`nv-gpu`, `amd-gpu`, `eye`:

- **base:** pin the kernel + headers (GHOST modules build out-of-tree; an
  unattended kernel bump silently breaks every GPU pod), chrony, `registries.yaml`.
- **k3s:** server (`--cluster-init` / join) or agent with the midori flags
  (flannel / kube-proxy / servicelb off), taints + labels.
- **Cilium** from `cilium-values.yaml` — **`socketLB.hostNamespaceOnly: true` must
  survive** (the gVisor invariant) — plus the containerd CNI drop-in.
- **GPU nodes:** the 610.43.02 driver + GHOST modules, runsc + the containerd runsc
  drop-in (incl. `pod_annotations = ["dev.gvisor.*"]`), `runsc-gpu-scheduler`,
  HAMi, the quota webhook.
- **fabric netplan** — but now the fabric NIC(s) are the node's **primary** network
  (no Neutron `ens3`): node IP, default route and the Cilium dataplane all live on
  fabric VPCs. This is the real change from the VM stopgap.

## Networking on bare metal

No Neutron, no `ens3`. Each server's NIC(s) attach directly to leaf switches; the
Midori VPCs become server attachments:

- a **node/cluster VPC** carries node IPs + etcd (new — Neutron's `ens3` did this in
  the VM world);
- `midori-bgp` carries the Cilium-BGP peering + external LB VIPs (router0 stays the
  BGP edge, or a Hedgehog **gateway node** takes it over);
- `midori-storage` carries CephFS (already proven over `.108`);
- Cilium flips to **native routing** (`routingMode: native`, `autoDirectNodeRoutes`
  or PodCIDR-over-BGP) with jumbo end-to-end — the `NETWORKING-BAREMETAL.md`
  appendix, now active. socketLB, the CNP tenant floor, platform-guard, gVisor and
  the tenant controller are unchanged.

## Hardware & OOB requirements — VERIFY

1. **Server BMCs:** each compute server needs a BMC reachable from the router over
   OOB, ideally **Redfish** (IPMI works). Confirm make/model and that virtual-media
   or PXE boot is BMC-controllable. Without automated BMC control, provisioning is
   manual (console + USB) — fine for a pilot, not for a fleet.
2. **Mgmt / OOB topology:** a management switch for the fabric switches' 1 GbE mgmt
   ports + control-node 10 GbE (Hedgehog's exclusive mgmt net), **plus** a
   provisioning segment for server BMCs + boot NICs (kept off Hedgehog's ZTP DHCP).
3. **Compute servers:** UEFI boot (Hedgehog control node is UEFI-only; keep the
   fleet UEFI), **IOMMU/VT-d on** (real GPU passthrough + the DU-fronthaul VFIO
   work), the GPUs (NVIDIA A6000 / AMD R9700), ≥ 500 GB disk, the fabric NICs.
4. **The router's roles:** today one box is implied to be Hedgehog control node +
   BGP edge (router0 / BIRD, AS 65253) + internet gateway + (now) provisioning host.
   Decide whether to keep that consolidated or split the control node (a fixed
   Flatcar appliance) from the BGP/NAT edge and the provisioner.

## Decisions to make

- **Provisioner:** Tinkerbell vs Metal3/CAPI vs MAAS vs iPXE+autoinstall.
- **Colocation:** provisioner on the control node's k3s, or a sibling box? (The
  control node is a fixed Flatcar appliance; a sibling may be cleaner.)
- **BGP edge:** keep router0/BIRD, or move the external edge onto a Hedgehog
  gateway node?
- **k3s vs k8s:** keep k3s (consistent with today and with Hedgehog's own control
  node).
- **Bootstrap form:** cloud-init + shell, Ansible, or a prebaked image. (Ansible
  from `SETUP.md` is the most legible and reusable.)

## Phased rollout

1. **Model the fabric:** wiring diagram (switches, servers, connections) + the
   Midori VPCs; `hhfab build`; stand up the control node on the router; ZTP the
   switches; verify the fabric with no servers yet.
2. **Stand up server provisioning:** the provisioner on the provisioning net;
   inventory servers (BMC creds, MACs); prove BMC power + PXE on one server.
3. **Build the node bootstrap:** automate `SETUP.md`, role-parameterized; test it
   **in a VM first** (we have those) so the logic is proven before the metal.
4. **Pilot one GPU server end-to-end:** provision → k3s agent join → driver + GHOST
   + runsc + HAMi → fabric attach → run the gVisor/GPU + CephFS smoke tests.
5. **Roll out the rest;** bring tenants up on the bare-metal cluster.
6. **Migrate workloads off the VMs,** then decommission the VM substrate.

## What I need from you

- The **server BMC** type (Redfish?) and whether OOB reaches every server's BMC.
- **Switch + server counts / models** (to write the wiring diagram) and the
  server↔leaf cabling (unbundled / LAG / ESLAG).
- Is the **router** the Hedgehog control node itself, or a separate box hosting it?
  And does router0/BIRD stay the BGP edge, or move to a Hedgehog gateway node?
- **Provisioner** preference — or I detail Tinkerbell as the recommended path.
