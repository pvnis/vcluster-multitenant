# CephFS-backed volumes (ceph-csi, external TYO Ceph)

Native CephFS (not Ganesha — per the `cephfs-direct-decision`) for Kubernetes
PVs, backed by the **external** Ceph at `10.33.0.0/24` (mons `.61/.62/.63`),
reached over the fabric storage VPC (`enp5s0.108` → `10.33.0.0/24 via 10.100.2.2`,
already up on all nodes). CephFS gives **ReadWriteMany**.

## Status — 2026-11-17
- **Driver deployed & healthy:** `ceph-csi-cephfs` 3.18.2 (helm release in ns
  `ceph-csi`), provisioner ×2 + nodeplugin on all 7 nodes. clusterID `tyo-ceph`,
  mons `.61/.62/.63`. StorageClass `cephfs` applied.
- **Dynamic provisioning blocked on Ceph caps.** The smoke-test PVC failed with
  `rados: ret=-1, Operation not permitted` — `client.midori` can mount CephFS but
  lacks the **mgr/subvolume** caps to *create* subvolumes (data-path caps only,
  as the gist implied). Decision (user, 2026-11-17): get the caps (go dynamic),
  not static.

## Grant the CSI caps (storage team) — then dynamic works
Create a **dedicated** CSI client (don't mutate `client.midori`, which Manila /
the test VM also use; `ceph auth caps` *replaces* caps). Run on a Ceph host
(needs Ceph admin). Defaults match our StorageClass: fs `cephfs`, subvolumegroup
`csi` (ceph-csi auto-creates the group):
```bash
ceph auth get-or-create client.midori-csi \
  mgr "allow rw" \
  osd "allow rwx tag cephfs metadata=cephfs, allow rw tag cephfs data=cephfs" \
  mds "allow r fsname=cephfs path=/volumes, allow rws fsname=cephfs path=/volumes/csi" \
  mon "allow r fsname=cephfs"
# prints the key for client.midori-csi
```
Then point the k8s Secret at the new client (keys stay out of git):
```bash
kubectl -n ceph-csi delete secret csi-cephfs-secret
kubectl -n ceph-csi create secret generic csi-cephfs-secret \
  --from-literal=userID=midori-csi  --from-literal=userKey='<NEW_KEY>' \
  --from-literal=adminID=midori-csi --from-literal=adminKey='<NEW_KEY>'
```
No helm/StorageClass change needed — re-run the smoke test (Option A) and the PVC
binds. (`client.midori` with its data caps stays usable for the static path below
if ever wanted.)

### clusterID note
`tyo-ceph` is just the config key shared by `values.yaml` and `storageclass.yaml`;
it need not be the Ceph `fsid`. Leave it as-is.

## Deploy the driver
```bash
helm repo add ceph-csi https://ceph.github.io/csi-charts && helm repo update
kubectl create namespace ceph-csi

# Secret — NOT committed. userID/userKey mount; adminID/adminKey provision.
kubectl -n ceph-csi create secret generic csi-cephfs-secret \
  --from-literal=userID=midori  --from-literal=userKey='<MIDORI_KEY>' \
  --from-literal=adminID=midori --from-literal=adminKey='<MIDORI_KEY>'

# Fill <CEPH_CLUSTER_ID> in values.yaml first.
helm install ceph-csi-cephfs ceph-csi/ceph-csi-cephfs -n ceph-csi -f values.yaml
kubectl -n ceph-csi get pods            # provisioner + a nodeplugin per node, Running
```

## Option A — dynamic provisioning (needs mgr caps)
```bash
# fill <CEPH_CLUSTER_ID> in storageclass.yaml to match values.yaml
kubectl apply -f storageclass.yaml
kubectl apply -f test-pvc.yaml          # PVC Bound + pod writes a file
kubectl -n default logs cephfs-test     # "hello"
kubectl delete -f test-pvc.yaml
```
If the PVC stays Pending with a provisioner permission/mgr error, `client.midori`
lacks subvolume caps → use Option B (or get an admin client from storage).

## Option B — static PV (data-path caps only)
Mount an existing CephFS path (e.g. a pre-created `/volumes/midori/<name>`). See
`static-pv.yaml` (fill the rootPath). No subvolume creation, so only the data
caps the gist already grants are needed. Good enough to prove end-to-end and for
shared platform volumes; dynamic per-PVC subvolumes can come later.

## Notes for this cluster
- **gVisor:** the nodeplugin mounts CephFS on the **host**; kubelet bind-mounts it
  into the pod, and gVisor passes the host mount into the sandbox via the gofer —
  so gVisor tenant pods can use these volumes. Worth confirming with a runsc pod.
- **Network:** the nodeplugin uses the host route to the mons (the `.108` fabric
  path). The Neutron NIC can't reach storage, so this only works because the
  fabric netplan is applied — it is, on all nodes.
- **Node coverage / taints:** `values.yaml` tolerates all taints so the nodeplugin
  runs everywhere pods might land (incl. control-plane/vcluster nodes).
- **Tenant-facing provisioning** (letting tenants request CephFS PVCs with proper
  isolation — per-tenant subvolumegroups + caps, controller plumbing) is a
  follow-up; this first enables it at the platform level.
