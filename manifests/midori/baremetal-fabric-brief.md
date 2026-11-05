# Bare-metal Midori: fabric & bootstrap — discussion brief

Prep for the discussion with Samir. Goal: agree the **networking + bootstrap
architecture** for reinstalling Midori on bare metal before we commit, focused
on the **Cilium ⇄ Hedgehog boundary** and the **bootstrap failure domains**.
Companion to `NETWORKING-BAREMETAL.md` (which still assumes an OpenWRT-BGP edge
and needs revising once the questions below are settled — see §5).

Some of §1 is inferred from the rack diagram; items flagged **(confirm)** are
assumptions to check with Samir.

## 1. Background — how it's wired

**The seed.** The **minisforum phoenix router (`router-0-host`)** is a single
mini-PC that bootstraps everything *without the production fabric existing*. It
hosts three VMs:
- **`router-0` (OpenWRT)** — DHCP/DNS/NAT + gateway for OOB/mgmt/provision,
  riding the **1GbE OOB switches** (Penguin arctica-4804iq, DGS-1210-28, NetGear
  M4300, Qnap QSW) — a fabric-independent L2 layer **(confirm)**.
- **`deployment`** (former aiso-maintenance) — PXE-installs the servers.
- **`hedgehog0`** — the Hedgehog fabric controller.
It has its own internet uplink, independent of the fabric.

**The fabric.** Two **Dell S5232F-ON** leaves (`front-leaf-0/1`, 100GbE) run
Hedgehog SONiC; **Hedgehog (`hedgehog0`)** programs them (eBGP + EVPN/VXLAN
underlay; tenant nets as VPCs). Servers (3× storage, 2× gpu, 3× control) are
dual-homed to both leaves at 100G.

**Bootstrap chain (breaks the chicken-and-egg):**
```
seed (internet + OpenWRT + OOB) → OOB 1G switches → hedgehog0 reaches leaf
mgmt over OOB → Hedgehog ONIE-installs SONiC + pushes fabric config → 100G
fabric up → deployment PXE-installs servers → k8s + Cilium → tenant VPCs
```
The fabric is always brought up **through the OOB network, never through
itself.**

**Address / VLAN plan (from the diagram):**
```
VLAN 99     reserved, BF-2 (BlueField-2 DPU) testing
VLAN 101    frontend       10.30.0.0/16
VLAN 102    provision      10.31.0.0/16
VLAN 103    control plane  10.32.0.0/16   (rides the front-end 100G)
VLAN 1000-2999  tenant networks  10.40.0.0/16   (Hedgehog VPCs)
VLAN 3000-4095  reserved by fabric
172.24.0.0/24   management     172.24.255.0/24  OOB management
```

**Multi-site:** `mido-tyo-router` (office OpenWRT) + LTE `mido-tyo-cell` are the
TYO path / cellular backup **(confirm: mgmt-only failover, or also a data/ingress
path?)**. Ties to the CephFS-direct-TYO decision.

## 2. What stays / changes / is new

| | |
| --- | --- |
| **Unchanged** | Cilium CNI + `kubeProxyReplacement`, `socketLB.hostNamespaceOnly` (gVisor), the NetworkPolicy/CNP tenant floor + `platform-guard`, gVisor GPU slicing, the tenant controller. The whole in-cluster story. |
| **Changes** | Overlay → native routing; Octavia/OCCM + FIPs → fabric BGP + routable VIPs; Neutron SGs → host nftables + fabric/border firewalling; Octavia HA → BGP/ECMP (fabric) HA. |
| **New (no OpenStack analog)** | Hedgehog-managed SONiC fabric (EVPN/VPCs); the minisforum seed + OOB bootstrap; PXE provisioning pipeline; we own switch lifecycle. |

## 3. Open questions (the agenda)

**A. Cilium ⇄ Hedgehog boundary — the big one.**
- Does a **midori tenant map to a Hedgehog VPC** (hardware L2/L3 segmentation per
  tenant on the fabric), or do all pods live in **one frontend VPC** with Cilium
  doing *all* tenant isolation (as today)?
- Who is the **default gateway / L3** for the frontend subnet — the leaves'
  anycast gateway, or Cilium?
- Does Cilium run **native routing + BGP-peer the leaves** (advertise LB VIPs,
  maybe PodCIDRs into EVPN), or stay overlay on top of a flat VPC?

**B. Public IPs & ingress.**
- Where does the public prefix land — **terminate at the border (OpenWRT) and
  route in**, or **advertise all the way to the leaves** so VIPs are native in
  the fabric?
- LB-IPAM pool size/placement; DSR for source-IP; the pending public-gateway TLS
  (task #28) rides on this.
- Kube-API VIP: kube-vip, or a fabric/anycast VIP? (Node→API already survives via
  k3s's client-side LB on `127.0.0.1:6444`.)

**C. Bootstrap failure domains / day-2.**
- `hedgehog0` + `router-0` + `deployment` all on **one mini-PC**. Running fabric
  survives its loss (SONiC keeps last config), but we lose config changes,
  OOB/BMC, provisioning, mgmt-internet. **Acceptable, or HA the seed / migrate
  Hedgehog into the cluster once up?**
- **`hedgehog0` "tap port only" (DGD-590)** — what does it currently block, and
  is it on the critical path?

**D. Provisioning & lifecycle.**
- PXE/DHCP/TFTP/image source over the provision VLAN — deployment VM owns it?
- SONiC/Hedgehog upgrade story; who owns switch firmware day-2.

**E. Migration.**
- **Reinstall fresh vs. in-place** (we're leaning reinstall). Ceph/CephFS data
  migration plan; tenant downtime window; parallel build vs. cutover.

**F. Parked?**
- BF-2/DPU (VLAN 99) offload — in scope for v1 or explicitly later?

## 4. Tradeoffs (framed for a decision)

**Tenant isolation: Hedgehog VPC-per-tenant vs. Cilium-only.**
- *VPC-per-tenant:* hardware segmentation, smaller blast radius, fabric-level
  multi-tenancy. Cost: controller must drive Hedgehog CRDs (VPC/VPCAttachment)
  per tenant → tighter coupling, more moving parts, a new failure dependency in
  the tenant create path.
- *Cilium-only (flat VPC):* simplest, reuses the isolation model + deny-floor we
  already run and trust; fabric stays static. Cost: no hardware segmentation; all
  isolation is software (eBPF) — one layer, not defence-in-depth.
- *Lean:* start Cilium-only (we already have it working end-to-end), add
  VPC-per-tenant later only if we need hardware segmentation — but decide now so
  the controller API doesn't have to change twice.

**Routing: native + BGP-to-leaves vs. keep overlay.**
- *Native + BGP:* jumbo MTU (helps CephFS + DU-fronthaul), DSR/source-IP,
  routable VIPs, ECMP HA — the whole reason for the move. Cost: real coupling to
  the fabric's BGP/EVPN; more to get right at cutover.
- *Overlay on a flat VPC:* least fabric coupling, closest to today. Cost: throws
  away most of the bare-metal benefit (still capped MTU, no DSR).
- *Lean:* native + BGP — it's the point of the exercise.

**Hedgehog control-plane location.**
- *On the seed (today):* simplest bootstrap. Cost: SPOF for fabric mgmt.
- *In-cluster after bring-up:* HA + co-located. Cost: circular dependency
  (fabric mgmt depends on the fabric it manages) — needs careful break-glass.
- *Separate small HA pair:* cleanest day-2. Cost: more hardware.

**Public-IP termination: border vs. fabric.**
- *Border (OpenWRT):* one controlled choke point, easy NAT/firewall. Cost: a
  software router in the data path; less ECMP.
- *Fabric (advertise to leaves):* line-rate, native ECMP, no NAT. Cost: public
  space inside the fabric; tighter LB-IPAM/BGP policy needed.

## 5. After the meeting
Once A–B are decided, revise `NETWORKING-BAREMETAL.md`: replace the
OpenWRT-as-BGP-peer model with **Cilium peering the SONiC leaves, OpenWRT as
border/bootstrap**, and document the chosen Hedgehog-VPC-vs-Cilium ownership
split.
