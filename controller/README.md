# midori tenant controller

One object per tenant. The controller turns a `Tenant`
(`midori.phoenix/v1alpha1`, cluster-scoped, `deploy/crd.yaml`) into everything
the runbook used to do by hand across a dozen places, keeps it that way, and
tears it all down again. Written in TypeScript on `@kubernetes/client-node`;
Node 24 runs the `.ts` sources directly, so there is no build step.

Built and adopted 2026-10-08. Phase 2 (a UI) is not built.

## Operating it

```bash
kubectl get tenants                       # mode, phase, GPUs, internet, API, drift
kubectl get tenant tenant-nv-a -o yaml    # status.conditions, status.drift
```

**Create a tenant** (here: 2 GPUs, public internet, a large control plane for
Phoenix Serving, its Gateway exposed, the vLLM dashboard):

```yaml
apiVersion: midori.phoenix/v1alpha1
kind: Tenant
metadata: { name: tenant-example }          # must start with tenant-, <= 32 chars
spec:
  management: Manage                        # default Observe: changes nothing
  quota: { gpus: 2, gpuMemoryMiB: 92136 }
  network: { internet: true }               # tenant-internet.yaml instead of the standard floor
  controlPlane: { size: large }             # apiNodePort: allocated if omitted
  gateway: { expose: true }                 # gateway-ingress.yaml
  observability: { dashboards: [overview, serving] }
```

`kubectl apply` it; about a minute later it is `Ready`. Then:

```bash
kubectl -n tenant-system get secret tenant-example-kubeconfig  -o jsonpath='{.data.config}' | base64 -d > tenant.kubeconfig
kubectl -n tenant-system get secret tenant-example-credentials -o yaml   # S3 key, Grafana user/password
```

**Change a tenant**: edit its spec (quota, internet, gateway, dashboards).
The controller reconciles on every change and every 5 minutes.

**Delete a tenant** destroys its control plane and data, so it takes two
steps; a plain `kubectl delete` only reports `Blocked`:

```bash
kubectl annotate tenant tenant-example midori.phoenix/allow-delete=true
kubectl delete tenant tenant-example
```

**Stop managing a tenant without touching it**: set `management: Observe`;
deleting a Tenant in Observe leaves the tenant exactly as it is.

## What one Tenant becomes

| component | objects | from |
| --- | --- | --- |
| Namespace | namespace with `gvisor=`, `tenant=<name>`, PSA baseline | code |
| Quota | ResourceQuota, LimitRange | `manifests/midori/tenant-quota.yaml` |
| Network | ingress policies, Cilium floor (standard or internet), baseline allow, S3 allow, scrape allow, optional gateway ingress | `manifests/midori/tenant-netpol.yaml`, `manifests/cilium/tenant-floor.yaml` or `manifests/midori/tenant-internet.yaml`, `manifests/cilium/tenant-allow.yaml`, `tenant-s3-allow.yaml`, `observability/tenant-scrape-allow.yaml`, `phoenix/gateway-ingress.yaml` |
| VCluster | Helm release of vcluster 0.36.1, kubeconfig Secret | `values/tenant.yaml`, `nv-tenant.yaml`, `midori-tenant.yaml` + port/size overlay |
| S3 | the tenant's entry in `s3-gateway/s3-gateway-tenant-keys`, a gateway restart | |
| Metrics | `prom-proxy-<tenant>` (prom-label-proxy) | `observability/tenant-prom-proxy.yaml` |
| Grafana | org, user (Editor, sole membership), Prometheus + Loki datasources, dashboards; the admin org's Loki tenant list | `observability/dashboards/*.json` |

The templates **are** the runbook's manifests: `deploy/templates.sh` packs
them into the `tenant-templates` ConfigMap, so the controller cannot render
anything the runbook would not. After changing one, re-run it and restart the
controller.

Credentials for each tenant live in `tenant-system/<tenant>-credentials`;
existing values are kept, so a key or password is generated only once.

## Observe and Manage

`spec.management: Observe` (the default) never writes. For each object the
controller asks the API server for a **server-side dry-run apply** and
compares the result with the live object; whatever would change is listed in
`status.drift` (`create`, `update` with the JSON paths, `delete`). For the
vCluster it compares the Helm release's values; for Grafana it inspects the
org, user, memberships, datasources and dashboards. `Manage` applies.

Adopted tenants start in Observe so their drift can be reviewed before the
controller writes anything. This is also how a change to a shared template
reaches tenants: it shows up as drift on each, and takes effect tenant by
tenant as each is switched to (or already is in) Manage.

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

## Limits, and what comes next

- **No add-ons yet.** The Phoenix Serving platform (`setup.sh`) is still run
  by hand into a new tenant; a `spec.addons` field is the next step.
- **No S3 credentials inside the vCluster.** The controller publishes them in
  `tenant-system`; putting them into the tenant (e.g. for KServe) is still
  manual.
- **cluster-admin.** Needed to install vClusters with Helm; see
  `deploy/controller.yaml` for how it is contained.
- **One replica, no leader election.** Never run two.
- **The UI** is phase 2.
- `manifests/midori/observability/grafana-tenants.py` is superseded for
  Tenant-managed tenants; do not run it against them.

## Build and deploy

```bash
npm test                                           # renders the real manifests; vCluster values vs live releases
npx tsc --noEmit
TAG=$(deploy/build-image.sh)                       # no docker: crane, pushed to registry.midori
kubectl apply -f deploy/crd.yaml
deploy/templates.sh | kubectl apply -f -
sed s/IMAGE_TAG/$TAG/ deploy/controller.yaml | kubectl apply -f -
```

Run it once locally against the cluster, Observe only, from cp-0:

```bash
TEMPLATE_DIR=test/.templates GRAFANA_URL=http://10.30.30.204:30300 node src/main.ts --once
```
