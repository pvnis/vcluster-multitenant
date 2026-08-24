# One cluster, two GPU vendors

`sensai` and `sens1` are now a single k3s cluster that hands out **NVIDIA
compute/memory slices on one node and AMD VRAM/CU slices on the other**, with
gVisor enforcing both in the Sentry. A pod asks for the vendor it wants and the
scheduler puts it on the node that has it.

> Companion to `README.md` (the single-vendor tenancy setup this extends). The
> Sentry-side enforcement both vendors rely on is described in
> `../gvisor/GPU-ISOLATION.md`.

| | sensai | sens1 |
| --- | --- | --- |
| role | control-plane | worker |
| GPU | RTX 5070, driver 610.43.02 | Navi 32, gfx1101, 54 CUs, 12272 MiB |
| node IP | `100.93.194.25` (Tailscale) | `100.101.223.94` (Tailscale) |
| label | `gpu.vendor=nvidia`, `gpu=on` | `gpu.vendor=amd` |
| advertises | `nvidia.com/gpu: 10` (HAMi) | `amd.com/gpu-vram-mib: 23` |
| device plugin | HAMi (`nodeSelector: gpu=on`) | AMD (`nodeSelector: gpu.vendor=amd`) |
| scheduler for GPU pods | `hami-scheduler` | `default-scheduler` |
| runsc config | `/etc/containerd/runsc.toml` | `/etc/runsc/config.toml` |
| platform | systrap | **kvm** (required by amdproxy) |

## The node network runs over Tailscale, and it has to

`sensai` sits behind NAT on `192.168.0.0/24`; `sens1` is on `128.178.8.0/24`.
sensai can reach sens1, but **sens1 cannot reach sensai at all**. Cilium runs in
VXLAN tunnel mode with `auto-direct-node-routes:false`, so each node must be
able to open a tunnel to the other's node IP — one-way reachability is not
enough. Both nodes therefore use their Tailscale address as the k3s `node-ip`.

That means three things had to line up:

- `node-ip` on both nodes is the Tailscale address, so the Kubernetes
  `InternalIP` — which is what Cilium tunnels to — is reachable both ways.
- The apiserver's serving certificate needs `100.93.194.25` in its SANs.
  Adding `tls-san` alone is not enough on an existing cluster; the old
  `serving-kube-apiserver.{crt,key}` must be deleted so k3s regenerates it.
- Cilium's `k8sServiceHost` was `192.168.0.198`. With `kubeProxyReplacement`,
  every agent dials that address directly, so a Cilium agent on sens1 could
  never have reached the API server. It is now the Tailscale address.

Measured after the move: cross-node pod-to-pod ping 0.99 ms, and DNS from a
sens1 pod resolves against CoreDNS running on sensai.

## Two traps, both silent, both already documented for this project

**containerd on sens1 had no CNI paths at all.** k3s only writes the
`[plugins.'io.containerd.cri.v1.runtime'.cni]` block when it manages CNI itself.
With `flannel-backend: none` it omits the block entirely, so containerd fell
back to the upstream defaults `/etc/cni/net.d` and `/opt/cni/bin` — both empty
on this host — while Cilium wrote its conflist to the k3s paths. The node stayed
`NotReady` with `cni plugin not initialized` *while the Cilium agent was
Running and healthy*, which reads like a Cilium failure and is not one. sensai
never hit this because its `config.toml.tmpl` was hand-edited long ago.

**`pod_annotations` must be on the runsc handler.** Without
`pod_annotations = ["dev.gvisor.*"]`, CRI drops the annotations before they
reach the OCI spec and every pod silently runs with the node-wide ceiling from
`/etc/runsc/config.toml` instead of its own quota. This is the same trap that
bit the NVIDIA side first; it bites AMD identically.

Both fixes live in one containerd drop-in on sens1,
`/var/lib/rancher/k3s/agent/etc/containerd/config-v3.toml.d/10-runsc.toml`
(copy in `manifests/twovendor/`). A drop-in is used rather than a full
`config.toml.tmpl` so it survives a k3s upgrade.

**Verify the annotations actually arrived** rather than inferring it from a
number that looks right:

```sh
ssh sens1 'sudo grep -m1 Args: $(sudo ls -t /var/log/runsc/*.boot.txt|head -1)'
```

`--amdproxy-gpu-memory-limit` on that line must be the *pod's* value, not the
node ceiling.

## One RuntimeClass, two vendors

There is a single `RuntimeClass gvisor` → handler `runsc`. Each node resolves
`runsc` through its own `ConfigPath`, so the same RuntimeClass gives amdproxy
flags on sens1 and nvproxy flags on sensai with nothing vendor-specific in the
pod spec. A pod selects its vendor purely by which resource it requests.

## The quota comes from the request, not from the pod's annotations

`/home/dmd/gpu-quota-webhook/` holds a mutating webhook that turns
`amd.com/gpu-vram-mib` and `nvidia.com/gpumem` into the matching
`dev.gvisor.flag.*` annotations at admission. **Without it the limit is
optional**: neither HAMi nor the AMD device plugin writes those annotations, so
a pod that simply omits them runs with the node-wide ceiling — measured, a pod
requesting 2 × 512 MiB allocated 12032 MiB of a 12272 MiB card.

A pod may still lower its own limit; raising it is overwritten. Verified from
inside a vCluster tenant, where the tenant controls its entire API surface: an
8 GiB self-annotation was rewritten to the 1 GiB it had requested.

It does **not** assign disjoint `amdproxy-cu-mask` values — that needs to know
what the other pods on the node hold, which admission cannot see. Overlapping
masks weaken isolation but do not let anyone exceed a limit; fixing it means
teaching the scheduler, not the webhook.

## Running workloads

```sh
kubectl apply -f manifests/twovendor/both-vendors-quota.yaml    # AMD + NVIDIA quotas
kubectl apply -f manifests/twovendor/both-vendors-compute.yaml  # AMD probe + CUDA kernel loop
kubectl logs -n gpu-test amd-mem
kubectl logs -n gpu-test nv-compute
```

NVIDIA pods need `schedulerName: hami-scheduler`; AMD pods use the default
scheduler and are placed by the `amd.com/gpu-vram-mib` request alone. HAMi's
webhook does not touch AMD pods, since they request no `nvidia.com/*` resource.

## What is verified on hardware

Run simultaneously, one pod per vendor:

- **AMD, sens1** — 2 GiB quota (4 × 512 MiB) and CU mask `0x3f`. Reports
  `2048 MiB`, not the device's 12272; stops at exactly 2048 MiB with `errno=12`;
  `0 MiB` after; `1024 MiB` after freeing half. A second pod at a 1 GiB limit ran
  alongside it with its own distinct ceiling.
- **NVIDIA, sensai** — 512 MiB quota. `cuMemGetInfo` reports `total=512 MiB`
  against a 12227 MiB card; the sixth 64 MiB allocation fails with
  `CUDA_ERROR_OUT_OF_MEMORY` at 320 MiB consumed.
- **No cross-vendor interference** — the CUDA kernel loop scored
  **652.45 launches/s** while the AMD probe saturated its quota on the other
  node, against a 652.32 solo baseline.

## Gotchas worth remembering

- **The AMD probe images are local-only** (`imagePullPolicy: Never`) and live in
  containerd's `k8s.io` store, which `k3s-uninstall.sh` destroys. They are backed
  up at `sens1:~/amdtest/image-backup/*.tar`; re-import with
  `sudo k3s ctr -n k8s.io images import <tar>`. `vecadd:local` was **already
  gone** before this migration and needs rebuilding from `~/amdtest/src/vecadd.hip`
  if you want a real HIP kernel rather than the probes.
- **`gpu_id` is baked into the AMD probe command lines** (`63860` today) and
  changes on reboot. Read it from
  `/sys/class/kfd/kfd/topology/nodes/*/gpu_id` — `~/amdtest/gputest.sh` does.
- **Agent version must not exceed the server's.** sens1 was on v1.36.3 and was
  deliberately joined at v1.36.2 to match sensai.
- Pre-migration cluster state is backed up in `/home/dmd/cluster-backup-*/`,
  including the Cilium Helm values.

## AMD workloads through vCluster: tenant-amd-a/b/c

`tenant-a`/`tenant-b` (above) deliberately leave nodes faked
(`sync.fromHost.nodes.enabled: false`) so a tenant cannot see another
tenant's node conditions. A GPU workload needs the opposite: its own
scheduler must see sens1's real `amd.com/gpu-vram-mib` allocatable and
`gpu.vendor=amd` label, or every pod stays unschedulable in the tenant's own
view. Rather than change tenant-a/b, three new vClusters —
`tenant-amd-a/b/c`, same namespace-per-tenant pattern — get real node sync
scoped to just sens1 via `values/amd-tenant.yaml`:

```yaml
sync:
  fromHost:
    nodes:
      enabled: true
      selector:
        labels:
          gpu.vendor: amd
```

The selector keeps this narrow: a tenant with this overlay learns sens1's
real name, labels and current allocatable, and nothing about sensai or any
other tenant's node. Create with:

```sh
vcluster create tenant-amd-a -n tenant-amd-a \
  --values values/tenant.yaml --values values/amd-tenant.yaml \
  --values values/tenant-amd-a.yaml --connect=false
```

then apply both `manifests/tenant-netpol-amd.yaml` (sed'd for the namespace,
same as tenant-netpol.yaml) and `manifests/tenant-cnp-amd.yaml` (sed'd for
namespace and release name).

**The netpol needs a Cilium-specific addition tenant-a/b never needed.**
tenant-netpol.yaml's admin-access rule allows sensai's LAN IP because
tenant-a/b's control planes run on sensai itself, where an admin client on
the same host reaches them under that address. tenant-amd-*'s control planes
run on sens1, so admin `kubectl` traffic crosses Cilium's cross-node overlay
— and Cilium classifies that traffic by *identity* before it ever checks an
`ipBlock` CIDR. Cross-node host traffic gets the reserved identity
`remote-node`, which no `ipBlock` rule can match, correct guess or not.
`hubble observe --pod tenant-amd-a/tenant-amd-a-0` names it directly:

```
10.42.0.14:_ (remote-node) <> .../tenant-amd-a-0:8443 Policy denied DROPPED
```

`10.42.0.14` is sensai's `CiliumInternalIP` (`kubectl get ciliumnode sensai`),
not its Tailscale or LAN address. Matching `fromEntities: [remote-node]`
needs `CiliumNetworkPolicy`, which is why `tenant-cnp-amd.yaml` is a separate
CRD object layered on top of the plain `NetworkPolicy` pair rather than a
third rule inside it — NetworkPolicies are additive-allow, so this composes.

**Pods that go through this path get `hami-scheduler`, and with it automatic
disjoint CU-mask assignment.** AMD pods placed directly in a bare namespace
use the default scheduler and bypass HAMi's extender entirely; pods created
inside a vCluster go through the real admission path and land on
`hami-scheduler`, which runs the HAMi-gvisor fork's own CU allocator
(`~/HAMi-gvisor/pkg/device/amd/cumask.go`). It **overrides** a manually
supplied `amd.com/cu-mask` rather than trusting it, deriving the count from
the VRAM request. Three tenants each requesting only their own VRAM, with no
CU hint, got genuinely disjoint masks with zero coordination — verified
`A&B == A&C == B&C == 0`.

Verified: three tenants, three different models (Qwen2.5-0.5B,
TinyLlama-1.1B-Chat, SmolLM2-360M) serving 150 requests each concurrently
(~3 min, GPU at 100% throughout), each tenant's `torch.cuda.mem_get_info()`
still showing only its own quota afterward, and tenant-a-style pod-to-pod
isolation holding (a probe from one tenant's pod to another's real pod IP
timed out). See `~/vllm-overhead/PLAN.md` for the full numbers.

## NVIDIA workloads through vCluster: tenant-nv-a/b, plus reusing tenant-c

Mirrors the AMD section above exactly: `values/nv-tenant.yaml` gives real node
sync scoped to `gpu.vendor=nvidia` (sensai). Two paths were tried:

**Upgrading tenant-a/tenant-b in place** (`vcluster create --upgrade`, adding
`--values nv-tenant.yaml`) is safe and non-disruptive — existing pods (coredns,
netprobe) survived untouched. But both namespaces carry their own deliberate
hardening that a GPU workload runs straight into: PodSecurity `baseline`
forbids the `hostPath` the model cache needs, and the Cilium tenant floor
(`manifests/cilium/tenant-floor.yaml`) denies egress even to the cluster's own
excepted pod/service CIDR when the destination is a real in-cluster pod
identity rather than a genuinely external one — confirmed with
`hubble observe` (`Policy denied DROPPED` for traffic to a ClusterIP inside
the "excepted" 10.43.0.0/16), and a scoped `NetworkPolicy` egress allow on top
did not fix it. Left open; needs `cilium policy trace` or map inspection, not
guessing from `hubble observe` alone. **tenant-a/b cannot currently run any
workload needing data from outside its own namespace.**

**tenant-nv-a and tenant-nv-b** — two new vClusters matching `tenant-c`'s
already-working recipe (no PodSecurity hardening, no egress floor) — carried
the actual test, alongside the pre-existing `tenant-c`. Same cross-node netpol
consideration as sens1: control-plane placement is opportunistic, so check
which node it landed on (`kubectl get pods -n <tenant> -o wide`) and apply
`tenant-cnp-amd.yaml`'s `fromEntities: [remote-node]` fix if it's not sensai.

Verified: three tenants, one model, weights 100/50/25 (`harness/tenant-nv.sh`,
`harness/client-nv.sh`), identical 80,944-token KV cache confirming comparable
setups, 768/768 requests succeeded, throughput ordered correctly but
compressed toward equal more than the un-vclustered reference — see
`~/vllm-overhead/PLAN.md` for the numbers and the open question. GPU quota
isolation (`nvidia-smi` still reports the 3072 MiB quota, not the real device)
and pod-to-pod network isolation (cross-tenant probe timed out) both held.
