# midori on bare metal: the networking story without OpenStack

A design/target doc for when midori moves off OpenStack VMs onto plain servers,
keeping the **OpenWRT router** for external and mgmt networking. Nothing here is
deployed yet; it is what to build at cutover. Grounded in the cluster as it runs
today (Cilium v1.19.8, k3s HA, `routing-mode=tunnel/vxlan`, pods `10.42.0.0/16`,
services `10.43.0.0/16`, nodes `10.30.30.0/24`, public `119.15.113.0/24`).

## The one fact that drives everything

Cilium runs a **VXLAN overlay today only because OpenStack forces it**: Neutron
does not route pod CIDRs between nodes and its port-security drops pod-sourced
packets, so Cilium has to encapsulate (`cilium-values.yaml` MTU note: device
1500 → pods 1450). Bare metal removes that constraint, and the removal cascades:
native routing, full/jumbo MTU, DSR, source-IP preservation, routable public
VIPs, and BGP-based HA all become available. The rest of this doc is the
consequences.

What OpenStack silently provided, and that you now own:

| today (Neutron/Octavia) | bare-metal replacement |
| --- | --- |
| Octavia LBaaS (Service VIPs + API LB 10.30.30.106), via OCCM | **Cilium LB-IPAM + BGP** to OpenWRT; **kube-vip** for the API VIP |
| Floating IPs + NAT off external-net | **OpenWRT** holds the public prefix and routes/NATs; VIPs are real routed IPs |
| Security groups (`midori-nodeports`), port-security/anti-spoof | **host nftables** + **OpenWRT firewall zones**; Cilium CNP unchanged |
| VXLAN overlay (underlay won't carry pod IPs) | **native routing** (`auto-direct-node-routes` on one L2, or BGP PodCIDR) |
| amphora HA, DHCP/metadata, port redundancy | **BGP/ECMP HA**, PXE/provisioning, NIC bonding + dual ToR |

**Unchanged** — the entire in-cluster story: Cilium CNI, `kubeProxyReplacement`,
`socketLB.hostNamespaceOnly: true` (still MANDATORY — the gVisor socket-LB caveat
has nothing to do with the underlay), NetworkPolicy/CNP tenant floor,
`platform-guard`, NodePorts, gVisor, the tenant controller. Only the **edge**
changes.

## Address and ASN plan

```
pods           10.42.0.0/16     (k3s cluster-cidr, unchanged)
services       10.43.0.0/16     (k3s service-cidr, unchanged; DNS 10.43.0.10)
nodes          10.30.30.0/24    (cluster/node VLAN — now a real switched L2)
LB VIP pool    119.15.113.224/27  (carved from the public /24; routed, not NAT)
API VIP        119.15.113.222/32  (or an internal VIP if the API stays private)
cluster ASN    64512            (all nodes; private)
router ASN     64513            (OpenWRT/FRR; private)
```

Pick the LB /27 (or larger) out of the public range you already own
(119.15.113.0/24, APNIC/AS55393). These become **directly routable** Service
VIPs — no FIP/NAT indirection — which also simplifies the pending public-gateway
TLS/DNS-01 work (task #28): DNS points straight at the VIP.

## Cilium: native routing + BGP

### 1. Values changes (`cilium-values.yaml`)

```yaml
# was: routing-mode tunnel / vxlan. Drop the overlay.
routingMode: native
ipv4NativeRoutingCIDR: "10.42.0.0/16"   # don't masquerade pod-to-pod
autoDirectNodeRoutes: true              # all nodes share the 10.30.30.0/24 L2:
                                        # each installs a direct route to peers'
                                        # podCIDR via the node IP. No BGP needed
                                        # for east-west; BGP only for north-south
                                        # VIPs. (Multi-rack? drop this and
                                        # advertise PodCIDR over BGP instead.)
MTU: 9000                               # jumbo end-to-end now that VXLAN's 50B
                                        # tax is gone — directly helps the CephFS
                                        # storage path and the DU-fronthaul work.
                                        # Only if the whole fabric is 9000-clean;
                                        # else keep 1500 (pods get the full 1500,
                                        # not 1450).

bgpControlPlane:
  enabled: true                         # currently OFF; this installs the BGP v2 CRDs

loadBalancer:
  mode: dsr                             # preserve client source IP across ECMP
  dsrDispatch: geneve                   # geneve dispatch works with native routing
  algorithm: maglev                     # consistent backend pick under ECMP churn

enableLBIPAM: true                      # already on
```

Keep **everything else as-is**, especially `socketLB.hostNamespaceOnly: true`,
`k8sServiceHost: 127.0.0.1` / `k8sServicePort: 6444` (k3s's own client-side API
LB still works node-side), the CNI paths, Hubble, and `operator.replicas: 2`.
After any values change: `kubectl rollout restart ds/cilium` (and check pod AGE,
not the rollout message — see the note in `cilium-values.yaml`).

### 2. LB-IPAM pool

```yaml
apiVersion: cilium.io/v2
kind: CiliumLoadBalancerIPPool
metadata: { name: public }
spec:
  blocks:
    - cidr: "119.15.113.224/27"
  # Optional: restrict which Services may draw from the public pool, so a tenant
  # can't grab public space by asking for type=LoadBalancer. This is where the
  # old Octavia `load-balancer-guard` ValidatingAdmissionPolicy intent moves to.
  serviceSelector:
    matchExpressions:
      - { key: midori.phoenix/lb-pool, operator: In, values: ["public"] }
```

### 3. BGP to OpenWRT (Cilium BGP v2 API — correct for v1.19)

```yaml
apiVersion: cilium.io/v2
kind: CiliumBGPClusterConfig
metadata: { name: midori }
spec:
  nodeSelector:
    matchLabels: { kubernetes.io/os: linux }   # every node is a speaker
  bgpInstances:
    - name: midori
      localASN: 64512
      peers:
        - name: openwrt
          peerASN: 64513
          peerAddress: "10.30.30.1"             # OpenWRT on the node VLAN
          peerConfigRef: { name: openwrt }
---
apiVersion: cilium.io/v2
kind: CiliumBGPPeerConfig
metadata: { name: openwrt }
spec:
  timers: { connectRetryTimeSeconds: 5, holdTimeSeconds: 9, keepAliveTimeSeconds: 3 }
  gracefulRestart: { enabled: true, restartTimeSeconds: 15 }
  families:
    - afi: ipv4
      safi: unicast
      advertisements:
        matchLabels: { advertise: midori }
---
apiVersion: cilium.io/v2
kind: CiliumBGPAdvertisement
metadata:
  name: lb-vips
  labels: { advertise: midori }
spec:
  advertisements:
    - advertisementType: Service
      service: { addresses: [ LoadBalancerIP ] }
      selector:
        matchExpressions:
          - { key: somekey, operator: NotIn, values: ["never"] }   # all Services
      # Pair with externalTrafficPolicy: Local on each Service so a VIP is only
      # advertised from nodes holding a local endpoint → source IP preserved and
      # a dead backend withdraws itself. (Multi-rack native routing: add a second
      # advertisement with advertisementType: PodCIDR.)
```

Fast timers (3s keepalive / 9s hold) so a node loss reconverges in seconds —
this is what replaces Octavia amphora failover.

## OpenWRT as the BGP edge

Install FRR (`opkg install frr frr-bgpd`) or BIRD. FRR sketch, using a **dynamic
listen-range** so you don't enumerate nodes:

```
router bgp 64513
 bgp router-id 10.30.30.1
 no bgp ebgp-requires-policy                 ! accept routes without an explicit policy
 neighbor cilium peer-group
 neighbor cilium remote-as 64512
 bgp listen range 10.30.30.0/24 peer-group cilium   ! nodes dial in
 address-family ipv4 unicast
  neighbor cilium activate
  maximum-paths 8                            ! ECMP across the nodes advertising a VIP
 exit-address-family
```

OpenWRT also:
- **firewall**: allow tcp/179 from the node VLAN; a `wan`↔`lan` zone policy
  replacing the `midori-nodeports` security group; the LB /27 reachable from
  `wan`.
- **routing/NAT**: holds the default route and the public prefix; SNAT for pod
  egress to the uplink (unless pods use routable space). Learned VIP routes
  ECMP to the nodes.
- **mgmt**: unchanged — the mgmt VLAN stays on OpenWRT as today.

Verify: `vtysh -c 'show bgp ipv4 unicast summary'` (one session per node, state
Established) and `show ip route 119.15.113.224/27` (ECMP next-hops = node IPs).

## Control-plane API VIP: kube-vip

Node→API already survives any single server via k3s's client-side LB on
`127.0.0.1:6444`, so the VIP is mainly for a **stable external kubeconfig /
ingress endpoint**. Run **kube-vip** as a static pod on the three servers in ARP
mode (one L2) or BGP mode (consistent with the above):

```yaml
# /var/lib/rancher/k3s/server/manifests/kube-vip.yaml on each server
# env: vip_address=119.15.113.222 (or an internal VIP), vip_interface=<nodeNIC>,
#      bgp_enable=true, bgp_as=64512, bgp_peeraddress=10.30.30.1, bgp_peeras=64513
#      svc_enable=false  (Cilium LB-IPAM owns Service VIPs; kube-vip only the API)
```

Then point the kubeconfig `server:` and the control-plane DNS name at the VIP.
(Dropping in via the k3s `server/manifests/` auto-deploy dir — same mechanism the
CoreDNS HA change should use; see below.)

## Egress / NAT

Pods→internet is SNAT today (masquerade on) through the Neutron router. Bare
metal: **OpenWRT does the NAT** to the uplink; nodes masquerade pod traffic to
it (keep `enable-ipv4-masquerade`, with `ipv4NativeRoutingCIDR` so intra-cluster
is exempt). If a tenant needs a **stable, allow-listable egress IP**, use
Cilium's **Egress Gateway** (the `egress-gateway` keys are already compiled in)
to pin that tenant's egress to a chosen node/IP.

## Firewalling and isolation

Three layers, replacing one Neutron SG:
1. **In-cluster (unchanged):** Cilium NetworkPolicy/CNP — the tenant deny-floor
   and `platform-guard` carry over verbatim; they never depended on Neutron.
2. **Host (new):** nftables on every node replaces port-security. The existing
   storage-VLAN + "mgmt-net hole" rules (the CephFS-direct decision) generalize
   from a Neutron-port exception to standard host firewalling on each node.
3. **North-south (new):** OpenWRT firewall zones replace `midori-nodeports` and
   own what the public LB /27 exposes.

## Physical layer (what OpenStack hid)

Switched VLANs replace Neutron networks:
- **mgmt** — OpenWRT, as today.
- **cluster/node** — `10.30.30.0/24` as a real L2 (node-to-node, BGP, pod routes
  via `auto-direct-node-routes`).
- **public/uplink** — to OpenWRT; carries the LB /27 and API VIP.
- **storage** — CephFS direct (the TYO decision), now a plain physical VLAN
  rather than a Neutron trunk; jumbo frames end-to-end.
Bond NICs and, ideally, dual top-of-rack for the port redundancy Neutron gave
for free.

## Cutover ordering (and rollback)

Do it so DNS/API never drop:
1. Wire and validate the physical VLANs; FRR up on OpenWRT (no sessions yet).
2. Bring the **CoreDNS HA** fix in first (2 replicas, anti-affinity off GPU
   nodes, PDB) — independent of the rest and the lesson from the last outage.
3. Flip Cilium to `routingMode: native` + `autoDirectNodeRoutes` on a
   maintenance window; `rollout restart ds/cilium`; verify pod-to-pod across
   nodes (DF ping 1472 at 1500 MTU, or 8972 at 9000) before going further.
4. Enable `bgpControlPlane`; apply the pool + BGP CRDs; confirm sessions
   Established and VIP routes ECMP on OpenWRT.
5. Move Services to the public pool (label them), retire **OCCM** and the
   Octavia `load-balancer-guard` VAP (or repurpose the VAP to gate `lb-pool`).
6. kube-vip for the API VIP; repoint external kubeconfig/DNS.

**Rollback** at each step is local: re-enable VXLAN (`routingMode: tunnel`) and
`rollout restart`; or withdraw BGP by removing the `CiliumBGPClusterConfig`.
Keep OCCM/Octavia reachable until step 5 is proven.

## Net

You trade **Octavia-owns-HA** for **BGP-ECMP-owns-HA** — generally more robust
and faster, and it unblocks native routing, jumbo frames, DSR/source-IP, and
routable public VIPs, several of which help work already in flight. The cost is
that LBaaS, the API VIP, egress NAT, firewalling, and physical redundancy become
yours to run instead of the cloud's. The single highest-leverage move is
**Cilium BGP control plane + a public LB-IPAM pool peered to OpenWRT/FRR** — it
replaces Octavia, FIPs, and the overlay in one coherent mechanism.
