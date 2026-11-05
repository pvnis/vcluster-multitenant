# Midori networking rework — infrastructure change handoff

**For:** the infra / network / virtualization engineers making the host, VM, vNIC
and fabric changes.
**Status:** proposed. Items marked **[confirm]** are values we still need from you
or decisions still open (collected in §7).

## 1. What we're doing, in one paragraph

We keep Midori on its **existing VMs** (no reinstall), but move their **data-plane
networking onto the Hedgehog SONiC fabric**. Each node VM gets a **Virtual Function
(VF) off the Mellanox ConnectX-6, passed through via SR-IOV/VFIO**, landing in a
**dedicated Hedgehog VPC** for Midori (VF VLAN → VPC mapping). A **public /24**
(Samir to assign) is routed to the cluster over **BGP**. The **minisforum router
forwards Internet traffic unfiltered** — there is no perimeter firewall, so **all
security is enforced in-cluster by Cilium + the Cilium host firewall** (§6). This
minimizes disruption while giving fabric-native performance and routable public
IPs.

## 2. The nodes that need the new vNICs

Seven VMs (current mgmt IPs for reference):

| VM | role | current IP |
| --- | --- | --- |
| midori-cp-0 / -1 / -2 | control plane + etcd (HA) | 10.30.30.31 / .48 / .142 |
| midori-nv-0 / -1 | NVIDIA GPU nodes | 10.30.30.226 / .54 |
| midori-amd-0 | AMD GPU node | 10.30.30.160 |
| midori-eye-0 | observability | 10.30.30.204 |

Each gets **one VF vNIC** on the Midori VPC as its data-plane interface, plus a
**separate management/OOB NIC** (kept as today).

## 3. Changes by area

### A. Hedgehog fabric & VPC — *network team*
- Create a **dedicated Midori VPC**.
- Define the **VLAN(s)** that map into that VPC and give us the **VLAN IDs** we tag
  the VFs with.
- Subnet(s) inside the VPC for the node data-plane network (**[confirm]** CIDR;
  stays private — see §4).
- Accept the **BGP sessions** from the nodes and **route/advertise the public /24**;
  advertise it upstream (**[confirm]** under existing APNIC AS55393, or not).

### B. Hypervisor hosts — ConnectX-6 / SR-IOV — *host team*
- Enable **IOMMU**: BIOS VT-d/AMD-Vi + kernel `intel_iommu=on` / `amd_iommu=on
  iommu=pt`, and bind `vfio-pci`.
- Enable **SR-IOV** on the CX-6 and create **N VFs per host** (**[confirm]** count
  and host→VM mapping).
- Per-VF config: **VLAN tag = the Midori VPC VLAN**; **MTU** to match the fabric
  (jumbo 9000 if we go that way — **[confirm]**); **trust on / spoofchk** set so the
  guest's Cilium dataplane can source pod traffic (**[confirm]** — depends on
  overlay vs. native routing, §5; anti-spoof will drop pod IPs if we run native).
- Reserve the VFs for the Midori VMs.

### C. VMs — *virtualization team*
- Attach **one VF** (PCI passthrough / SR-IOV port) to each of the 7 VMs as the
  data-plane NIC.
- Keep the existing **mgmt/OOB NIC** separate — management must **not** ride the
  public/data path.
- Set the VM NIC **MTU** to match the fabric.
- **[confirm]** whether the current Neutron/VXLAN NIC (`ens3`) is retained for
  management or removed.

### D. Addressing / VLANs / public IPs
- **Nodes and pods stay private** (VPC data-plane VLAN for nodes; pods on
  10.42.0.0/16 internally). Do **not** put node IPs on public space.
- The **public /24 is used only for LoadBalancer VIPs**, advertised at **VIP
  granularity** over BGP — not node or pod CIDRs. This is the main thing that keeps
  the "unfiltered router" from exposing the whole cluster.

### E. BGP — *network team + us*
- **Private ASN** for the Cilium ↔ fabric peering (**[confirm]** value in
  64512–65534, or a 32-bit private ASN).
- Peering: nodes peer the **leaf anycast gateway** (**[confirm]** peer addresses).
- Cilium advertises **LB VIPs only**; the fabric routes the /24 and northbound.

### F. Minisforum router — *network team*
- Pass **Internet unfiltered** to the fabric/VPC and **route the public /24** in.
- Keep mgmt/OOB routing as today.
- **No packet filtering** — this is deliberate; the cluster secures itself (§6).

## 4. Rollout — disruption & sequencing

**Fully non-disruptive? Not on the SR-IOV path — there are two unavoidable windows.**
OpenStack **cannot hot-attach an SR-IOV (`vnic_type=direct`) port to a running
instance** — Nova rejects it; the VF must be present **at instance creation**. So
each node VM must be **recreated with its SR-IOV port**: boot-from-volume → same root
volume, node state survives; ephemeral → the node rebuilds and rejoins k8s
(**[confirm]** which). Separately, **if the compute hosts don't already run SR-IOV**,
enabling IOMMU is a kernel-cmdline change → **host reboot**, and changing
`sriov_numvfs` on an in-use PF can bounce it (**[confirm]** whether SR-IOV is already
in use on these hosts).

**Cluster-level disruption can still be near-zero** via a rolling, one-VM-at-a-time
replacement (the control plane is 3× HA etcd):

1. `cp-0` → `cp-1` → `cp-2`, one at a time, waiting for **etcd quorum healthy**
   between each → no API downtime.
2. `eye-0` → a brief monitoring gap only.
3. `nv-0` → `nv-1` → `amd-0` → only the GPU tenants on the node being replaced see a
   window; the rest keep running.

Drain the node, recreate the VM with the SR-IOV port, rejoin, next.

**Fully non-disruptive alternative — virtio first.** A **normal virtio Neutron port
on the Midori VPC *can* be hot-attached to a running VM** (`openstack server add
port`, live). That moves every node onto the fabric with **zero downtime**, at the
cost of SR-IOV's line-rate / kernel-bypass. It enables a decoupled rollout:
- **Phase 1 (zero downtime):** hot-attach virtio ports on the VPC; migrate the
  dataplane onto the fabric live.
- **Phase 2 (scheduled):** swap to SR-IOV VFs node-by-node for performance, when
  convenient — not a prerequisite.

**Decision needed:** is SR-IOV line-rate/bypass required on day one, or is getting
Midori onto the VPC the priority? If the latter, go **virtio-first** and treat
SR-IOV as a later rolling step.

## 5. What we (the cluster team) own — for your awareness

Because the router does not filter, we will:
- Enable the **Cilium host firewall** (currently off) and **default-deny** the
  nodes' host namespace, allowing only intra-cluster + admin traffic.
- Keep **control-plane ports on the private VLAN only** — API 6443/6444, etcd
  2379–2380, kubelet 10250, konnectivity, SSH — never reachable from the Internet.
- Expose **only the gateway VIP(s)** publicly; everything else stays internal.
- Keep our existing per-tenant Cilium isolation (deny-floor + platform-guard).

**Two asks of infra from this:** keep **BMC/OOB strictly on the OOB network**, never
the public path; and confirm nothing in the host/VM config publishes the node
management interfaces to the /24.

## 6. Why the VF detail matters (so filtering lands in the right place)

The VF is passed **straight into the guest**, bypassing any hypervisor vSwitch — so
there is **no host-level packet filtering outside the VM**. All filtering is
in-guest (Cilium + host firewall). That's fine and intended, but it means the
**VF trust/spoofchk/MTU settings must let the guest run its own dataplane** (set
pod MACs/IPs, jumbo frames). If we run Cilium in **native routing** (advertising pod
CIDRs), the fabric/VF must **not** anti-spoof the pod source IPs; if we keep the
**VXLAN overlay**, pod traffic is encapsulated under the node's own IP/MAC and
anti-spoof is less of an issue. **[confirm]** which we're doing — it changes the VF
config.

## 7. Security model (summary)

No perimeter firewall → **deny-by-default inside the cluster**: Cilium host firewall
on the nodes, clusterwide default-deny for workloads, egress allow-listing
(DNS/FQDN), and only the gateway VIP public. Hedgehog VPC gives an additional
fabric-level boundary from other environments on the shared fabric. Post-cutover we
scan the /24 from outside to prove only the intended VIP:443 answers.

## 8. What we need from you — checklist

- [ ] Public **/24** assigned to Midori (Samir)
- [ ] **Private BGP ASN** + leaf **peer addresses**
- [ ] Midori **Hedgehog VPC** created + **VLAN→VPC mapping** (give us the VLAN IDs)
- [ ] **SR-IOV enabled**, **N VFs/host** created, **IOMMU on** — or confirm already in use
- [ ] VFs **attached to the 7 VMs** (via recreate — see §4), VLAN-tagged, trust/spoofchk + **MTU** set
- [ ] **Jumbo MTU** end-to-end? (yes / no)
- [ ] **BMC/OOB** confirmed on the OOB network, **not** the public path
- [ ] Overlay vs. **native routing** decision (drives VF anti-spoof config)
- [ ] `ens3` (Neutron NIC) kept for mgmt or removed?
- [ ] Nodes **boot-from-volume or ephemeral?** (determines recreate impact, §4)
- [ ] **SR-IOV day one, or virtio-first** then SR-IOV later? (§4 — disruption vs. performance)

Once §8 is settled we'll enable the host firewall + BGP/LB-IPAM on the cluster side
and run the from-outside verification.

## Appendix A — Virtio path (the zero-downtime option, §4 Phase 1)

The fabric VPC **and** the host uplink are needed either way; virtio only changes
the **last hop** — how the VM attaches to that uplink. SR-IOV passes a VF straight
into the guest (bypass, boot-time only); virtio bridges a tap through the host L2
agent onto the **same** uplink (hot-pluggable). So nothing here is wasted if we later
switch to SR-IOV.

**Data path:**
```
guest virtio NIC → tap → OVS/linuxbridge on the host (tags VLAN X)
  → ConnectX-6 trunk uplink → leaf port (Midori VPC VLAN X) → Hedgehog VPC
```
Neutron does **L2 only** (tags the VLAN, hands frames to the fabric). **Hedgehog owns
L3** (anycast gateway, and DHCP if wanted); k8s nodes use **static/fixed IPs**.

**Fabric side — Hedgehog / network team (shared with the SR-IOV path):**
1. Create the Midori VPC.
2. VPCAttachment/Connection → put **VLAN X** on the leaf ports the hypervisors cable
   to (tagged).
3. Give us: VLAN ID, node subnet/CIDR, gateway, DHCP vs static.

**Host + OpenStack side — the virtio-specific part:**
4. ConnectX-6 uplink to the leaf = **trunk** carrying VLAN X (bond/LACP as
   applicable). In virtio this PF is the **trunk uplink to the L2 agent**, not a VF —
   no IOMMU, no VFs.
5. Neutron ML2:
   - add `physnet_fabric` to `network_vlan_ranges` (e.g. `physnet_fabric:X:X`);
   - per compute host's L2 agent — OVS: `bridge_mappings = physnet_fabric:br-fabric`
     (create `br-fabric`, add the uplink); linuxbridge:
     `physical_interface_mappings = physnet_fabric:<uplink>` (**[confirm]** which agent);
   - restart `neutron-server` + the L2 agents (existing VM ports keep running).
6. Provider VLAN network (admin), shared to the Midori project:
   ```
   openstack network create midori-fabric \
     --provider-network-type vlan \
     --provider-physical-network physnet_fabric \
     --provider-segment X --share
   ```
7. IPAM: either **no subnet / DHCP off** (Hedgehog owns it), or a subnet
   `--no-dhcp` with gateway = the VPC anycast GW, nodes on fixed IPs.
8. Per node — create a virtio port, then **hot-attach to the running VM (live, no
   reboot):**
   ```
   openstack port create --network midori-fabric \
     --fixed-ip subnet=<sub>,ip-address=10.x.x.x nodeN-fabric
   openstack server add port <vm> nodeN-fabric
   ```
9. In the guest: bring up the new virtio interface (netplan/udev), set IP + MTU.

**Cluster side — us:** point Cilium's device / node IP at the new interface, move BGP
peering onto it, advertise VIPs; node-by-node, cluster stays up.

**Get right:**
- **Port security:** Neutron anti-spoofs virtio ports by default. VXLAN overlay →
  fine (pod traffic is under the node IP/MAC). Native routing (pod CIDRs on the wire)
  → create the port `--disable-port-security` (or `--allowed-address` pairs for the
  pod CIDR). Same overlay-vs-native call as the SR-IOV path.
- **MTU:** provider network, bridge, uplink trunk and guest interface must all carry
  the chosen MTU (jumbo if 9000).
- **[confirm] current uplink layout:** if the ConnectX-6 uplink already carries the
  existing data path, add VLAN X as a trunk / new bridge **without** disturbing
  current traffic — easiest if it already trunks, or via a spare NIC/subinterface.

**Cost:** virtio goes through the host kernel/OVS (CPU, no kernel bypass); SR-IOV is
line-rate. The whole point of virtio-first is **zero-downtime onboarding now**,
SR-IOV as a scheduled rolling upgrade later (§4).
