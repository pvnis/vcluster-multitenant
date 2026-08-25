# Multi-tenant Kubernetes on bare metal, with vCluster and gVisor

Two tenants, each with their own Kubernetes API server, sharing one bare-metal
node and one physical GPU. Each tenant is an administrator of their own cluster
and can see nothing of the host or of the other tenant. Their workloads run in
gVisor sandboxes whether they ask for it or not, and their share of the GPU is
enforced by the sandbox rather than by anything they can reach.

Verified end to end on `sensai` (k3s v1.36.2, one RTX 5070) on 2026-08-07.

> **To stand up the *entire* stack** (gVisor, the NVIDIA open-driver fork, HAMi,
> the device plugins, the in-tree webhook, the `gpu-scheduler`, and this tenancy
> layer), start at **[`SETUP.md`](SETUP.md)** — the two-vendor full-stack recipe.
> This README is the **tenancy layer** in depth (vCluster + Cilium + kubeconfigs).

> **Where this sits.** This project is the **cluster-tenancy** layer of a
> four-project stack. It decides *who* may run what (a vCluster + Cilium per
> tenant); **`gvisor`** enforces *how much of the GPU* each resulting sandbox may
> take (`gvisor/GPU-ISOLATION.md`); **`HAMi-gvisor`** / upstream HAMi places pods
> and the in-tree webhook translates their requests; and
> **`open-gpu-kernel-modules`** provides the privileged driver mechanisms gVisor
> drives (`open-gpu-kernel-modules/DRIVER-CHANGES.md`). The two isolation layers
> are orthogonal in what they guarantee — see `SECURITY-FINDINGS.md` here and its
> gVisor-side companion. The two-vendor cluster runbook is `TWO-VENDOR-CLUSTER.md`.

- [What this gives you](#what-this-gives-you)
- [Architecture](#architecture)
- [Prerequisites](#prerequisites)
- [Setup](#setup)
- [Verification](#verification)
- [Adding and removing tenants](#adding-and-removing-tenants)
- [What is closed, and what is not](#what-is-closed-and-what-is-not)
- [Teardown](#teardown)

## What this gives you

| | |
| --- | --- |
| Tenant API server | One per tenant, reachable at a fixed NodePort |
| Tenant privileges | Cluster admin — of their own virtual cluster only |
| Cross-tenant visibility | None: namespaces, pods, secrets, CRDs are all separate |
| Host visibility | None: no host namespaces, no host cluster-scoped objects |
| Workload isolation | gVisor, forced by the syncer regardless of what the pod asks for |
| GPU sharing | HAMi places, nvproxy enforces, one physical card between tenants |
| Resource limits | Host-side ResourceQuota and LimitRange, out of tenant reach |
| Pod-level policy | Pod Security Admission `baseline`, enforced host-side |
| Network | Cross-tenant ingress denied by NetworkPolicy |

## Architecture

A tenant talks to their own API server. Objects that only matter to the tenant
(Deployments, ServiceAccounts, CRDs) live there and go no further. Pods are
different: the vCluster **syncer** copies each one to the tenant's namespace on
the host, where the real kubelet runs it.

```
   tenant-a kubeconfig                          tenant-b kubeconfig
   :30443                                       :31443
        |                                            |
   +----v-------------------+              +---------v--------------+
   | tenant-a API server    |              | tenant-b API server    |
   | (pod tenant-a-0)       |              | (pod tenant-b-0)       |
   +----+-------------------+              +---------+--------------+
        | syncer                                     | syncer
        |                                            |
   +----v--------------------------------------------v--------------+
   |                    host k3s cluster (sensai)                   |
   |                                                                |
   |  namespace tenant-a              namespace tenant-b            |
   |    gpu-share-x-default-x-...       gpu-share-x-default-x-...   |
   |    ResourceQuota, LimitRange       ResourceQuota, LimitRange   |
   |    PSA: baseline                   PSA: baseline               |
   |                                                                |
   |  kube-system: hami-scheduler, hami-device-plugin               |
   |  host: runsc-gpu-scheduler.service, containerd + runsc         |
   +----------------------------------------------------------------+
                              |
                     one RTX 5070
```

Everything that binds a tenant — quota, pod policy, runtime class, GPU share —
is applied on the **host** side of that boundary. This is the single most
important property of the design: a tenant is root in their own cluster, so any
control they can see is a control they can delete.

The synced pod's name encodes where it came from:
`<pod>-x-<virtual-namespace>-x-<vcluster>`.

## Prerequisites

Already present on this machine before any of the below:

- k3s v1.36.2 single node, containerd with a `runsc` runtime handler
- `gvisor` RuntimeClass
- HAMi (scheduler, device plugin, webhook) in `kube-system`
- `runsc-gpu-scheduler.service` running on the host
- helm

See the gVisor repository's `g3doc/user_guide/gpu.md` for how the GPU half was
set up. This document assumes it and does not repeat it.

### A non-root kubeconfig

`kubectl` on this box is a symlink to `k3s`, which forces
`KUBECONFIG=/etc/rancher/k3s/k3s.yaml` — a root-owned file. Copy it once:

```bash
mkdir -p ~/.kube
sudo cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
sudo chown "$USER:$USER" ~/.kube/config
chmod 600 ~/.kube/config
echo 'export KUBECONFIG=$HOME/.kube/config' >> ~/.bashrc
```

The explicit `KUBECONFIG` is what overrides the k3s wrapper's default. Remove
that line from `~/.bashrc` to undo.

## Setup

### 1. Install the vCluster CLI

```bash
curl -sSL -o vcluster \
  https://github.com/loft-sh/vcluster/releases/download/v0.36.1/vcluster-linux-amd64
chmod +x vcluster && sudo install -m 0755 vcluster /usr/local/bin/vcluster
rm vcluster
vcluster version
```

Pinned rather than `latest` so that a rebuild is the same cluster.

> `vcluster create` refuses to run from a directory containing a file or
> directory named `vcluster` — it collides with the Helm chart name. Delete the
> downloaded binary from your working directory, as above.

### 2. Create the tenant namespaces

```bash
kubectl create namespace tenant-a
kubectl create namespace tenant-b
```

### 3. Create the virtual clusters

`values/tenant.yaml` holds the settings both tenants share; the overlay files
carry only the NodePort, which must differ.

```bash
cd values
vcluster create tenant-a -n tenant-a --values tenant.yaml --values tenant-a.yaml --connect=false
vcluster create tenant-b -n tenant-b --values tenant.yaml --values tenant-b.yaml --connect=false
vcluster list
```

The settings that matter are commented in `values/tenant.yaml`. In short:

- `sync.fromHost.runtimeClasses.enabled: true` — a tenant's API server
  validates `runtimeClassName` against its own set of RuntimeClasses, which is
  empty without this, so every pod naming one is rejected.
- `sync.toHost.pods.runtimeClassName: gvisor` — **load-bearing**; see
  [What is closed](#what-is-closed-and-what-is-not).
- `sync.fromHost.nodes.enabled: false` — tenants get a fake node carrying the
  capacity they need to schedule, without the host node's name, labels, taints
  or image list.
- `controlPlane.service.spec.type: NodePort` with a fixed `httpsNodePort`, so a
  tenant kubeconfig keeps working without a `vcluster connect` port-forward.

Note that `controlPlane.backingStore.etcd.embedded` is a vCluster **Pro**
feature. Setting it without a platform login makes `vcluster create` fail
outright with a login error. These tenants use the open-source default: SQLite
on a 5Gi PVC, via kine.

### 4. Apply host-side limits

```bash
cd ..
for ns in tenant-a tenant-b; do
  sed "s/NAMESPACE/$ns/" manifests/tenant-quota.yaml | kubectl apply -f -
done
```

`manifests/tenant-quota.yaml` sets a ResourceQuota (CPU, memory, GPU, pod and
PVC counts) and a LimitRange. The LimitRange is not optional: quoting
`requests.cpu` obliges *every* pod in the namespace to declare requests, and
without defaults that includes pods the tenant never wrote.

### 5. Apply pod policy

```bash
for ns in tenant-a tenant-b; do
  kubectl label ns $ns \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/enforce-version=latest \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/audit=restricted --overwrite
done
```

`baseline` is enforced; `restricted` is only warned and audited, so you can see
what tightening it further would break before doing it. The vCluster control
plane itself satisfies `baseline` — verified by deleting `tenant-a-0` and
watching it reschedule.

### 6. Isolate the tenants on the network

```bash
for ns in tenant-a tenant-b; do
  sed "s/NAMESPACE/$ns/g" manifests/tenant-netpol.yaml | kubectl apply -f -
done
```

Without this, tenants share one flat pod network and can reach each other's
pods by IP. k3s enforces NetworkPolicy with its embedded kube-router controller
unless started with `--disable-network-policy`, which this node does not, so no
extra CNI is needed.

The policy is ingress-only; see
[what that leaves open](#what-is-closed-and-what-is-not).

### 7. Hand out kubeconfigs

```bash
NODEIP=$(kubectl get node sensai -o jsonpath='{.status.addresses[?(@.type=="InternalIP")].address}')
mkdir -p kubeconfigs
vcluster connect tenant-a -n tenant-a --print --server=https://$NODEIP:30443 > kubeconfigs/tenant-a.yaml
vcluster connect tenant-b -n tenant-b --print --server=https://$NODEIP:31443 > kubeconfigs/tenant-b.yaml
chmod 600 kubeconfigs/*.yaml
```

**These files are credentials.** Each is cluster-admin of its virtual cluster.
They are client certificates and survive a control-plane restart, because the
PKI lives on the tenant's PVC. Do not commit them.

`vcluster connect tenant-a -n tenant-a` remains the interactive way in; it
opens a port-forward and switches your current context.

## Verification

Everything below was run against the live cluster. The outputs are real.

### Tenants cannot see each other

```console
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl create ns team-alpha
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl -n team-alpha run probe --image=busybox:1.36 -- sleep 3600

$ KUBECONFIG=kubeconfigs/tenant-b.yaml kubectl get ns
NAME              STATUS   AGE
default           Active   89s
kube-node-lease   Active   88s
kube-public       Active   89s
kube-system       Active   89s

$ KUBECONFIG=kubeconfigs/tenant-b.yaml kubectl get pods -A
NAMESPACE     NAME                      READY   STATUS    RESTARTS   AGE
kube-system   coredns-df8c87f55-qnrt7   1/1     Running   0          79s
```

Tenant B sees neither `team-alpha` nor the pod. Tenant A's `kube-system`
contains only its own CoreDNS, not the host's `hami-scheduler`. Neither tenant
can list `MutatingWebhookConfigurations`, of which the host has one.

Meanwhile the host sees where the work really went:

```console
$ kubectl get pods -A -o wide | grep probe
tenant-a   probe-x-team-alpha-x-tenant-a   1/1   Running   0   8s   10.42.0.161   sensai
```

### The quota binds, and says why

```console
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl get pod greedy
NAME     READY   STATUS    RESTARTS   AGE
greedy   0/1     Pending   0          8s

$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl get events --field-selector involvedObject.name=greedy
Warning   SyncError   pod/greedy   Error syncing to host cluster: create object: pods "greedy"
is forbidden: exceeded quota: tenant-quota, requested: requests.nvidia.com/gpu=8, ...
limited: requests.nvidia.com/gpu=4
```

The pod exists in the tenant's cluster and never reaches the host. The tenant
can read the reason from their own events, which matters — a silently Pending
pod is a support ticket.

### GPU, under gVisor, from inside a tenant

The manifests take their test binaries from a ConfigMap, which the tenant
creates once:

```bash
KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl create configmap gputest \
  --from-file=/opt/gputest/computetest --from-file=/opt/gputest/cudatest
```

`kubectl create configmap --from-file` puts non-UTF-8 files in `binaryData`,
so an ELF binary survives intact. Then:

```console
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl apply -f manifests/gpu-pod.yaml
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl logs gpu-probe
device: NVIDIA GeForce RTX 5070
meminfo: free=350 MiB total=512 MiB
alloc 0: 64 MiB at 0x7f44d8000000
...
alloc 5 of 64 MiB: FAILED rc=2 (CUDA_ERROR_OUT_OF_MEMORY)
meminfo: free=30 MiB (consumed 320 MiB)
PASS
```

The card has 12GB. The container is told it has 512 MiB and is refused past
320 MiB, because the `dev.gvisor.flag.nvproxy-gpu-memory-limit` annotation
survived the sync and nvproxy enforced it in the Sentry.

On the host, the synced pod shows the whole chain intact:

```console
$ kubectl -n tenant-a get pod gpu-probe-x-default-x-tenant-a \
    -o jsonpath='{.spec.runtimeClassName}{"\n"}{.spec.schedulerName}{"\n"}'
gvisor
hami-scheduler

$ ... -o jsonpath='{.metadata.annotations}' | tr ',' '\n' | grep -E 'gvisor|vgpu-devices-allocated'
"dev.gvisor.flag.nvproxy-gpu-memory-limit":"536870912"
"hami.io/vgpu-devices-allocated":"GPU-0b7a7424-d911-bb25-850c-6feddbc332d1..."
```

HAMi's webhook set `schedulerName` on the *synced* pod and HAMi placed it on
the physical device — the tenant never knew either existed.

### Two tenants sharing one card

```console
$ sed 's/TENANT/a/' manifests/gpu-share.yaml | KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl apply -f -
$ sed 's/TENANT/b/' manifests/gpu-share.yaml | KUBECONFIG=kubeconfigs/tenant-b.yaml kubectl apply -f -

tenant A:  a: WINDOW t=15 rate=315.91 launches/s
tenant B:  b: WINDOW t=15 rate=314.14 launches/s
```

An even split. For reference, one pod alone on this card reaches ~654
launches/s, and two contending gVisor pods *without* vCluster reach ~324 each —
so the virtualisation costs about 3%, which is control-plane overhead rather
than anything in the GPU path.

The coordinator gave them adjacent windows, which is it doing exactly what it
does for any two sandboxes:

```
sandbox 327ddc98...: GPU window is now 50ms of every 100ms at phase 0s
sandbox 3799912e...: GPU window is now 50ms of every 100ms at phase 50ms
```

> Run the host GPU coordinator with `--measure-usage=false`. With it on, two
> identical workloads divide 31/618 rather than evenly. See the gVisor
> repository's `g3doc/user_guide/gpu.md`.

## Adding and removing tenants

To add `tenant-c`, pick an unused NodePort in k3s's 30000–32767 range:

```bash
cat > values/tenant-c.yaml <<'EOF'
controlPlane:
  service:
    httpsNodePort: 32443
EOF
kubectl create namespace tenant-c
(cd values && vcluster create tenant-c -n tenant-c --values tenant.yaml --values tenant-c.yaml --connect=false)
sed 's/NAMESPACE/tenant-c/' manifests/tenant-quota.yaml | kubectl apply -f -
kubectl label ns tenant-c \
  pod-security.kubernetes.io/enforce=baseline \
  pod-security.kubernetes.io/enforce-version=latest \
  pod-security.kubernetes.io/warn=restricted \
  pod-security.kubernetes.io/audit=restricted --overwrite
```

To change a running tenant's settings, edit the values and re-run the same
`vcluster create` with `--upgrade`.

To remove one:

```bash
vcluster delete tenant-c -n tenant-c
kubectl delete namespace tenant-c
```

`vcluster delete` leaves the namespace, and with it the quota, the network
policy and the PVC. Deleting the namespace is what actually frees the disk.

## What is closed, and what is not

### Closed: a tenant choosing its own runtime

This one is worth dwelling on, because the setup looks correct without it.

Syncing RuntimeClasses from the host is necessary — a tenant's API server
rejects `runtimeClassName: gvisor` if it does not know the name. But it also
shows the tenant every *other* handler the host has, and on this node those are
ordinary runc handlers. So:

```console
$ # before sync.toHost.pods.runtimeClassName was set
$ KUBECONFIG=tenant-a.yaml kubectl run x --overrides='{"spec":{"runtimeClassName":"nvidia"}}' \
    --image=busybox:1.36 -- cat /proc/version

runtimeClassName=gvisor -> Linux version 4.19.0-gvisor #1 SMP Sun Jan 10 15:06:54 PST 2016
runtimeClassName=nvidia -> Linux version 6.8.0-117-generic ... #117~22.04.1-Ubuntu
```

One line of YAML and the tenant is on the host kernel with a GPU attached. Every
guarantee in the GPU work — memory quotas, compute shares, the whole adversarial
threat model — is void, because none of it applies to a container that is not in
a sandbox.

`sync.toHost.pods.runtimeClassName: gvisor` fixes it by overwriting the field on
the host pod, so the tenant's choice never reaches containerd:

```console
asked for gvisor -> Linux version 4.19.0-gvisor
asked for nvidia -> Linux version 4.19.0-gvisor
asked for crun   -> Linux version 4.19.0-gvisor

$ kubectl -n tenant-a get pods -o custom-columns='NAME:.metadata.name,RC:.spec.runtimeClassName'
rt2-crun-x-default-x-tenant-a     gvisor
rt2-gvisor-x-default-x-tenant-a   gvisor
rt2-nvidia-x-default-x-tenant-a   gvisor
```

Related, and already safe: a tenant cannot redefine what `gvisor` means.
`handler` is immutable in Kubernetes, and a RuntimeClass a tenant creates is
deleted again by the syncer within a second — a pod referencing it is rejected
with `RuntimeClass "escape" not found`. Deleting `gvisor` and racing to recreate
it as `runc` also failed; the syncer restored it first. And in any case only the
*host's* definition decides what containerd runs.

### Closed: hostPath, privileged, host namespaces

Before Pod Security Admission was applied, a tenant could mount the host root:

```console
$ KUBECONFIG=tenant-a.yaml kubectl logs hostpath
k3s.yaml
root:!:20591:0:99999:7:::
```

That is `/etc/rancher/k3s/k3s.yaml` — the **host cluster admin kubeconfig** —
and `/etc/shadow`. Total compromise of the host and of every other tenant.

gVisor does not help here. It sandboxes the kernel interface; it does not decide
which host paths the runtime hands to the sandbox in the first place.

With `baseline` enforced, both that and the privileged/hostNetwork/hostPID
family are refused at the sync boundary:

```console
Error syncing to host cluster: create object: pods "hostpath" is forbidden:
violates PodSecurity "baseline:latest": hostPath volumes (volume "h")

Error syncing to host cluster: create object: pods "priv" is forbidden:
violates PodSecurity "baseline:latest": host namespaces (hostNetwork=true,
hostPID=true), privileged (container "priv" must not set privileged=true)
```

This is why `manifests/gpu-pod.yaml` ships the test binaries in a ConfigMap
rather than mounting `/opt/gputest`.

### Closed: cross-tenant network traffic

Before the NetworkPolicy, a pod in `tenant-a` could fetch from a pod in
`tenant-b` by IP:

```console
--- cross-tenant pod:
HELLO-FROM-TENANT-B
```

After applying `manifests/tenant-netpol.yaml` to both namespaces, a pod
retrying for a full minute never gets through:

```console
$ KUBECONFIG=kubeconfigs/tenant-a.yaml kubectl logs xtenant
cross-tenant BLOCKED for 60s
```

while a tenant's own pods still reach each other, and `kubectl logs` and
`kubectl exec` keep working:

```console
$ KUBECONFIG=kubeconfigs/tenant-b.yaml kubectl logs race
reachable at attempt 1 (~2s)
```

> **Retry at pod start.** kube-router adds a new pod's IP to its namespace
> ipset a moment after the pod starts, so a pod's very first packets are
> rejected even when policy should allow them — measured at about two seconds
> on this node. A one-shot container that connects immediately and exits will
> appear to be blocked when it is not. This cost me a wrong conclusion twice
> while writing this document; test with a retry loop, not a single attempt.

The rejection is a TCP reset rather than a drop, so blocked clients see
`Connection refused` rather than a timeout.

### Not closed

Ordered by how likely they are to matter.

1. **Egress is unrestricted.** The NetworkPolicy above denies cross-tenant
   *ingress*, which is verified below, but says nothing about egress. A tenant
   pod can still open connections to the host, including the k3s API server on
   `:6443` — verified reachable. It has no credentials for it, so this is a
   reconnaissance and lateral-movement surface rather than a direct compromise,
   but it should be closed. Doing so means enumerating everything the vCluster
   control plane talks to; getting that wrong takes the tenant's API server
   down rather than merely leaking, which is why it is not done here.

2. **`baseline`, not `restricted`.** Baseline still permits running as root and
   does not require seccomp. The namespaces are labelled to *warn* on
   `restricted` so you can see what would break before enforcing it.

3. **NodePort collisions.** Tenants can create NodePort Services, which are
   synced and allocate from the host's shared range. One tenant can take a port
   another wanted. Restrict with a host-side policy that forbids
   `type: NodePort` in tenant namespaces.

4. **Quota is static and node-wide.** The two tenants can between them request
   8 of the node's 10 HAMi-split GPU devices and 8 CPUs of 12. Nothing reserves
   headroom for the host's own components.

5. **The GPU compute share is not tenant-aware.** `runsc gpu-scheduler` divides
   by sandbox weight, and every pod here takes the runtime default of 100. Two
   pods from one tenant get twice the GPU of one pod from another. Fair sharing
   *between tenants* would need weights assigned per tenant, which nothing
   currently does.

6. **Single node, single control plane.** No HA, and the tenants' SQLite
   backing stores are on local-path PVCs, so a tenant control plane cannot move
   to another node. Embedded etcd is the fix and is a Pro feature.

7. **No audit trail per tenant**, and no resource metering for chargeback.

## Teardown

```bash
vcluster delete tenant-a -n tenant-a
vcluster delete tenant-b -n tenant-b
kubectl delete namespace tenant-a tenant-b
rm -rf kubeconfigs
```

Removing the CLI and the shell change:

```bash
sudo rm -f /usr/local/bin/vcluster
sed -i '/export KUBECONFIG=\$HOME\/.kube\/config/d' ~/.bashrc
```

None of this touches k3s, HAMi, containerd or the gVisor runtime.

## Files

```
values/tenant.yaml          settings shared by every tenant, commented
values/tenant-a.yaml        NodePort 30443
values/tenant-b.yaml        NodePort 31443
manifests/tenant-quota.yaml  ResourceQuota + LimitRange, NAMESPACE substituted
manifests/tenant-netpol.yaml default-deny ingress + same-tenant allow
manifests/gpu-pod.yaml       one-shot GPU memory-limit check
manifests/gpu-share.yaml     long-running GPU load, TENANT substituted
kubeconfigs/                 generated credentials — gitignored

CILIUM-DESIGN.md             planned move to Cilium — design, not yet applied
migrate-to-cilium.sh         the migration, as one privileged script
manifests/cilium/            the policies that migration installs
```

## The network layer is now Cilium

**The setup sections above are out of date on networking.** As of 10 August 2026
this cluster no longer runs flannel or k3s's embedded kube-router. It runs Cilium
1.19.5 with kube-proxy replaced, and network isolation is enforced by the three
policy layers in [CILIUM-DESIGN.md](CILIUM-DESIGN.md) rather than by the two
NetworkPolicies in `manifests/tenant-netpol.yaml`, which have been deleted from
both tenants.

What changed, in short:

- **Cross-tenant traffic** is denied by a cluster-scoped
  `CiliumClusterwideNetworkPolicy` that tenants cannot see or edit, instead of a
  namespaced NetworkPolicy they could have deleted had they been able to reach
  it.
- **Egress now closes too.** Tenants cannot reach the internet or the host API
  server. Under kube-router only ingress was controlled.
- **Tenants can author their own NetworkPolicies and have them work** —
  `sync.toHost.networkPolicies` is on. Previously a tenant policy silently did
  nothing. This is safe only because Cilium deny rules beat every allow, so a
  tenant cannot use that power to widen past the floor. Verified by having a
  tenant apply an allow-all policy and confirming nothing opened.
- **gVisor needs one setting**, `socketLB.hostNamespaceOnly=true`: a sandboxed
  pod never issues the `connect()` syscall Cilium's socket load-balancer hooks,
  because the Sentry implements TCP in userspace. Without it, no gVisor pod can
  reach a ClusterIP while the cluster otherwise looks healthy.

Re-run the checks any time with `bash test-isolation.sh` (10 tests, all
passing). The GPU behaviour documented above is unaffected and was re-verified
after the migration.
