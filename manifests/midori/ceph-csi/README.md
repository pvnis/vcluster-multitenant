# CephFS-backed volumes (ceph-csi, external TYO Ceph)

Native CephFS (not Ganesha — per the `cephfs-direct-decision`) for Kubernetes
PVs, backed by the **external** Ceph at `10.33.0.0/24` (mons `.61/.62/.63`),
reached over the fabric storage VPC (`enp5s0.108` → `10.33.0.0/24 via 10.100.2.2`,
already up on all nodes). CephFS gives **ReadWriteMany**.

## Status — WORKING (2026-11-17)
Dynamic provisioning is live and verified end-to-end:
- `ceph-csi-cephfs` 3.18.2 (helm, ns `ceph-csi`), provisioner ×2 + nodeplugin on
  all 7 nodes. clusterID `tyo-ceph`, fs `cephfs`, mons `.61/.62/.63`, over the
  fabric `.108` path. StorageClass `cephfs` (RWX, `Delete` reclaim, expandable).
- Smoke test: PVC Bound, a pod wrote+read a file, the subvolume was created under
  `/volumes/csi`, and PVC delete reclaimed it.
- **gVisor confirmed:** a `runtimeClassName: gvisor` (runsc) pod mounted the same
  PVC, read the runc-written file and wrote its own — tenant pods get CephFS
  volumes, and RWX sharing works across pods.

## How it was enabled (Ceph side, for the record)
We reused `client.midori` (modified in place), not a dedicated client. TYO
specifics found along the way: fs `cephfs`; pools `cephfs.cephfs.meta` /
`cephfs.cephfs.data`.

Final working caps — the osd cap **must** include the *metadata* pool (ceph-csi
keeps its volume-tracking OMAP there; the first grant omitted it and every
provision failed `rados: Operation not permitted`):
```bash
ceph auth caps client.midori \
  mon "allow r fsname=cephfs" \
  mgr "allow rw" \
  osd "allow rwx pool=cephfs.cephfs.meta, allow rw pool=cephfs.cephfs.data" \
  mds "allow rw fsname=cephfs"
```
The default subvolumegroup had to be pre-created (this ceph-csi version does not
auto-create it):
```bash
ceph fs subvolumegroup create cephfs csi
```
After any caps change, restart the provisioner so it re-auths with a fresh CephX
session (an existing session keeps the old, denied auth):
```bash
kubectl -n ceph-csi rollout restart deploy/ceph-csi-cephfs-provisioner
```

### Notes
- `mds "allow rw fsname=cephfs"` is whole-fs (kept so `client.midori` stays usable
  for any direct `/` mounts). If it becomes k8s-only, narrow to
  `mds "allow r fsname=cephfs path=/volumes, allow rws fsname=cephfs path=/volumes/csi"`.
- `tyo-ceph` is just the config key (not the fsid) shared by `values.yaml` and
  `storageclass.yaml` — leave it.
- To use CephFS: set `storageClassName: cephfs` on a PVC (`ReadWriteMany` or RWO).

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
