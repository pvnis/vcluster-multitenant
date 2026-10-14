# What midori is missing from the tyo OpenStack

What the cluster needed from the site and did not get, measured from midori
on 2026-10-07. Each entry says what is missing, how that was established, what
it costs today, the workaround in place, and what would close it. The
workarounds are described in `README.md` ("As built") and the manifests here.

In order of how much each would change.

## 1. No OpenStack API credential for the project

**Missing.** Only an RGW S3 key pair was provided. There is no
`clouds.yaml`, no `OS_*` environment and no application credential, so nothing
in the cluster can call Nova, Neutron, Cinder or Octavia, although all of them
answer on the VIP (`openstack-lab.phoenix.tyo`: Keystone 5000 → 300, Nova
8774 → 200, Neutron 9696 → 200).

**What it blocks.** Items 2 and 3 below, and any check of the Neutron port
settings (allowed-address-pairs) that a self-managed VIP would need.

**Ask.** An application credential scoped to the midori project, with roles
for Octavia load balancers and Cinder volumes.

**2026-10-14: partly provided.** An application credential `octavia-api-key`
(project 083326ef…, role `load-balancer_member` only) authenticates and its
catalog lists Octavia at :9876. But Octavia refuses every call, even listing
the project's own load balancers or providers: `403 Policy does not allow this
request`. That is consistent with a deployment on the new default policies,
which also require the Keystone `member` role. Neutron with this token shows
only the two shared networks (management-net, external-net), and none of the
project's networks, ports, routers or floating IPs. Nova listing is 403. Kept
on midori-cp-0 at `~/midori-build/octavia-appcred` (mode 600), never in git.
Still needed: the same credential with `member` as well.

**2026-10-14, later: provided.** A second credential with
`load-balancer_member`, `member` and `reader` works for Octavia (provider
`amphora`, unlimited quota), Neutron and Nova. It replaced the first in the same
file.

## 2. No load balancer (Octavia)

**Missing.** Without item 1, Octavia cannot be used.

**Costs.**
- The Kubernetes API has no single address. Cilium uses k3s's client-side
  balancer on `127.0.0.1:6444` (on every node, servers included), and the
  agents joined through midori-cp-0's IP. Kubeconfigs name one server.
- Every `type: LoadBalancer` Service stays `<pending>`. Phoenix Serving's
  Gateway in tenant-phoenix is one: it is reachable only on a NodePort.
- Tenant API servers are NodePorts too (31943, 32043, 32143), on any node's
  IP. `values/midori-tenant.yaml` exists because each tenant's certificate
  must then name all five node IPs.

**Ask.** Octavia, via item 1, plus the Octavia cloud-controller or
`openstack-cloud-controller-manager` to fill in `status.loadBalancer`. The
site's alternative, a kube-vip or Cilium L2 VIP, needs Neutron
allowed-address-pairs on the node ports, which also needs item 1 to set.

**2026-10-14: Octavia works.** Test load balancer `midori-lbtest`:
- VIP 10.30.30.71 on the project subnet `vpn_public_network` (10.30.30.0/24),
  no floating IP, TCP 80 to NodePort 30310 on the three servers;
- the amphora booted in about 75 s and all three members are ONLINE;
- 5 of 5 requests answered.

At first the members were all ERROR: the nodes had only the project's shared
`default` security group, which does not admit the amphora, whose ports
belong to Octavia's service project. Fixed with a dedicated group,
`midori-nodeports` (686ee69e…): TCP 30000-32767 from 10.30.30.0/24, attached to
the five midori nodes beside `default`. `default` is untouched, since other
people's VMs in the project use it. 10.30.30.0/24 includes those VMs, but a
tighter source would need the amphora's address, which only Octavia admins
see.

Floating IPs come from `external-net`, 119.15.113.0/24: part of Midokura
Japan's 119.15.112.0/20 (APNIC), announced by AS55393 and seen by 325 of 326
RIPE RIS peers, so globally routable. The TYO router's last firewall rule
drops all traffic from the internet to that range, and only the office and VPN
ranges and an operators list are let in before it. The site team will open
other source ranges.

Since then (2026-10-14):
- `type: LoadBalancer` Services get Octavia load balancers through the
  openstack-cloud-controller-manager. Each tenant is allowed a number of them
  by the admin; floating IPs are opt-in per Service (`occm/README.md`).
- The Kubernetes API has one address, 10.30.30.106:6443 (`k8s-api-lb.md`).
- `midori-lbtest` was deleted.

## 3. No block storage for pods (Cinder CSI)

**Missing.** cinder-csi needs item 1. The default StorageClass is k3s
`local-path`, which is node-local.

**Costs.**
- Each vCluster control plane's SQLite PVC is pinned to the node it first
  landed on. Losing midori-nv-0 or midori-nv-1 takes down the tenants whose
  control plane lives there, until the node returns. (tenant-nv-a and
  tenant-phoenix are on nv-1, tenant-nv-b on nv-0.)
- Nothing a workload writes survives a reschedule to the other GPU node.

**Ask.** As item 1; the plan's `management_cluster_cinder_csi` role is the
intended deployment.

## 4. No shared filesystem (no Manila, no CephFS)

**Missing.** No RWX volume type. This is from the plan's inventory review
(no Manila and no CephFS/MDS in `phoenix-inventories` or
`gpu-infrastructure`), not re-checked live. The Ceph public network itself
(`storage.phoenix.tyo`, 10.33.0.61–63) is not reachable from midori on 80,
443, 6780, 7480 or 8080.

**Costs.** Phoenix Serving's multi-node preset wants one RWX model cache
(`storage.type: shared`). Without it, every model pod start downloads the
weights again through the S3 gateway: Qwen3.5-4B, 9.3 GB, took 328 s.

**Ask.** Manila with the CephFS driver, or a CephFS share exported to the
project network.

## 5. The site registry is unreachable

**Missing.** `deployment0` (the plan's name) does not resolve.
`deployment0.phoenix.tyo` resolves to 172.20.0.250, but nothing answers on
5000 over HTTP or HTTPS from midori: routed via 10.30.30.1 and filtered or
dropped.

**Costs.** An in-cluster registry (`registry.yaml`) on
`s3://midori/registry`; images are pushed with `crane`. Its own image comes
from Docker Hub, so it cannot be served from itself.

**Ask.** A route and firewall rule from the project network to
172.20.0.250:5000, or a pull-through mirror the projects can reach.

## 6. RGW's certificate is signed by an undistributed test CA

**Missing.** `openstack-lab.phoenix.tyo:6780` presents a certificate issued
by `CN = KollaTestCA`, which no trust store has, and only the leaf is sent.

**Costs.** TLS verification is off on every RGW client: the registry
(`REGISTRY_STORAGE_S3_SKIPVERIFY`), the S3 gateway (`--no-check-certificate`),
`s3cmd` on midori-cp-0, and `rclone` on midori-nv-0.

**Ask.** The KollaTestCA certificate (or a certificate from a CA that is
distributed). Then install it on the nodes and turn the checks back on.

## 7. One S3 credential for the whole project

**Missing.** No way to make per-tenant RGW users or keys. That needs RGW
admin access, or Keystone EC2 credentials per user, which also needs item 1.

**Costs.** No tenant can be given RGW access directly: with the project key
it could read the other tenants' data and rewrite `s3://midori/registry`,
including image tags the nodes pull. The S3 gateway (`s3-gateway.yaml`) holds
the key instead and serves `models/` read-only to all tenants alike; per-tenant
keys there identify a tenant but do not separate its data.

**Ask.** Per-tenant RGW users (or subusers) with bucket policies, so a
tenant can have its own writable prefix.

## 8. RGW shares a VIP with the OpenStack APIs

**Missing.** RGW (6780) is on the same address as Keystone, Nova and Neutron
(10.30.0.222).

**Costs.** The tenant egress floor cannot open RGW by address: a Cilium deny
cannot be narrowed to "everything but 6780", and tenants can widen their own
policies, so an exception for RGW would expose the control-plane APIs to every
tenant. One reason the gateway exists.

**Ask.** RGW on its own address (or a hostname resolving to one), so it can be
allowed alone.

## 9. RGW is slow per request

**Measured**, direct from midori-cp-0: a recursive list of one model prefix
1.0–1.1 s; a 3 KB GET 1.9 s; one stream about 8 MiB/s
(aws-cli with concurrency 1); with aws-cli defaults, 61–71 MiB/s.

**Costs.** Everything depends on parallel ranges, and anything that issues
many small requests suffers. Through rclone, which issued a HEAD per object,
listing Qwen3.5-4B took 50–71 s and KServe's storage-initializer timed out
(fixed with `--use-server-modtime`: 5.6–8 s). Through the gateway with KServe's
defaults the weights arrive at ~27 MiB/s.

**Ask.** Worth a look on the RGW side (HAProxy in front of it, RGW thread
pool, or the Ceph cluster itself): a second per small request is
unusually slow.

## 10. The site resolvers time out instead of answering NXDOMAIN

**Measured.** 10.30.30.10 and .11 time out, from every midori host, on any
name that does not exist under `projects.phoenix.tyo` (it answered NXDOMAIN
once, at first, then never). Names that exist resolve, and so do missing
names under other zones (`example.org` → NOERROR).

**Costs.** Pods inherited that search domain, so every external lookup first
stalled on `<name>.projects.phoenix.tyo` and `curl` gave up. kubelet now gets
`/etc/rancher/k3s/resolv.conf` with no search domain. Any other client on
the project network that relies on the search list has the same stall.

**Ask.** Fix the resolver (or Designate backend) to answer NXDOMAIN.

## Not gaps, but different from the plan

- **Flavors.** The control planes are 2 vCPU / 3 GiB / 19 GB and the GPU
  nodes 16 vCPU / 62 GiB / 495 GB; the plan asked for 4 / 8 / 100 and ≥32 /
  ≥128 / ≥500. CPU and memory quotas, not GPUs, bind tenants first.
- **MTU** is 1500 end to end (the plan expected a 1450 VXLAN network).
- **GPU passthrough** works: two A6000s per VM, with `NV4` NVLink between them.
  Host NUMA placement cannot be seen from the guest, and confirming the alias's
  `device_type` would need the Nova database.
