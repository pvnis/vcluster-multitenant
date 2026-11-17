# Fabric bring-up runbook

Wires the Midori VMs onto the Hedgehog fabric: `enp5s0` + the three VPC VLANs
(`fabric-netplan.yaml`), then Cilium BGP to router0 for external LB VIPs
(`cilium-bgp.yaml`). `ens3` stays the node's primary IP / default route / Cilium
dataplane throughout — this only adds the external + storage paths, so it's
non-disruptive. Octets: cp-0=100 cp-1=101 cp-2=102 eye-0=10 nv-0=110 nv-1=111
amd-0=120.

## 0. Preconditions
- `enp5s0` attached on the node (BF-2 VF; name may vary — `ip -br link`). amd-0
  still needs it; nv-0/nv-1 when they rejoin.
- router0 = 10.100.0.1, AS 65254. **Assumed dynamic BGP listen-range over
  10.100.0.0/24** — if so, any node IP peers without per-node fabric config, and
  cp-0's `.100` (vs the old `.7`) just works. Step 5 confirms it.

## 1. Apply the netplan (per node, start with cp-0)
```bash
sudo cp fabric-netplan.yaml /etc/netplan/60-fabric.yaml && sudo chmod 600 /etc/netplan/60-fabric.yaml
sudo sed -i 's/<OCTET>/100/g' /etc/netplan/60-fabric.yaml      # cp-0=100; per node
sudo netplan try && sudo netplan apply                          # try auto-reverts in 120s
# verify (ens3 keeps the node reachable, so this is safe):
ip -br addr show enp5s0.106            # 10.100.0.100/24, UP
ip route get 10.33.0.61               # -> via 10.100.2.2 dev enp5s0.108
nc -vz 10.33.0.61 6789                # Ceph mon (TCP; ping/SSH are blocked)
```

## 2. Enable the Cilium BGP control plane (once, cluster-wide)
```bash
# cilium-values.yaml:  bgpControlPlane: { enabled: true }
helm upgrade cilium cilium/cilium -n kube-system -f manifests/midori/cilium-values.yaml --reuse-values
kubectl -n kube-system rollout restart ds/cilium
kubectl get crd | grep ciliumbgp     # CRDs present
```

## 3. Label the fabric nodes (only these peer)
```bash
kubectl label node midori-cp-0 midori-cp-1 midori-cp-2 midori-eye-0 \
  midori.phoenix/fabric-bgp=true
# add nv-0/nv-1 when they rejoin; amd-0 once its vNIC is attached
```

## 4. Apply the BGP + LB-IPAM config
```bash
# confirm 119.15.113.128/26 first
kubectl apply -f manifests/midori/cilium-bgp.yaml
```

## 5. Verify the session (this is the dynamic-range test)
```bash
kubectl -n kube-system exec ds/cilium -- cilium bgp peers
#   want: PeerAddress 10.100.0.1  Session Established
# on router0:
#   show bgp summary        -> neighbor 10.100.0.100 Established (accepted via listen range)
#   show bgp ipv4 unicast   -> our advertised VIPs appear once a Service exists
```
Then a smoke test — a LoadBalancer Service drawing from the public pool:
```bash
kubectl create deploy echo --image=registry.k8s.io/e2e-test-images/agnhost:2.47 -- /agnhost netexec --http-port=8080
kubectl expose deploy echo --type=LoadBalancer --port=80 --target-port=8080
kubectl label svc echo midori.phoenix/lb-pool=public        # draws from 119.15.113.128/26
kubectl get svc echo -o wide                                 # EXTERNAL-IP from the /26
# router0: show ip route <that VIP>  -> via the node(s) holding the endpoint
```

## If the session doesn't establish
- `cilium bgp peers` stuck Idle/Active → router0 isn't accepting us: confirm the
  **listen-range** covers 10.100.0.0/24 and the **peer-group remote-as is 65254**
  (iBGP); check `enp5s0.106` is UP with the right IP and can reach 10.100.0.1.
- Established but no routes → the Service has no `midori.phoenix/lb-pool=public`
  label (no VIP), or `externalTrafficPolicy` keeps it off nodes without endpoints.

## Rollout
cp-0/1/2 + eye-0 now; amd-0 after its vNIC; nv-0/nv-1 when they rejoin. Node/pod
traffic stays on `ens3` (see `NETWORKING-BAREMETAL.md` "as deployed").
