# Bare-metal deployment design — provision from the router

> First cut, revised 2026-11-17 after reading `phoenix-inventories/phoenix/tyo`.
> **Framing: midori is a product meant to deploy on *fresh* bare-metal
> environments.** TYO is where it's developed and is a fully-modeled reference
> environment, but the product can't assume TYO's OpenStack/Ironic exists — it must
> ship its own provisioning. So the provisioner question below is a real
> comparison (Tinkerbell vs Ironic/Metal3), not "reuse what's there." Open
> decisions remain; this is the architecture to react to.

## Why — bare metal is the goal, the VMs are a stopgap

midori is **designed for bare metal**; it runs in OpenStack VMs today only because
no suitable bare-metal environment was available. The recent fabric work (the three
Midori VPCs, Cilium BGP to router0, CephFS over the storage VLAN —
`FABRIC-BRINGUP.md`, `NETWORKING-BAREMETAL.md`, `ceph-csi/README.md`) gave the VMs
*direct* fabric access: progress, and a dress rehearsal — the Cilium-BGP / LB-IPAM
/ CephFS edge we proved works unchanged on metal.

What bare metal unlocks: no Neutron overlay tax (native routing, jumbo end-to-end,
DSR / source-IP, routable VIPs, BGP/ECMP HA), **real GPU passthrough without the
VM's VFIO ceiling** (`gvisor-du-fronthaul` note), and full NUMA/NVLink visibility.

## The TYO reference environment (from phoenix-inventories)

Already deployed and declaratively managed — the product's bring-up must *produce*
an environment like this, so it's the reference:

- **Router appliance** `router0` (mgmt `172.20.0.252`) runs two VMs: the **OpenWRT**
  router (DHCP/TFTP, firewall, WAN via Intel X550, frontend uplink via X710 to the
  leaves) and the **Hedgehog control node** (`172.20.0.249`, Flatcar, `core`). This
  is the "router" we deploy from.
- **Hedgehog fabric:** two **Dell S5232F-ON** SONiC leaves (`frontend-leaf0/1`,
  EVPN/VXLAN, VTEPs on `172.30.x`); every server **dual-homed ESLAG** to both.
- **Servers** (bare metal, today running OpenStack/kolla + Ceph): `control0/1/2`
  (control), `gpu0/1` (compute — 2× A6000 + a **BlueField-2** DPU each), `storage0/1/2`
  (Ceph). All have **IPMI BMCs** on an OOB net (`172.20.1.0/24`); PXE on a ConnectX-6
  Dx port. Per-host MACs/BMC IPs/creds live in phoenix-inventories (not copied here).
- **Fabric VPCs** (VLAN-tagged, one IPv4 namespace):

  | VPC | CIDR | VLAN | role |
  | --- | --- | --- | --- |
  | pxe | 10.50.0.0/16 | 100 | iPXE/DHCP (native/untagged on server links) |
  | operator | 10.30.0.0/24 | 101 | infra / API |
  | provision | 10.31.0.0/16 | 102 | bare-metal provisioning |
  | management | 10.32.0.0/16 | 103 | control-plane mgmt |
  | storage | 10.33.0.0/24 | 105 | Ceph |
  | midori-bgp | 10.100.0.0/24 | 106 | Cilium BGP + external VIPs |
  | midori-int | 10.100.1.0/24 | 107 | reserved |
  | midori-stor | 10.100.2.0/24 | 108 | CephFS |

- **Provisioning today = OpenStack Ironic**, over `pxe` (VLAN 100, native/untagged so
  iPXE gets DHCP) + `provision` (VLAN 102); the OpenWRT VM serves DHCP/TFTP on VLAN
  100. The Midori VMs currently reach the fabric via BlueField-2 SR-IOV VFs tagging
  VLANs 106–108 — the indirection bare metal removes.

## The deploy-from-the-router model

Your instinct is exactly the shape: the **router appliance hosts the Hedgehog
control node**, which provisions the **switches** (ZTP over the OOB mgmt net — ONIE,
DHCP/HTTP, keyed on serial/MAC) and programs the **fabric** (VPCs, server↔leaf
attachments) declaratively. That half is Hedgehog's and already works.

The **servers** are the open half: Hedgehog *models* servers (so it can attach VPCs)
but **does not install their OS** — "the configuration of the actual server needs to
be done by the server administrator." So the product supplies a server-provisioning
plane that runs **on / beside the control node** and drives each server's BMC +
PXE → Ubuntu + cloud-init → our node bootstrap. That plane is the decision below.

### The node image + bootstrap (provisioner-agnostic — build this regardless)

Whatever provisions the metal, it ends at the same handoff: **Ubuntu 24.04 + a
role-parameterized bootstrap** (cloud-init → a script or Ansible derived from
`SETUP.md`), keyed by role (`cp`, `nv-gpu`, `amd-gpu`, `eye`):

- base: pin kernel + headers (GHOST builds out-of-tree; an unattended bump breaks
  every GPU pod), chrony, `registries.yaml`.
- k3s: server (`--cluster-init` / join) or agent with the midori flags
  (flannel / kube-proxy / servicelb off), taints + labels.
- Cilium from `cilium-values.yaml` — **`socketLB.hostNamespaceOnly: true` must
  survive** (the gVisor invariant) — plus the containerd CNI drop-in.
- GPU nodes: 610.43.02 driver + GHOST modules, runsc + the containerd runsc drop-in
  (incl. `pod_annotations = ["dev.gvisor.*"]`), `runsc-gpu-scheduler`, HAMi, the
  quota webhook.
- the **fabric netplan** — now the server's own NICs are the *primary* network (no
  Neutron `ens3`, no BlueField-VF/VM indirection): node IP, default route and the
  Cilium dataplane live on fabric VPCs.

Because this is provisioner-agnostic, **it can be proven *now* on TYO's existing
Ironic** while the product provisioner is chosen separately — the choice doesn't
block progress.

## Provisioner options (the product decision)

Requirement for a product on fresh environments: ship a provisioner that is
**self-contained, k8s-native (rides the Hedgehog control node's k3s), declarative,
drives Redfish/IPMI, and ends at Ubuntu + cloud-init** — ideally with firmware/BIOS
control for GPU/DPU servers (IOMMU, SR-IOV, secure-boot). Two real contenders, plus
the TYO-only shortcut:

### Option A — Tinkerbell
k8s-native: Hardware / Template / Workflow CRDs; **Smee** (DHCP/iPXE), **Hook**
(in-memory installer), **Tink** (workflow engine), **Rufio** (BMC: Redfish/IPMI
power + boot). Deploys as a helm release on the control node's k3s. Workflows stream
an OS image and write cloud-init.
- **For:** lightest footprint; cleanest "ship with the fabric" fit; CNCF; its
  declarative Hardware objects mirror Hedgehog's declarative servers; greenfield-
  friendly (its Smee *is* the DHCP, no external dependency).
- **Against:** firmware/BIOS/RAID management is minimal (scriptable via actions, not
  first-class); younger/smaller ecosystem than Ironic; in TYO specifically its Smee
  DHCP would collide with OpenWRT's existing PXE, so TYO dev would isolate it or use
  Ironic there.

### Option B — Metal3 (Ironic engine, k8s-native)
**BareMetalHost** CRDs + optionally Cluster API, with the **Ironic** engine
(ironic-python-agent ramdisk writes a whole-disk image + configdrive/cloud-init)
running *in-cluster* — Ironic's hardware muscle without a full OpenStack.
- **For:** strong, broad BMC/**Redfish BIOS/RAID/firmware** automation (real for GPU
  servers: IOMMU, SR-IOV, secure-boot, NUMA); mature provisioning engine; declarative
  + CAPI (there's a k3s bootstrap provider); portable (runs on k3s, no OpenStack).
- **Against:** heavier than Tinkerbell (Ironic + a DB + the IPA ramdisk); more moving
  parts to ship and operate.

### Option C — reuse TYO's OpenStack Ironic (dev shortcut only)
The existing pipeline already images control0-2 / gpu0-1 over the fabric.
- **For:** zero build; fastest way to validate the node image/bootstrap *today* in
  TYO.
- **Against:** **not a product form** — it drags the whole OpenStack control plane,
  which fresh environments won't have. Use it to prove the bootstrap, not to ship.

### Comparison

| | Tinkerbell | Metal3 (Ironic+k8s) | TYO OpenStack Ironic |
| --- | --- | --- | --- |
| Model | Hardware/Workflow CRDs + Rufio | BareMetalHost CRDs + CAPI, Ironic | OpenStack Nova/Ironic API |
| Runs on | control node k3s | k3s (in-cluster) | full OpenStack |
| Footprint | **light** | medium | heavy |
| BMC (Redfish/IPMI) | yes (Rufio) | yes (broad Ironic drivers) | yes |
| Firmware/BIOS/RAID | minimal | **strong** | strong |
| OS install → cloud-init | Hook streams image | IPA whole-disk + configdrive | IPA |
| Declarative / GitOps | strong | strong (CAPI) | weak |
| Portable to fresh envs | **excellent** | good | **no** |
| Ship with the product | **best fit** | good | no |

**Recommendation:** **Tinkerbell** as the product provisioner — lightest, cleanest
fit on the Hedgehog control node, greenfield-native. Fall back to **Metal3** if
firmware/BIOS/RAID automation or Ironic's driver breadth turns out to be a hard
requirement for the GPU/DPU servers (that's the main thing Tinkerbell makes you
script). Use **TYO's Ironic** only as the throwaway path to validate the node
image/bootstrap now. Since the bootstrap is provisioner-agnostic, we lose nothing
by proving it on Ironic while building the Tinkerbell path for the product.

## Networking on bare metal

No Neutron, no `ens3`, no BlueField-VF/VM indirection. Each server's own NICs carry
the fabric VLANs; the node attaches to:

- a **node/cluster network** for node IPs + etcd (the `operator`/`management` VPC, or
  a dedicated one);
- `midori-bgp` (106) for Cilium-BGP + external LB VIPs (router0/BIRD stays the BGP
  edge, or a Hedgehog gateway node takes it);
- `midori-stor` (108) for CephFS (proven);
- `pxe` (100) + `provision` (102) during install only.

Cilium flips to **native routing** (`routingMode: native`, `autoDirectNodeRoutes` or
PodCIDR-over-BGP) with jumbo end-to-end — the `NETWORKING-BAREMETAL.md` appendix,
now the active plan. socketLB, the CNP tenant floor, platform-guard, gVisor and the
tenant controller are unchanged.

## The big decision: which servers, and OpenStack coexistence

In TYO these servers run OpenStack+Ceph today, and midori runs as VMs on them.
Bare-metal midori needs servers **not** in the OpenStack compute role:

- **Reclaim gpu0/gpu1** (the two GPU hypervisors) → bare-metal midori GPU nodes:
  direct A6000 access, real VFIO (unblocks DU-fronthaul), no VM tax. Highest value;
  cost is those hosts leave the OpenStack pool and their midori GPU VMs must move or
  retire.
- **Reclaim control0-2** too → full bare-metal midori; bigger displacement.
- **Dedicated servers** on the fabric for bare-metal midori — cleanest, needs
  hardware. For the *product*, this is the normal case (a fresh fleet).

## Phased rollout

1. **Build the node image + bootstrap** (automate `SETUP.md`, role-parameterized);
   test it **in a VM first** (we have those) so the logic is proven before metal.
2. **Validate on metal via TYO Ironic** — Ironic-deploy one target server with the
   image, run the bootstrap, confirm k3s join + GPU + gVisor + CephFS. Proves the
   image independent of the product provisioner.
3. **Stand up the product provisioner** (Tinkerbell) on the control node; re-drive
   the same image/bootstrap through it on an isolated segment or a fresh server.
4. **Pilot a full bare-metal GPU node** end-to-end through the product path; attach
   the Midori VPCs; run the gVisor/GPU + CephFS smoke tests.
5. **Roll out; migrate tenants; retire the VM layer.**

## What I need from you

- **Which servers** become bare-metal midori nodes, and the OpenStack coexistence
  call (reclaim gpu0/1? dedicated fleet?).
- Confirm the provisioner direction: **Tinkerbell for the product** (with Ironic as
  the dev-validation shortcut), or do you want Metal3 evaluated more deeply for the
  firmware/BIOS angle?
- Access to the **node-image build** phoenix uses with Ironic (repo/path), so the
  bootstrap adapts an existing image rather than starting cold.
