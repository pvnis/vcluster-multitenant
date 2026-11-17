# midori networking: the fabric edge

How midori's networking is wired **as deployed**. The VMs keep `ens3` (Neutron) as
their primary IP, default route and Cilium pod dataplane; a **fabric vNIC** adds
BGP-advertised external LoadBalancer VIPs and the CephFS storage path over a
Hedgehog-managed SONiC fabric. Step-by-step: `FABRIC-BRINGUP.md`. CephFS:
`ceph-csi/README.md`.

A larger future move **entirely off OpenStack** (plain servers, no overlay, the
edge on plain switches) is kept at the end as **design-only — not deployed**. The
deployed fabric already realizes that design's core — Cilium BGP + a routable
LB-IPAM pool — just peered to the fabric's `router0` instead of to OpenWRT.

Grounded in the cluster as it runs today: Cilium v1.19.8, k3s HA,
`routing-mode=tunnel/vxlan` on `ens3`, pods `10.42.0.0/16`, services
`10.43.0.0/16`, nodes `10.30.30.0/24`, public `119.15.113.0/24` (APNIC, AS55393).

## Current architecture (deployed & verified 2026-11-17)

Each VM has a **fabric vNIC** (`enp5s0` on cp-0/1/2/eye-0, `enp0s7` on
nv-0/1/amd-0), a trunk into the Hedgehog fabric carrying three Midori VPCs.
**`ens3` is untouched** — node-to-node and pod traffic stay on it; the fabric only
adds the external and storage paths.

| VPC | subnet / VLAN | guest subif | role |
| --- | --- | --- | --- |
| `midori-bgp` | 10.100.0.0/24, VLAN 106 (→ router0) | `.106` | BGP peering + external LB VIPs |
| `midori-internal` | 10.100.1.0/24, VLAN 107 (no router/peer) | `.107` | reserved east-west (idle) |
| `midori-storage` | 10.100.2.0/24, VLAN 108 (peered with `storage`) | `.108` | CephFS |

- **Live & verified.** All 7 nodes carry the fabric subinterfaces, **MTU 9000**.
  Cilium's BGP control plane peers **router0 `10.100.0.1`** (running **BIRD**, a
  dynamic `neighbor range 10.100.0.0/24 as 65254`) from every node — **eBGP,
  cluster AS 65254 ↔ router0 AS 65253, all Established** — and advertises
  LoadBalancer VIPs from **`119.15.113.128/26`** via LB-IPAM (a Service opts in
  with label `midori.phoenix/lb-pool=public`).
- **socketLB stayed `Hostns-only`** across the Cilium upgrade — the gVisor
  invariant, independent of any of this.
- **CephFS** is live over `.108` (`10.33.0.0/24 via 10.100.2.2`): `ceph-csi`,
  StorageClass `cephfs`, RWX (`ceph-csi/README.md`).
- Manifests: `cilium-bgp.yaml` (BGP v2 + LB-IPAM), `cilium-values.yaml`
  (`bgpControlPlane.enabled: true`), `fabric-netplan*`, `gen-fabric-netplan.sh`.
- **Still open:** formalize the `/26`; router0's **upstream** eBGP so VIPs are
  globally reachable (the cluster→router0 half is done).

## Why the edge is shaped this way

Cilium runs a **VXLAN overlay** because OpenStack forces it: Neutron doesn't route
pod CIDRs between nodes and its port-security drops pod-sourced packets, so Cilium
encapsulates over `ens3`. That stays. What the fabric adds is a **second,
BGP-spoken edge** on which Cilium advertises **routable** LoadBalancer VIPs from
the public `/26` — replacing Octavia LBaaS + floating-IP NAT with **Cilium LB-IPAM
+ BGP** (and fast BGP/ECMP reconvergence) **without touching the pod dataplane**.

**Unchanged** — the whole in-cluster story: Cilium CNI, `kubeProxyReplacement`,
`socketLB.hostNamespaceOnly: true` (MANDATORY), the NetworkPolicy/CNP tenant floor,
`platform-guard`, NodePorts, gVisor, the tenant controller. Only the north-south
edge changed.

| OpenStack provided | deployed replacement |
| --- | --- |
| Octavia Service VIPs via OCCM | **Cilium LB-IPAM + BGP** to router0 |
| Floating IPs + NAT off external-net | router0 holds the public prefix; VIPs are real routed IPs |
| (the rest — overlay, API LB, SG edge, egress NAT) | still OpenStack today; see the design appendix for the eventual replacement |

## Appendix — the eventual move fully off OpenStack (DESIGN ONLY, NOT DEPLOYED)

> **None of this appendix is running.** Node/pod traffic is still VXLAN on `ens3`;
> the edge is the fabric `router0` (BIRD, **AS 65253**; cluster **AS 65254**); VIPs
> come from **`119.15.113.128/26`**. The original sketch here predated the fabric
> and used placeholder **OpenWRT/FRR at AS 64512/64513** and a `/27` — treat those
> numbers as illustrative, superseded by the deployed values above. Kept for the
> rationale and as the plan if midori ever leaves the VMs. The full original
> (FRR/kube-vip/LB-IPAM YAML, address plan) is in git history before this cleanup.

If midori moves onto plain servers, the overlay constraint disappears and the
removal cascades — native routing, jumbo end-to-end, DSR/source-IP preservation,
routable VIPs, BGP/ECMP HA. What that would take:

- **Cilium native routing:** `routingMode: native`, `ipv4NativeRoutingCIDR:
  10.42.0.0/16`, `autoDirectNodeRoutes` on one shared L2 (or PodCIDR-over-BGP for
  multi-rack); `MTU: 9000`; `loadBalancer.mode: dsr`, `dsrDispatch: geneve`,
  `algorithm: maglev`. Keep everything else, above all `socketLB.hostNamespaceOnly`
  and `k8sServiceHost: 127.0.0.1:6444`.
- **Edge BGP** with a dynamic listen-range so nodes dial in (the deployed router0
  already does exactly this via BIRD `neighbor range`), fast timers (3s keepalive /
  9s hold), and `maximum-paths` for ECMP. Pair each public Service with
  `externalTrafficPolicy: Local` so a VIP is advertised only from nodes holding a
  local endpoint (source-IP preserved; a dead backend withdraws itself).
- **kube-vip** for a stable external API VIP — node→API already survives any one
  server via k3s's `127.0.0.1:6444` client-side LB, so this is only for an external
  kubeconfig/ingress endpoint.
- **Egress/NAT** on the edge; Cilium **Egress Gateway** to pin a stable,
  allow-listable egress IP per tenant.
- **Firewalling**, three layers replacing one Neutron SG: Cilium CNP (unchanged);
  **host nftables** replacing port-security (generalizes the storage-VLAN rules of
  the `cephfs-direct` decision); edge firewall zones owning what the public LB
  range exposes.
- **Physical layer:** switched VLANs (mgmt, cluster/node as a real L2, public/
  uplink, storage with jumbo) replacing Neutron networks; bond NICs + dual ToR for
  the redundancy Neutron gave for free.
- **Cutover order** that never drops DNS/API: validate VLANs → bring CoreDNS HA in
  first → flip native routing in a maintenance window (verify cross-node pod ping)
  → enable BGP, confirm sessions + ECMP VIP routes → move Services to the public
  pool and retire OCCM + the Octavia guard → kube-vip for the API, repoint
  kubeconfig/DNS. **Rollback** is local at each step (`routingMode: tunnel` +
  `rollout restart`, or remove the `CiliumBGPClusterConfig`); keep OCCM/Octavia
  reachable until the LB cutover is proven.

The single highest-leverage piece — **Cilium BGP control plane + a public LB-IPAM
pool, peered to a BIRD/FRR edge** — is the part that is **already deployed** on the
fabric; the rest above is what a full departure from the VMs would add.
