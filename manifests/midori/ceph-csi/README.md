# CephFS-backed volumes (ceph-csi, external TYO Ceph)

Native CephFS (not Ganesha — per the `cephfs-direct-decision`) for Kubernetes
PVs, backed by the **external** Ceph at `10.33.0.0/24` (mons `.61/.62/.63`),
reached over the fabric storage VPC (`enp5s0.108` → `10.33.0.0/24 via 10.100.2.2`,
already up on all nodes). CephFS gives **ReadWriteMany**.

## What I still need from you
- **`client.midori` key** — create the Secret yourself (keep it out of git).
- **clusterID** — the Ceph `fsid` (preferred) or any consistent string; must match
  in `values.yaml` and `storageclass.yaml`. (`ceph fsid` on a storage host / in
  `ceph.conf`.)
- **client caps** — does `client.midori` have **mgr/subvolume** caps (then dynamic
  provisioning works), or only the data-path `rw on /volumes` from the gist (then
  use the **static PV** path below)? If unsure, try dynamic; if the provisioner
  errors with a permissions/mgr error, fall back to static.

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
