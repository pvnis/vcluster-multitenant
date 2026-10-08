# midori tenant controller: operator's guide

A tenant on midori is **one Kubernetes object**, a `Tenant`
(`midori.phoenix/v1alpha1`, cluster-scoped). The tenant controller turns it
into everything the tenant needs, keeps it that way, and tears it all down
when asked:

| part | what the controller makes |
| --- | --- |
| namespace | `<tenant>`, labelled `gvisor=`, `tenant=<tenant>`, PSA `baseline` |
| quota | ResourceQuota (GPUs, GPU memory, CPU, memory, pods, PVCs) and LimitRange |
| network | ingress policies, the Cilium floor (standard, or public internet), the baseline allow, S3 and scrape allows, optionally the Gateway's ingress |
| vCluster | the tenant's own Kubernetes API (Helm release, gVisor), and a kubeconfig for it |
| S3 | the tenant's key on the read-only model gateway |
| observability | its Prometheus label proxy; its Grafana org, user, datasources, dashboards |
| credentials | one Secret with its S3 key and Grafana login |

There are two ways in: the **web UI** at http://&lt;any node&gt;:30310 (see
[The UI](#the-ui)), and `kubectl` on Tenant objects. Everything below runs on
midori-cp-0 with the host kubeconfig. The
controller itself is `tenant-system/tenant-controller` on midori-eye-0.
History of how it was built and adopted: [NOTES.md](NOTES.md).

## At a glance

```bash
kubectl get tenants
```
```
NAME                     MODE     PHASE   GPUS   INTERNET   API                          DRIFT   AGE
tenant-nv-a              Manage   Ready   4      false      https://10.30.30.226:31943   0       39m
tenant-nv-b              Manage   Ready   2      false      https://10.30.30.226:32043   0       39m
tenant-phoenix-serving   Manage   Ready   4      true       https://10.30.30.226:32243   0       39m
```

- **MODE** `Manage`: the controller applies the spec. `Observe`: it only
  reports what it would change (DRIFT) and writes nothing.
- **PHASE** `Ready` (Manage, all parts applied), `Observing` (Observe),
  `Degraded` (a part failed; see conditions), `Blocked` (deletion refused),
  `Deleting`.
- **API** is the tenant's Kubernetes API, on a NodePort any node serves.

Details for one tenant:

```bash
kubectl get tenant tenant-nv-a -o yaml          # spec, status.conditions, status.drift
kubectl get tenant tenant-nv-a -o json | jq '.status.conditions[] | "\(.type)=\(.status) \(.reason): \(.message)"'
```

The repo's copy of each live Tenant is in [`deploy/tenants/`](deploy/tenants/);
keep it in step (`kubectl diff -f deploy/tenants/<tenant>.yaml` shows any gap).

## The UI

**http://&lt;any node&gt;:30310** (e.g. http://10.30.30.226:30310). Sign in as
`admin`; the password is in `~/midori-build/tenant-ui-admin` on cp-0.

- **Quota commitment** (the top of the page): for GPU attachments, GPU
  memory, GPU time, CPU and memory (DRAM), how much has been **promised** to
  tenants -- their quotas, as one bar stacked by tenant, each in its own
  colour -- against what the GPU nodes have, with a capacity marker and the
  percentage, flagged *overcommitted* past 100%. Below each bar: the
  per-tenant amounts, and what running pods request now -- except GPU
  memory, which shows what tenants **hold** (each slice at its request, each
  whole-GPU pod at a full card, which declares none) and what is **in use**
  on the cards (DCGM), both from Prometheus, the same query as Grafana's
  "GPU memory held" panel. If Prometheus is unreachable it falls back to
  requests and says why. GPU attachments are
  measured against the cards (the worst case: every attachment a whole card);
  a resource no tenant limits says so instead of showing 0. Quotas reserve
  nothing, so overcommitment is a decision, not an error -- this is where it
  is made visible.
- **Tenants**: each tenant's quotas first (GPUs, GPU memory, CPU, memory),
  with what its pods request beneath; status, mode, drift, network, API
  endpoint. Refreshes every 5 seconds; click a row (or Enter) to open it.
- **A tenant**: its spec, every quota line, the controller's conditions and
  any drift; **Show credentials** (Grafana login, S3 key) and **Download
  kubeconfig** for the hand-over; **Edit**; **Switch to Observe / Manage**;
  **Delete…**, which asks for the tenant's name to be typed. In Manage that
  destroys the tenant; in Observe it only stops managing it.
- **New tenant**: the same fields as the [Spec reference](#spec-reference);
  empty CPU / memory / pods / PVCs keep the defaults.

It only ever writes Tenant objects; the controller does the rest, exactly as
with `kubectl`. Both can be used side by side.

**Users** are entries in Secret `tenant-system/tenant-ui-users`: key = user
name, value = a scrypt hash. To add or reset one (the password is read from
stdin, so it never reaches shell history or the process list):

```bash
H=$(printf '%s' 'a-password-of-12-or-more' | node src/ui/hash-password.ts)
kubectl -n tenant-system patch secret tenant-ui-users --type merge -p "{\"stringData\":{\"alice\":\"$H\"}}"
# remove: kubectl -n tenant-system patch secret tenant-ui-users --type json -p '[{"op":"remove","path":"/data/alice"}]'
```

New and changed users work at the next login; no restart. Every login,
create, update, delete, credential view and kubeconfig download is logged:

```bash
kubectl -n tenant-system logs deploy/tenant-ui | grep '"audit":true'
```

**Security**: the UI runs with its own ServiceAccount, which can write
Tenants and read Secrets in tenant-system, quotas and nodes, and nothing
else; it is not cluster-admin (the controller is). Sessions are
HttpOnly/SameSite=Strict cookies held in memory (a restart logs everyone
out); writes also need a custom header and a same-origin Origin (CSRF); the
login backs off after five failures from one address. No pod -- tenant or
platform -- can connect to it. It is **plain HTTP**, like Grafana, because
midori has no certificate infrastructure: use it from the project network
only.

## Create a tenant

Write the Tenant (save it in `deploy/tenants/` too) and apply it:

```yaml
apiVersion: midori.phoenix/v1alpha1
kind: Tenant
metadata:
  name: tenant-example          # must start with tenant-, at most 32 characters
spec:
  management: Manage            # the default is Observe, which creates nothing
  quota:
    gpus: 2                     # GPU attachments: GPU pods x their GPUs (0-40)
    gpuMemoryMiB: 92136         # GPU memory, MiB (an A6000 has 46068)
```

```bash
kubectl apply -f deploy/tenants/tenant-example.yaml
kubectl get tenant tenant-example -w            # Ready in about a minute
```

Everything else has a default (see [Spec reference](#spec-reference)). The
API NodePort is allocated from 31000 upward and shown in `API`.

## Hand a tenant to its operator

Three things, all from `tenant-system`:

```bash
T=tenant-example
# 1. Its kubeconfig (cluster-admin of its own vCluster, nothing on the host)
kubectl -n tenant-system get secret $T-kubeconfig -o jsonpath='{.data.config}' | base64 -d > $T.kubeconfig

# 2. Its Grafana login: http://10.30.30.204:30300
kubectl -n tenant-system get secret $T-credentials -o jsonpath='{.data.grafana-user}' | base64 -d; echo
kubectl -n tenant-system get secret $T-credentials -o jsonpath='{.data.grafana-password}' | base64 -d; echo

# 3. Its S3 key for model weights (s3://models/... via the read-only gateway)
kubectl -n tenant-system get secret $T-credentials -o jsonpath='{.data.s3-access-key}' | base64 -d; echo
kubectl -n tenant-system get secret $T-credentials -o jsonpath='{.data.s3-endpoint}' | base64 -d; echo
```

Pass these on over a private channel. What the operator should know:

- Every pod they create runs under gVisor, whatever it asks for.
- GPU pods ask for `nvidia.com/gpu` (and optionally `nvidia.com/gpumem` and
  `nvidia.com/gpucores` for a slice); the slice is enforced by gVisor.
- Without `network.internet`, the tenant has no internet and no external DNS;
  model weights come from `s3://models/...` through the gateway.
- `kubectl port-forward` cannot reach gVisor pods; use a Service.

## Change a tenant

Edit the Tenant and apply it again, or patch it:

```bash
# more GPUs
kubectl patch tenant tenant-example --type merge -p '{"spec":{"quota":{"gpus":4,"gpuMemoryMiB":184272}}}'

# CPU cores and system memory (DRAM) -- not GPU memory
kubectl patch tenant tenant-example --type merge -p \
  '{"spec":{"quota":{"cpu":{"requests":"20","limits":"36"},"memory":{"requests":"96Gi","limits":"160Gi"}}}}'

# public internet on / off
kubectl patch tenant tenant-example --type merge -p '{"spec":{"network":{"internet":true}}}'

# expose a Phoenix Serving Gateway to clients outside the cluster
kubectl patch tenant tenant-example --type merge -p '{"spec":{"gateway":{"expose":true}}}'
```

The controller applies within seconds of a change, and re-checks every
tenant every 5 minutes.

**The controller owns what it applies.** A hand edit of a tenant's
ResourceQuota, network policies, proxy or Grafana org is reverted on the
next pass; change the Tenant instead.

**Quotas cap; they do not reserve.** The two GPU nodes have 4 GPUs, 32 CPU
and 125.6 GiB of memory between them; the tenants' quotas already add up to
more (`tenant-phoenix-serving` alone may request 96 GiB). Lowering a quota
below what a tenant uses evicts nothing; it only refuses new pods.

## Fractions of a GPU

A pod asks for GPU with three resources (HAMi places it, gVisor enforces it):

| resource | meaning |
| --- | --- |
| `nvidia.com/gpu` | how many GPUs the pod **attaches** to (an integer) |
| `nvidia.com/gpumem` | GPU memory, MiB, **on each** of those GPUs; the sandbox sees exactly that much and allocations past it fail |
| `nvidia.com/gpucores` | share of GPU **time**, 0-100, re-divided continuously; idle neighbours cost nothing |

A fraction is one GPU plus memory and/or time:

```yaml
resources:
  limits:
    nvidia.com/gpu: 1          # one card ...
    nvidia.com/gpumem: 20480   # ... 20 GiB of its 46 GiB
    nvidia.com/gpucores: 50    # ... half its time when busy
```

Up to 10 pods share a card. A pod that names no `gpumem` takes the
**whole** card, and HAMi will not put a fractional pod on a card a whole-GPU
pod holds -- so whole-GPU pods anywhere block sharing on their cards.

The tenant's quota follows the same split:

- `quota.gpus` counts **attachments**, not cards: three pods sharing one
  card use 3. Up to 40 (4 cards x 10 shares). Set it generously for a tenant
  running many small GPU pods.
- `quota.gpuMemoryMiB` bounds the GPU memory its pods request: the
  fractional axis. (A multi-GPU pod's `gpumem` is charged once, though it gets
  that much on each card; gVisor still enforces it per card.)
- `quota.gpuCores` (optional) bounds the GPU time its pods request; 100 = one
  card's time.

Tested on midori: a tenant with 6 attachments, 46068 MiB and gpuCores 100
ran pods asking 60, 60 and 30 of GPU time; the second was refused by the
host quota (`exceeded quota ... requests.nvidia.com/gpucores`), the others
admitted (90 of 100), each with its gVisor memory limit and weight. Earlier,
two tenant pods sharing one A6000 at 75/25 split its compute 2.66 : 1.

The UI's capacity counts attachments against slots (40), and cannot tell a
whole-card attachment from a shared one; a cluster whose four cards are all
held whole reads "4 / 40 slots" and still has room for no fractional pod.
Grafana's "GPU memory held" and DCGM panels show the physical picture.

## Phoenix Serving in a tenant

The controller makes the tenant; installing Phoenix Serving's platform into
it is still a manual step. For a tenant with `controlPlane.size: large`
(Phoenix's CRDs crash a small control plane) and `gateway.expose: true`:

```bash
T=tenant-example
kubectl -n tenant-system get secret $T-kubeconfig -o jsonpath='{.data.config}' | base64 -d > ~/tenants/$T.kubeconfig
cd ~/phoenix-serving && KUBECONFIG=~/tenants/$T.kubeconfig OBSERVABILITY_ENABLED=false ./scripts/setup.sh
# the Gateway's NodePort, for clients outside the cluster:
kubectl -n $T get svc -l gateway.networking.k8s.io/gateway-name=phoenix-serving-gateway -o jsonpath='{.items[0].spec.ports[0].nodePort}'
```

For models loaded from S3 rather than `hf://`, put the tenant's S3 key where
KServe looks for it, in the namespace the model will use:

```bash
c(){ kubectl -n tenant-system get secret $T-credentials -o jsonpath="{.data.$1}" | base64 -d; }
(umask 077; printf '%s,%s\n' "$(c s3-access-key)" "$(c s3-secret-key)" > /tmp/k)   # the newline matters: the script reads it with `read` under set -e
KUBECONFIG=~/tenants/$T.kubeconfig NS=inference-serving ~/vcluster-multitenant/manifests/midori/phoenix/s3-credentials.sh /tmp/k; rm /tmp/k
```

See [`../manifests/midori/phoenix/README.md`](../manifests/midori/phoenix/README.md)
for the model chart values and what to expect (READY stays
`WaitingForGateway` even when it works; test with a request).

## Delete a tenant

Deleting destroys the tenant's control plane, its data and everything in
it, so it takes two steps. A plain delete is refused:

```bash
kubectl annotate tenant tenant-example midori.phoenix/allow-delete=true
kubectl delete tenant tenant-example
```

Without the annotation the Tenant shows `Blocked` and nothing is touched.
With it, the controller removes, in order: the Grafana org and user, the S3
key, the proxy, the vCluster, the cluster-wide policies, the namespace (and
its volume), the credentials and kubeconfig Secrets. About 20 seconds.

**To stop managing a tenant but keep it**, set `management: Observe` first;
deleting a Tenant in Observe only removes the object and leaves the tenant
exactly as it is.

## Observe and Manage

`Observe` never writes. For each part the controller asks the API server for
a server-side **dry-run** of the apply and compares it with what is live;
anything that would change is listed in `status.drift`:

```bash
kubectl get tenant tenant-nv-a -o json | jq -r '.status.drift[] | "\(.change) \(.object) \(.paths|join(" "))"'
```

Use it to adopt an existing tenant (describe it as a Tenant in Observe, read
its drift, then switch), and to preview a change to a shared template. To
switch:

```bash
kubectl patch tenant tenant-example --type merge -p '{"spec":{"management":"Manage"}}'
```

Do that one tenant at a time and check the tenant's workloads after each.

## Spec reference

| field | default | meaning |
| --- | --- | --- |
| `management` | `Observe` | `Manage` applies; `Observe` only reports drift |
| `quota.gpus` | required | GPU **attachments** (sum of pods' `nvidia.com/gpu`), 0-40; see [Fractions of a GPU](#fractions-of-a-gpu) |
| `quota.gpuMemoryMiB` | required | GPU memory, MiB, up to 184272 |
| `quota.gpuCores` | unlimited | GPU time (sum of pods' `nvidia.com/gpucores`), 100 = one card |
| `quota.cpu.requests` / `.limits` | 12 / 24 | CPU cores on the GPU nodes |
| `quota.memory.requests` / `.limits` | 48Gi / 80Gi | system memory (DRAM) |
| `quota.pods` | 30 | pods |
| `quota.persistentVolumeClaims` | 10 | PVCs |
| `network.internet` | `false` | public internet (`../manifests/midori/tenant-internet.yaml`); private ranges, nodes, the OpenStack VIP and the metadata service stay blocked |
| `controlPlane.size` | `small` | `large` = 4 CPU / 4Gi control plane (needed for Phoenix Serving) |
| `controlPlane.apiNodePort` | allocated | fixed NodePort for the tenant API |
| `s3.enabled` | `true` | a key on the S3 gateway |
| `gateway.expose` | `false` | open a Phoenix Serving Gateway to outside clients |
| `observability.dashboards` | `[overview]` | add `serving` for the vLLM dashboard |

## When something is wrong

| symptom | look at |
| --- | --- |
| `Degraded` | `kubectl get tenant <t> -o yaml`: the condition with `reason: Error` names the part and the error |
| `Blocked` | deletion without the annotation; annotate, or set `Observe` to keep the tenant |
| a change does not take effect | `kubectl -n tenant-system logs deploy/tenant-controller` (one JSON line per reconcile) |
| `DRIFT` > 0 in Manage | something changed the tenant behind the controller's back; it is put back on the next pass |
| the controller pod is down | tenants keep working: it is not in their data path. Nothing is reconciled until it is back. |

**Never delete the CRD** (`tenants.midori.phoenix`): it deletes every Tenant
object. Each Managed one would then wait in `Blocked` (no annotation), so no
tenant is destroyed, but recovering means re-applying `deploy/tenants/`.

## Running the controller

```bash
kubectl -n tenant-system get pods                           # one replica, never two
kubectl -n tenant-system logs deploy/tenant-controller -f
```

**After changing a shared template** (any manifest in
[`deploy/templates.sh`](deploy/templates.sh)'s list):

```bash
deploy/templates.sh | kubectl apply -f -
kubectl -n tenant-system rollout restart deploy/tenant-controller
```

It is applied to every Managed tenant within one pass. To preview first, put
the tenants in `Observe`, restart, read the drift, then switch them back
one by one.

**After changing the controller's or the UI's code** (one image, two
Deployments):

```bash
npm test && npx tsc --noEmit
TAG=$(deploy/build-image.sh)                 # no docker: crane, pushed to registry.midori
kubectl apply -f deploy/crd.yaml             # if the CRD changed
sed s/IMAGE_TAG/$TAG/ deploy/controller.yaml | kubectl apply -f -
sed s/IMAGE_TAG/$TAG/ deploy/ui.yaml | kubectl apply -f -
test/ui-api.sh http://10.30.30.54:30310       # login, CSRF, validation, headers ...
```

`test/ui-screens.mjs` screenshots every screen (light, dark, phone) and
reports console and CSP errors; its header says how to run it.

**A read-only check against the live cluster**, from cp-0. Every Tenant is
treated as Observe and nothing is written, not even status; the drift is
printed:

```bash
TEMPLATE_DIR=test/.templates GRAFANA_URL=http://10.30.30.204:30300 node src/main.ts --observe
```

(`--once` instead reconciles each Tenant once in its own mode, so it
applies to Managed tenants.)

## What it does not do yet

- Install the Phoenix Serving platform (or any add-on) into a tenant.
- Put S3 credentials inside a tenant's vCluster.
- Leader election: run exactly one replica (the UI too: its sessions are in
  memory).
- **Google sign-in for the UI** (Midokura Workspace domain, per-user or
  per-group roles) is decided but deferred until a hostname, a certificate
  and a Google OAuth client exist: [GOOGLE-AUTH.md](GOOGLE-AUTH.md). Until
  then the UI has its own users.

Before trusting a change to the controller or its templates against the
live tenants, run `--observe` (above) and read the drift.

It runs as **cluster-admin**, because installing a vCluster with Helm
creates cluster-scoped objects. [`deploy/controller.yaml`](deploy/controller.yaml)
explains how it is contained.
