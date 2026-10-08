# midori: a multi-node GPU cluster on OpenStack (phoenix/tyo)

**Status: built 2026-10-07.** The section directly below records what was
built and measured, and where reality departed from the plan. Everything after
it is the original build plan, kept as written; where the two disagree, **As
built** wins.

## As built (2026-10-07)

    nodes         midori-cp-0/1/2  10.30.30.31 / .48 / .142   2 vCPU, 3 GiB, 19 GB
                  midori-nv-0/1    10.30.30.226 / .54         16 vCPU, 62 GiB, 495 GB
                  Ubuntu 24.04.3, 6.8.0-88-generic (held), all five
    k3s           v1.36.5+k3s1, 3 servers (embedded etcd) + 2 agents
    Cilium        1.19.8, KPR, Socket LB Coverage: Hostns-only (checked)
    driver        610.43.02 open, gpuslicing 423ceb90, built on each GPU node
    runsc         gvisor gpuslicing e6a06cbce (runsc, shim, webhook), systrap
    HAMi          2.9.0, 20 nvidia.com/gpu per node
    vCluster      0.36.1: tenant-nv-a (:31943, 4 GPUs), tenant-nv-b (:32043, 2 GPUs),
                  tenant-phoenix-serving (:32243, 4 GPUs, public internet;
                  Phoenix Serving platform, model left to its operator)
                  [tenant-phoenix (:32143) was deleted 2026-10-08; phoenix/
                  keeps its recipe]
                  kubeconfigs in ~/tenants/ on midori-cp-0
    observability midori-eye-0 (10.30.30.204): Prometheus, Loki, Grafana :30300,
                  an admin view and one view per tenant -- see observability/
    platform      platform-guard.yaml: tenants cannot connect into non-tenant
                  namespaces (found while building observability/)
    gaps          what the site is missing: OPENSTACK-GAPS.md

### Step 0, verified

- 0.1/0.2: both GPU VMs boot with two A6000s each (`10de:2230` at `00:05.0`
  and `00:06.0`), so the flavor/alias question was settled by whoever
  provisioned them. Host-side NUMA cannot be seen from the guest; the guest has
  one NUMA node.
- 0.3: **`NV4` on both nodes**, four links at 14.06 GB/s each. From inside a
  tenant sandbox `nvidia-smi topo -m` shows `NV4` too, peer access is true, and
  a 1 GiB device-to-device copy runs at **49.1 GiB/s**.

### Where the plan did not survive

1. **No Octavia, no cinder-csi.** No OpenStack API credentials were provided,
   only RGW S3 keys. The API endpoint is k3s's own client-side load balancer
   instead: it listens on `127.0.0.1:6444` on *every* node, servers included,
   and `cilium-values.yaml` points there. The agents joined through cp-0 and
   then learn all three servers. Storage is k3s `local-path`, so a vCluster
   control plane is pinned to the node its PVC landed on. Both want an
   OpenStack application credential to fix.
2. **`deployment0:5000` does not resolve from midori.** The registry is
   in-cluster (`registry.yaml`), stateless, with blobs in `s3://midori/registry`
   on RGW. Nodes pull `registry.midori/<image>` via `127.0.0.1:30500`
   (`registries.yaml`). Images are pushed with `crane` (no docker anywhere),
   e.g. the webhook is `FROM scratch` + one static binary, assembled with
   `crane append`. `registry:2.8.3`, not 3.x, whose AWS SDK sends checksum
   headers older RGW rejects.
3. **The RGW certificate is signed by `KollaTestCA`**, which nothing trusts.
   The registry runs with `skipverify`; `s3cmd` on cp-0 has
   `check_ssl_certificate = False`. Install that CA and turn both back on.
4. **The MTU is 1500, not 1450**, and Cilium's `MTU` is the *device* MTU: it
   subtracts the VXLAN overhead for pod routes itself. At `MTU: 1450` pods got
   `mtu 1400` routes; the plan's 1400 would have given 1350. Now `MTU: 1500`,
   pod routes 1450, a 1422-byte DF ping crosses nodes and 1423 is refused.
5. **k3s writes no CNI block for containerd when flannel is off**, on every
   node, not only the GPU nodes. All five sat NotReady (`cni plugin not
   initialized`) with Cilium's conflist on disk until `containerd-00-cni.toml`
   went in.
6. **The site resolvers time out instead of answering NXDOMAIN** for missing
   names under `projects.phoenix.tyo` (10.30.30.10 and .11, from every host).
   Pods inherit that search domain, so every external name first stalls on
   `<name>.projects.phoenix.tyo` and curl gives up. kubelet now gets
   `/etc/rancher/k3s/resolv.conf` (nameservers only, `resolv-conf:` in each
   node's k3s config), so pods search only cluster domains.
7. **A tenant's serving certificate names only its own node.** Through any
   other node's NodePort the network path works -- Hubble shows the
   `remote-node` flow allowed -- and the client fails x509. So midori does need
   an overlay after all: `../../values/midori-tenant.yaml`, carrying every node
   IP as an `extraSAN`.
8. **The host ingress policy is new.** `../tenant-netpol.yaml` admits the node
   by ipBlock, which cannot match cross-node traffic here.
   `tenant-netpol.yaml` in this directory admits the control plane's 8443 from
   `world`/`remote-node`/`host` and 10250 from `remote-node` by
   `CiliumNetworkPolicy`. Layered with `../cilium/tenant-floor.yaml` and
   `../cilium/tenant-allow.yaml`, as `CILIUM-DESIGN.md` describes.
9. Traefik is disabled, so nothing owns the Gateway API CRDs yet.
10. VMs are smaller than planned (above); `tenant-quota.yaml` here is sized
    for 16 vCPU / 62 GiB GPU nodes.

### Results (all pods under runsc, `uname -r` = 4.19.0-gvisor)

| test | result |
| --- | --- |
| host pod, 1 GPU, 40000 MiB / 50 cores | sees 40000 MiB; 112.7 TFLOPS bf16 |
| tenant-nv-b, 2 GPUs × 20000 MiB (`tests/tenant-frac-2gpu.yaml`) | each GPU reports 20000; 18000 on each OK; +5000 on GPU0 refused |
| same pod, NVLink | `NV4` in the sandbox, P2P true, 49.1 GiB/s copy |
| tenant-nv-b asks runtimeClass `nvidia` + self-annotates 48 GiB / weight 100 | still gVisor; narrowed to 10000 MiB / weight 20 |
| tenant-nv-b asks 3 GPUs (quota 2) | refused by the host ResourceQuota, never runs |
| tenant-nv-a, 75/25 on one GPU (`tests/tenant-share-75-25.yaml`) | 83.4 : 31.3 TFLOPS = **2.66 : 1**, sum 114.7 vs solo 112.1 |
| tenant API through each of the 5 nodes' NodePorts | all answer, both tenants |
| intra-tenant pod to pod, incl. cross-node | 15/15 |
| cross-tenant, both directions (one same-node, one cross-node) | 0/15 |
| tenant pod to host API, node IP, internet | 0/15 each |
| gVisor pod (host ns) to ClusterIP, DNS, internet | all work |

The 75/25 pair started 2 s apart in a ~45 s run, which dilutes the ratio a
little; B300 measured 2.8–3.0. Tenant workloads cannot reach the internet or
RGW directly -- that is the Cilium floor working as designed.

### Model weights: the read-only S3 gateway

Tenants read weights through `s3-gateway.yaml`, an `rclone serve s3` pod that
holds the project key and serves `s3://midori/models` read-only as a single
bucket, `models`. Each tenant has its own key (Secret `default/s3-credentials`
inside its vCluster; the halves are in `~/midori-build/s3keys/` on cp-0),
reaches the pods through `tenant-s3-allow.yaml`, and resolves
`s3-gateway.s3-gateway.svc.cluster.local` because `midori-tenant.yaml`
replicates the Service in. The header of `s3-gateway.yaml` says why this
instead of opening RGW in the floor. Upload weights from the host:
`s3cmd put … s3://midori/models/<name>/`.

| from inside each tenant (`tests/tenant-s3.yaml`, twice per tenant) | result |
| --- | --- |
| list buckets / objects | only `models`; its objects |
| GET 64 MiB | sha256 matches the upload |
| PUT, DELETE | refused |
| `s3://registry` | not visible |
| forged secret key | refused |
| direct TCP to RGW (10.30.0.222:6780) | blocked |
| object uploaded on the host, then fetched | visible at once (after `--dir-cache-time=10s`; the 5 min default made it `NoSuchKey`) |

Throughput is bounded by RGW at about 8 MiB/s *per stream*, even direct. The
gateway adds per-request latency, so it needs bigger ranges: 28–30 MiB/s with
aws-cli defaults, 61–83 MiB/s with 16 × 64 MB (direct with defaults: 61–71).
The table is in `s3-gateway.yaml`.

The first run in tenant-nv-a failed to connect at all, right after both
vCluster control planes had restarted for the Service replication; a fresh
pod minutes later, and every run since, connected. Note that a test whose
connections all fail also "passes" every refusal check; `tenant-s3.yaml`
lists and downloads first for that reason.

### Not yet done

The things this cluster exists to prove (below, "What this cluster can prove")
are untouched beyond the 75/25 check: a tenant spanning both GPU nodes, the
`multigpu-shared` case on a bridged pair, and model weights on RGW.

The multi-GPU counterpart to this is `../b300/README.md`, which is one 8× B300
node and whose defects are all fixed. The single-A6000 counterpart is the
`vm-nv-dmd1` work recorded in `gvisor/CLAUDE.md`. **What is new here is
multi-node**: every environment this project has built so far has been a single
node.

    site            phoenix / tyo  (DNS suffix projects.phoenix.tyo)
    GPU nodes       midori-nv-0, midori-nv-1
                      2x RTX A6000 each (GA102, 48 GB, NVLink bridge)
                      >=32 vCPU, >=128 GiB RAM, >=500 GB disk
    control plane   midori-cp-0, midori-cp-1, midori-cp-2
                      4 vCPU, 8 GiB, 100 GB, tainted NoSchedule
    k8s             k3s HA, 3 servers with embedded etcd + 2 agents
    API endpoint    an Octavia load balancer in front of the three servers
    CNI             Cilium, kubeProxyReplacement, socketLB.hostNamespaceOnly
    registry        deployment0:5000 (insecure, already exists at tyo)
    storage         cinder-csi (RBD, RWO) as the default StorageClass;
                    RGW at storage.phoenix.tyo for model weights
    driver          610.43.02 open modules, pvnis/open-gpu-kernel-modules
                      branch gpuslicing (no local edits needed)
    runsc           pvnis/gvisor gpuslicing, systrap (NOT --platform=kvm)
    HAMi            2.9.0 upstream chart
    vCluster        tenant-nv-a, tenant-nv-b

Sizing is from measurement, not taste: vLLM asked 14 GiB request / 20 GiB limit
for a *4B* model, and vm-nv-dmd1's 64 GiB of RAM made a 32 GiB tenant quota
tight with one model running. The vLLM image alone is 8.6 GB and a model cache
PVC is 50 GiB.

---

## Step 0 — verify before provisioning anything

Two of these are the difference between a cluster and a day lost.

1. **VERIFY: is the A6000 SR-IOV capable on the target compute host?**
   `nova.conf.j2` already carries an alias, and it disagrees with this project's
   own documentation:

       alias = {"name":"nva6000vga","vendor_id":"10de","product_id":"2230",
                "device_type":"type-PF","numa_policy":"required"}

   `gpu-infrastructure/docs/016-gpu-pci-passthrough-scheduling.md` — written
   because this exact mistake caused the GPD-1208 outage in BCN — says
   workstation cards, **naming the RTX A6000**, are not SR-IOV capable and are
   therefore `type-PCI`. `is_physical_function()` returns `type-PF` only when
   `sriov_totalvfs > 0`. On the host:

       cat /sys/bus/pci/devices/0000:<bus>:<slot>.0/sriov_totalvfs   # absent or 0 => type-PCI

   Then confirm Nova agrees, because that is the value the filter matches:

       SELECT hypervisor_hostname, address, product_id, dev_type, numa_node, status
       FROM nova.pci_devices pd JOIN nova.compute_nodes cn ON pd.compute_node_id = cn.id
       WHERE product_id = '2230';

   If the alias and `dev_type` disagree, `PciPassthroughFilter` drops every host
   and the scheduler returns `NoValidHost` with nothing pointing at the alias.
   **This plan assumes `type-PCI`.**

2. **VERIFY: are the two A6000s of each pair on the same NUMA node?**
   The alias sets `numa_policy: "required"`. That has been harmless because
   every flavor until now asked for *one* GPU; the passthrough doc calls it "a
   related trap that has not sprung yet". Asking for **two** is what springs it.
   Check `numa_node` for each card in the query above and hand a VM a pair from
   one node. It matters twice over here, because NUMA locality and NVLink P2P
   bandwidth are among the things this cluster exists to measure.
   **This plan assumes same-NUMA pairs.**

3. **VERIFY: the NVLink bridge, and the audio function.** `nvidia-smi topo -m`
   should report `NV4` between the two cards once the guest driver is up; `PHB`
   or `SYS` means the bridge is absent or not usable through passthrough, and
   the 2-GPU NCCL and tensor-parallel tests then measure PCIe instead.
   Separately, `device_spec = {"vendor_id":"10de"}` puts every NVIDIA function
   in the pool including the card's audio function, which usually shares the
   GPU's IOMMU group and has to travel with it — the config already pairs
   `amd9700gpu` with `amd9700aud`, so mirror that.

---

## Step 1 — flavor and VMs

Flavor for the GPU nodes, after fixing `device_type`:

    openstack flavor set <flavor> --property pci_passthrough:alias=nva6000vga:2

Control-plane nodes need no PCI properties.

## Step 2 — base OS on all five nodes

- `chrony`. Three-node embedded etcd is unforgiving about clock skew.
- `/etc/rancher/k3s/registries.yaml` from `registries.yaml` in this directory.
- **GPU nodes: pin the kernel.** The GHOST modules are built out of tree into
  `/lib/modules/$(uname -r)/updates/nvidia-ghost/`. An unattended kernel upgrade
  silently breaks every GPU pod, with no log line that names the cause.
  `apt-mark hold` the kernel and `linux-headers`, and install
  `linux-headers-$(uname -r)` plus the build deps the B300 run needed beyond the
  A100 list: `g++-aarch64-linux-gnu` (the vdso genrule needs `cc1plus`) and
  `libbpf-dev`.

## Step 3 — driver, on the GPU nodes only

As `../b300/README.md` step 1, with two differences: the A6000 is not an
NVSwitch part, so **no Fabric Manager, no `nvidia-imex`, no NSCQ**; and the
driver now reads the TPC count from the GPU, so the build needs no local edit.

- userspace and modules both at **610.43.02** — nvproxy knows that version
  (unsupported-but-known) and does not know 595.x. Remove any Ubuntu
  `*-595-server` / `*-590*` packages including DKMS.
- modules into `/lib/modules/$(uname -r)/updates/nvidia-ghost/`, `depmod`, and
  list them in `/etc/modules-load.d/nvidia.conf` so they survive a reboot.
- `/etc/modprobe.d/nvidia-ghost.conf`: `GhostTpcCount=0`. Current builds are
  inert by default and the probes need `GhostProbe=1`, so this is a safeguard
  against an older build silently capping every CUDA context to a partial TPC
  partition.

## Step 4 — k3s and Cilium

Three servers with embedded etcd, two agents, Cilium replacing both flannel and
kube-proxy:

    # on midori-cp-0
    --cluster-init --tls-san <API_VIP> \
      --flannel-backend=none --disable-network-policy --disable-kube-proxy \
      --disable=servicelb
    # on midori-cp-1, midori-cp-2: --server https://<API_VIP>:6443 + the same flags
    # on midori-nv-0, midori-nv-1: k3s agent --server https://<API_VIP>:6443

Then Cilium from `cilium-values.yaml` here. **Do not skip the verification in
that file**: `cilium-dbg status --verbose | grep "Socket LB Coverage"` must read
`Hostns-only`. If it reads `Full`, no gVisor pod can reach any ClusterIP, and
the symptom will look like broken DNS.

Taint the servers, and label the GPU nodes for HAMi and for the tenant node
selector in `../../values/nv-tenant.yaml`:

    kubectl taint node midori-cp-{0,1,2} node-role.kubernetes.io/control-plane=:NoSchedule
    kubectl label node midori-nv-{0,1} gpu.vendor=nvidia

**Decide Gateway API CRD ownership now.** k3s's traefik chart owns those CRDs by
default, which is why phoenix-serving had to be installed with
`GATEWAY_API_ENABLED=false` on vm-nv-dmd1. Either keep traefik and accept that,
or `--disable=traefik` and let one component own them.

## Step 5 — runsc, on the GPU nodes

- `runsc` and `containerd-shim-runsc-v1` from `pvnis/gvisor` `gpuslicing`.
  Install by `cp` to `.new` then `mv`, because tenant control planes themselves
  run under runsc.
- `/etc/containerd/runsc.toml`: nvproxy, nvproxy-docker,
  nvproxy-allow-unsupported-driver, the scheduler socket, a weight ceiling, and
  deliberately **no node-wide memory ceiling**, so a whole-GPU pod gets the
  whole 48 GB.
- The containerd drop-in **must** carry
  `pod_annotations = ["dev.gvisor.*"]` and the matching
  `container_annotations`. Without it CRI drops every `dev.gvisor.flag.*`
  annotation and each pod silently runs at the node-wide ceiling instead of its
  own quota. This has bitten this project on both vendors. The drop-in must also
  set Cilium's CNI paths, because k3s omits the CNI block when it is not
  managing CNI itself:

      [plugins."io.containerd.cri.v1.runtime".cni]
        bin_dirs = ["/var/lib/rancher/k3s/data/cni"]
        conf_dir = "/var/lib/rancher/k3s/agent/etc/cni/net.d"

- **One `runsc-gpu-scheduler.service` per GPU node**, with
  `--runlist-control=/proc/driver/nvidia/gpusched` and `--measure-usage=false`
  (`--measure-usage` is on by default and divides an ordinary two-pod workload
  *worse* than no scheduler at all). `Restart=always`: the scheduler is
  **fail-closed**, so a GPU pod will not start while it is down, and there are
  now two of them.

## Step 6 — HAMi and the quota webhook

HAMi 2.9.0 upstream, as `../b300/README.md` step 5:
`devicePlugin.passDeviceSpecsEnabled=true`,
`devicePlugin.runtimeClassName=nvidia`, `createRuntimeClass=true`, scheduler
strategy patched to `Recreate`, `ld.so.preload` emptied in the ConfigMap and the
plugin pod deleted. With `deviceSplitCount` 10 the two nodes advertise 20
`nvidia.com/gpu` each.

The in-tree gVisor webhook mints its own CA and server certificate on each start
and writes the CA into the `MutatingWebhookConfiguration` it adopts, so it needs
no certificate Secret. Keep `failurePolicy: Fail` — it is a security property,
not an availability preference: a pod admitted without being mutated carries no
limit annotation and runs at the node ceiling.

## Step 7 — storage, and model weights without RWX

tyo's Ceph provides **block and object, not file**: there are keyrings for
cinder, cinder-backup, glance and nova, and an RGW at `storage.phoenix.tyo`,
but there is no Manila and no CephFS or MDS anywhere in either repo. So **RWX
is not available.**

- Make **cinder-csi** the default StorageClass, reusing the
  `management_cluster_cinder_csi` role rather than k3s `local-path`, which is
  node-local and so breaks a pod that reschedules to the other GPU node.
- For model weights, **use RGW over S3 rather than standing up an NFS VM**.
  phoenix-serving's model preset takes an explicit `uri`, and KServe's
  storage-initializer speaks `s3://`, so push the weights to RGW once and let
  each GPU node pull into its own RWO volume. This is faster and more reliable
  than HuggingFace and uses infrastructure that already exists. A single-replica
  pod can simply carry its RWO volume between nodes; the only real gap is two
  concurrent pods on different nodes wanting the same weights, which the S3
  source removes.

## Step 8 — tenants

As the b300 step 7: namespaces labelled `gvisor=` with PSA `baseline`, host-side
`tenant-quota.yaml` and `tenant-netpol.yaml`, then

    vcluster create tenant-nv-a -n tenant-nv-a \
      --values tenant.yaml --values nv-tenant.yaml --values tenant-nv-a.yaml

**midori needs no environment overlay of its own**, which is worth saying
because every other environment has one. `nv-tenant.yaml` already carries the
only thing that would have gone in it — `sync.fromHost.nodes` selected by
`gpu.vendor: nvidia`, which is generic even though its comment names sensai, and
which here selects both GPU nodes. And unlike b300, tenant NetworkPolicy sync
stays **on**: Cilium is present, so the cluster-scoped deny floor exists and
`tenant.yaml`'s precondition for syncing tenant-authored policies holds.
`b300-tenant.yaml` is the exception, not the pattern.

The caveat that *is* midori-specific belongs to being multi-node. A vCluster
control plane on a different node from its workload crosses the overlay, and
Cilium resolves that traffic to the reserved identity `remote-node` **before**
checking any `ipBlock` — so no CIDR, correct or not, ever matches it, and the
handshake hangs with no RST. Plain NetworkPolicy cannot express "allow this
identity"; only `CiliumNetworkPolicy`'s `fromEntities: [remote-node]` can. If a
tenant cannot reach its own control plane, that is the first thing to check, and
`../tenant-cnp-amd.yaml` is the shape of the fix. `hubble observe --pod <ns>/<pod>`
named it in one line last time.

---

## What this cluster can prove that no previous one could

Single-node multi-GPU is already solved and verified on the B300: per-device
memory limits, and one credit planner per GPU rather than per node. Both of
those were *predicted* as defects from the single-GPU A6000 box and then found
and fixed — defect 4 there measured a lone weight-25 pod getting 894 TFLOPS
instead of ~1330 because tenants on another GPU were draining its credit. The
new ground here is different:

1. **A tenant spanning two nodes.** Each GPU node runs its own
   `runsc gpu-scheduler`, so a tenant's weight applies *per node*. That is
   probably the right semantic, but it has never been checked, and nothing in
   `pkg/gpusched` coordinates across nodes.
2. **GA102 confirmation of the B300 fixes.** Defects 3 and 4 were verified on
   Blackwell only. vm-nv-dmd1 gives an Ampere single-GPU baseline to compare
   against, and the credit scheduler's GA102 numbers are already recorded.
3. **NVLink on a bridged pair**, if step 0.3 confirms it: the `multigpu-shared`
   case — a tenant holding both GPUs while another shares one of them — which
   on B300 gave 1313 TFLOPS on the unshared GPU and 329:1022 on the shared one.
4. **The cross-node vCluster NetworkPolicy path**, which `gvisor/CLAUDE.md`
   records as unresolved: Cilium resolves control-plane traffic from another node
   to the `remote-node` identity before any `ipBlock` is checked, and plain
   NetworkPolicy cannot express that at all.

## Traps carried forward

Each of these cost real time somewhere else in this project.

- `pod_annotations` missing from the containerd drop-in: every per-pod limit
  silently becomes the node ceiling.
- Changing a ConfigMap rolls nothing. `kubectl rollout status` reported success
  on a 42-day-old Cilium pod. Check the pod's AGE.
- `kubectl port-forward` cannot reach a gVisor pod: it dials `127.0.0.1` inside
  the pod netns while the listener lives in the Sentry's netstack. Use a Service
  or the Ingress.
- `docker save` emits blob-less stubs under the containerd image store. Use the
  registry.
- Absence of a log line from the subsystem you suspect is evidence it was never
  reached, not evidence it is quiet.
- On gVisor, `/proc/net/tcp` is not network-namespace scoped, so it will show
  you listeners that the stack in that namespace refuses to connect to.
  `connect()` instead of reading it. See `gvisor/procnet-repro/`.
