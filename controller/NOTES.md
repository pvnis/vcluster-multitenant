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
