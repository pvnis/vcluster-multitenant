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
