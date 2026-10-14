# Tenant controller: build notes

How the controller was built and adopted on 2026-10-08, what was tested, and
what went wrong. The operator's guide is README.md.

## Adoption of the running tenants (2026-10-08)

`tenant-nv-a`, `tenant-nv-b` and `tenant-phoenix-serving` were described as
Tenants in Observe (`deploy/tenants/`). Before any reconcile, three one-time
migrations made shared state controller-friendly; each kept every existing
key and password:

1. **S3 gateway keys** moved from per-tenant `--auth-key=$(VAR)` flags in the
   gateway's Deployment to Secret `s3-gateway-tenant-keys` (one entry per
   tenant, digests checked equal), read as files at startup. The gateway now
   **refuses to start with no keys**, because `rclone serve s3` with no
   `--auth-key` serves without authentication (tested in a scratch pod both
   ways). tenant-nv-b's existing key passed the full S3 test afterwards.
2. **Credentials** imported into `tenant-system/<tenant>-credentials`: the
   S3 key from the gateway, the Grafana password from cp-0; each password
   logged in (200) and each key matched before the controller ran.
3. **The admin org's Loki datasource** moved from `grafana-values.yaml` to a
   Secret the controller maintains, loaded by Grafana's datasource sidecar.

Then a resourceVersion snapshot of the 84 objects the controller could write
was taken before and after each Observe pass, locally and in-cluster: **none
changed**. The drift it reports is exactly what is real:

| tenant | drift |
| --- | --- |
| tenant-nv-a, tenant-nv-b | both floor policies would gain the node-identity deny (`egressDeny` 2 -> 3): the security fix in `manifests/cilium/tenant-floor.yaml`; and a kubeconfig Secret to publish |
| tenant-phoenix-serving | a kubeconfig Secret to publish (its floor already has the fix) |

Each test-rendered vCluster values set equals its live release
(`test/render.test.ts`), so switching an adopted tenant to Manage does not
upgrade, and so does not restart, its control plane.

## End-to-end test (tenant-e2e, Manage)

From one object to `Ready` in 68 s, then checked against reality, not status:
namespace labels, quota, LimitRange defaults, `allow-same-tenant`'s `from`,
both floors with the node-identity deny, the proxy, the vCluster pod (gVisor),
the published kubeconfig (nodes listed through it), the S3 key (gateway
restarted to 4 keys; the full S3 test passed from inside the tenant with the
published credentials), Grafana (login, sole Editor membership, dashboard,
Prometheus pinned to the tenant), and the admin Loki header. Deletion without
the annotation: `Blocked`, nothing touched. With it: teardown in 16 s; no
namespace, PV, policy, proxy, Secret, gateway key, Grafana org or user left,
and the admin Loki header updated.

## Bugs found while building it

- **`KubernetesObjectApi.patch` silently drops reserved-word fields.** The
  library's typed models rename `from` and `default` to `_from` and
  `_default`, and its serializer drops the real names, so an apply of
  `allow-same-tenant` would have **lost its ingress `from` -- allowing every
  source** -- and LimitRanges their defaults. Observe surfaced it as drift
  on the first run. All reads, applies and deletes now go out as raw JSON;
  the Manage e2e confirms both fields survive.
- **One field manager across tenants deletes keys.** A server-side apply
  declares all of a manager's fields, so writing tenant B's entry in the
  shared keys Secret under the same manager as tenant A's would remove A's.
  Each tenant's entry has its own manager.
- **Deleting the last managed Tenant left it in the admin Loki header.** The
  "no shared writes in Observe" rule also skipped the removal; once the
  Secret exists the controller always keeps it current.

## Switch to Manage (2026-10-08, 12:51-12:53)

The three adopted Tenants were switched to Manage with `kubectl patch`
(recorded in their managedFields as `kubectl-patch`). That applied the
node-identity floor fix to tenant-nv-a and tenant-nv-b (both floors went
from 2 to 3 egressDeny rules) and published the three kubeconfig Secrets.
No vCluster was upgraded, so no control plane restarted; the operator's
Qwen3.8 replicas in tenant-phoenix-serving kept running.

## Quota fields (2026-10-08)

`spec.quota` gained optional cpu, memory, pods and persistentVolumeClaims;
unset lines keep tenant-quota.yaml's values (unit-tested both ways).
tenant-phoenix-serving was raised to CPU 20/36 and memory 96/160Gi
(requests/limits) through its Tenant; the controller now owns those lines.

## The UI (2026-10-08)

A second Deployment from the same image (`src/ui/`, `ui/`), with its own
ServiceAccount: write Tenants, read tenant-system Secrets, quotas and nodes
-- `kubectl auth can-i` confirmed it cannot read other namespaces' Secrets,
create pods, delete namespaces, touch Cilium policies, create Deployments or
bind roles.

Tested: `test/ui-api.sh` (401s, login, HttpOnly cookie, CSRF header and
Origin checks, validation, typed-name delete, path traversal, security
headers, logout), a full lifecycle through the API only (create -> Ready in
52 s, credentials, kubeconfig download used to list nodes, edit clearing a
CPU override, Observe and back, delete -> namespace, policies, S3 key and
Grafana org gone; each step in the audit log), and reach: a tenant pod that
widened its own egress could not open the UI's Service, pod or NodePort, nor
could a platform pod; the NodePort answers from the nodes.

Headless Chromium screenshots of every screen caught what the API tests
could not:
- the page's CSP (`style-src 'self'`) blocks style ATTRIBUTES, so bar widths
  set with setAttribute would have rendered every usage bar empty; they are
  set through the CSSOM;
- the name field's `pattern` is compiled with the regex `v` flag, under which
  a bare `-` in a character class is invalid -- client-side name checks were
  silently off (the server's still applied);
- the capacity cards said "in use" for quota requests, so a cluster with all
  four GPUs busy read "GPU memory 0.0 GiB in use" (the pods take whole cards
  and request no GPU memory): now "requested", with a note;
- copy buttons and the delete prompt wrapped; a plain chip vanished on a
  hovered row.

And scrypt at N = 2^15 needs exactly Node's default 32 MiB limit, which it
refuses; the unit test had used a small N for speed and missed it. It now
tests the real cost.

## Fractional GPUs in the quota (2026-10-08)

`quota.gpus` was capped at 4, as if it counted cards. It counts
attachments (HAMi's `nvidia.com/gpu` per pod), so the cap made a tenant
unable to run more than four GPU pods however small. Now up to 40 (4 cards x
10 shares, read from HAMi's register annotation), plus an optional
`quota.gpuCores` (`requests.nvidia.com/gpucores`). Tested on a scratch tenant
(6 attachments, gpuCores 100): pods asking 60, 60, 30 of GPU time -> the
second refused by the host quota, the others admitted with their gVisor
memory limit and weight. They stayed Pending ("2 NodeUnfitPod"):
tenant-phoenix-serving's whole-GPU pods held all four cards, which is the
other half of sharing.

The UI's capacity card now counts attachments against slots and shows GPU
time; it cannot tell whole-card from shared attachments without reading
every pod's HAMi allocation (wider RBAC than the UI has), which is recorded
as a limitation rather than granted.

Found on the way: **a UI edit dropped a pinned API NodePort.** The form has
no port field and the patch sends absent optional fields as null; the admin's
edit of tenant-nv-a at 13:47 UTC unpinned 31943 (harmless only because the
controller kept the port from status and the release). Fields the form does
not show are now carried over (unit-tested, and checked live). The audit
trail of that edit came from Loki: the UI pod's own log was gone after a
redeploy, but Alloy had shipped it.

**And a test that created a tenant.** `test/ui-api.sh` probed validation
with `gpus: 9`, expecting a 400. Once the limit went to 40 that was valid,
and the run at 16:30 UTC created a real Manage tenant, `tenant-x`. It was
deleted about a minute later, completely (namespace, policies, proxy,
credentials, S3 key, Grafana org; no volume), but in that minute the S3
gateway rolled twice (key added, then removed) and a Grafana org came and
went. The probes now use values invalid under any limits plus a name the
server always rejects, and the delete probe picks an existing tenant with a
wrong confirmation; a run checks that the set of tenants is unchanged.

## Whole cards charged in full (2026-10-08)

A pod with `nvidia.com/gpu` and no `nvidia.com/gpumem` held whole cards while
the GPU-memory quota charged it 0. The gVisor webhook (gpuslicing
`4409f996b`, `--nvidia-whole-card-mib=46068`) now gives such a container a
card's `nvidia.com/gpumem` per GPU, limit and request, on the host pod only;
`nvidia.com/gpumem-percentage` pods are left alone. Tested on a scratch
tenant `tenant-wcard` (deleted afterwards):

- 2 attachments, 10000 MiB: whole-GPU pod refused (`exceeded quota ...
  requested: requests.nvidia.com/gpumem=46068`), shown in the tenant as a
  SyncError on a Pending pod; an 8000 MiB slice and a 10% pod admitted with
  their own values, quota used 8000.
- 46068 MiB: the whole-GPU pod admitted, host pod limit and request 46068,
  runsc limit 48305799168 bytes, quota used 46068; the tenant's copy of the
  pod unchanged. Host pods' resourceVersions held still for a minute: the
  syncer does not fight the change.

Not tested: a whole-card pod actually *running* under the new limit, as all
four cards were held by tenant-phoenix-serving. The limit equals the card
(nvidia-smi reports 46068 MiB total), so it should constrain nothing. The
first real test is that tenant's next vLLM restart. Its quota, 184272, is
exactly four cards.

tenant-nv-a's GPU memory quota went to 10000 the same day: slices only.

## GPU memory measures cards (2026-10-09)

Attachments counted GPU pods, not cards, so they said nothing about
overcommit. GPU memory is now the measure, with three holes closed in the
gVisor webhook (gpuslicing `8256a2d49`):

- `nvidia.com/gpumem-percentage` was charged nothing: now P% of a card, in
  MiB.
- `nvidia.com/gpucores: 100` makes HAMi give the pod a card alone
  (`HAMi/pkg/device/nvidia/device.go`), yet it was charged only the `gpumem`
  it named: now a full card.
- `gpumem` is per GPU, so a 2-GPU pod was charged once: quotas now bound
  `midori.phoenix/gpu-memory` = gpumem x GPUs, which the webhook sets and
  HAMi's scheduler ignores (hand-added to its ConfigMap).

Decided with the operator: quotas may overcommit (an operator choice); cards
may not, and that is HAMi's placement: a pod that finds no room waits,
Pending. Not rejected at creation: a Deployment would recreate a rejected pod
in a loop, vCluster shows a tenant Pending either way, and a rejecting
webhook would have to repeat HAMi's per-card fit and could race with it.

Tested on a scratch tenant `tenant-gmem` (6 attachments, 46068 MiB; deleted):
25% -> 11517; an 8000 slice -> 8000; a 2-GPU pod claiming
`midori.phoenix/gpu-memory: 1` with 4000 each -> corrected to 8000; then
2 whole GPUs (92136) and `gpucores: 100` + 1000 MiB (46068) refused by the
quota. Admitted pods waited `NodeUnfitPod` (tenant-phoenix-serving holds all
four cards), not "Insufficient midori.phoenix/gpu-memory". A host pod asking
for the resource ran on a node that does not advertise it (kubelet drops it).
Getting around HAMi's placement: a node-pinned pod was refused by HAMi's
webhook ("pod has node assigned"), `default-scheduler` was rewritten to
`hami-scheduler`, and an invented scheduler name leaves the pod Pending for
good.

Found on the way: tenant-phoenix-serving's quota kept the old
`requests.nvidia.com/gpumem` line after the template dropped it. That quota
was created with `kubectl apply` before the controller adopted it, and the
key was co-owned by `kubectl-client-side-apply`, so the controller's
server-side apply could not remove it. Removed by hand (JSON patch). Other
pre-adoption keys may linger the same way.

Not yet seen: a whole-card pod running under the new runsc limit (no card
free). tenant-phoenix-serving's vLLM pods predate all this and are charged 0
until they restart.

## A mode switch the controller missed (2026-10-13)

tenant-phoenix-claw was switched to Observe at 15:16:39 UTC and back to
Manage at 15:16:45. The UI showed it Observing until 15:19:02, the next
periodic resync. After emptying its queue, the worker ran the shared pass
(the admin Loki header) while still marked busy. The watch queued the second
switch, but `drain()` returned at once because the worker was busy, and the
worker never re-checked the queue after that pass. The queue is now
`src/workqueue.ts`, which loops until the queue is empty, shared pass
included. `test/workqueue.test.ts` reproduces the race and fails on the old
logic.

## Model sharing between tenants (2026-10-13)

Asked: phoenix-claw in tenant-phoenix-claw, with tenant-phoenix-serving's
models. The tenant floor denies all tenant-to-tenant traffic, and a deny
can't be overridden, so a direct allow was impossible. The other option,
exempting the pair in both floors, would weaken the floor and tie each
tenant's render to the other's spec. Instead, a broker sits in the neutral
`model-providers` namespace (Tenant `spec.modelProvider` /
`spec.modelProviders`; controller README, "Sharing models between tenants").
Two things were found on the way:

- The platform guard blocks tenant pods from every non-tenant pod; brokers
  are exempted (`app=model-broker`), as the S3 gateway is.
- The first probe from the consumer ran seconds after its vCluster restarted
  for the new replicated Service, and failed. A minute later it passed. Not a
  bug, but worth knowing when testing right after a change.

phoenix-claw itself installs, but its agent sandboxes cannot start under
gVisor: OpenShell 0.1.x requires Landlock and seccomp user notification, and
0.0.116 requires root plus SYS_ADMIN/NET_ADMIN.
`manifests/midori/phoenix-claw/README.md` has the details.

## Agent sandboxes and the sandbox label (2026-10-14)

phoenix-claw's OpenShell cannot run under gVisor, so agent-sandbox v1.0.6 was
tried on a scratch tenant, tenant-agents (`manifests/midori/agent-sandbox/`).
It works: a 0.3 s claim from a warm pool, gVisor sandboxes, and an agent loop
with Qwen3.8-27B through the model broker.

It also exposed a platform gap. A sandbox's own "no egress" NetworkPolicy
did nothing, because policies only add allows and every per-tenant platform
allow (baseline, internet, S3, model providers, and the `allow-same-tenant`
NetworkPolicy) selected every pod. Measured: the sandbox reached example.com
and the model broker. Pods labelled `midori.phoenix/network: sandbox` are now
excluded from all of them and get `tenant-sandbox`: default-deny in both
directions, with only kubelet probes allowed. The label can only remove
access, and it is inert for pods without it: every tenant was re-rendered
with no drift, and the serving gateway and the claw-to-broker path were
checked afterwards.

On the way: the first version excluded sandboxes only from the CNPs. Listing
the rendered objects in the test turned up `allow-same-tenant`, the plain
NetworkPolicy, which still let any tenant pod into a sandbox.
