# Giving an agent Teleport access to a tenant

Runbook for connecting a workload **outside** the midori cluster (an autonomous
agent, a CI job, a developer's laptop) to a tenant's Kubernetes API through
Teleport: identity-based, least-privilege, audited, with **no public API
endpoint** on the tenant. Architecture and rationale are in [DESIGN.md](DESIGN.md).

The access path is: agent → **Machine ID (`tbot`)** → Teleport Proxy (the one
public ingress) → outbound reverse tunnel → the tenant's vCluster. The agent
authenticates with a short-lived identity, not a network location or a long-lived
kubeconfig.

---

## 0. Prerequisite — the tenant has Teleport enabled

Set `spec.access.teleport: true` on the Tenant (the **Zero-trust Teleport access**
checkbox in the console at `https://119.15.113.129/`, or `kubectl edit tenant`).
The controller then registers the vCluster as `kube_cluster "<tenant>"` and creates
the scoped role `<tenant>-access`. Verify:

```bash
kubectl get tenant <tenant> -o jsonpath='{.status.conditions[?(@.type=="TeleportReady")].message}{"\n"}'
# -> kube_cluster <tenant>: 5 applied, 0 ensured absent
kubectl -n teleport exec deploy/teleport-auth -- tctl kube ls   # <tenant> listed, label midori/tenant=<tenant>
```

The controller deliberately creates the registration + the role but **no identity** —
*who* gets access is a per-agent operator decision (the steps below).

---

## 1. Platform operator — grant an agent an identity

Create a Machine ID **bot** bound to the tenant's role (one bot per agent, so each
can be revoked independently):

```bash
kubectl -n teleport exec deploy/teleport-auth -- \
  tctl bots add <agent-name> --roles=<tenant>-access
```

This prints a **join token** (default **1-hour TTL**, and it is **single-use** for
the first join). Also note the Proxy address and CA pin:

```bash
kubectl -n teleport exec deploy/teleport-auth -- tctl status | grep -iE 'Cluster|CA pin'
# Cluster:  teleport.midori.phoenix.tyo
# CA pins:  sha256:2de90ec508c758b13ac81cffbb508ba3812fc7188219a2219e1ba581fb6b670f
```

Proxy: `teleport.midori.phoenix.tyo:443`, public VIP `119.15.113.134`.

If the token lapses before the first successful join, mint a fresh one — the bot
already exists:

```bash
kubectl -n teleport exec deploy/teleport-auth -- tctl bots instances add <agent-name>
```

---

## 2. Agent host — install `tbot`

`tbot` is the Teleport binary; install the version that matches the cluster
(18.11.12) with the Proxy's install script. Because the Proxy currently serves a
**self-signed** cert (see §5), use `-k`, and make the Proxy name resolve to the VIP:

```bash
echo "119.15.113.134  teleport.midori.phoenix.tyo" | sudo tee -a /etc/hosts
curl -k --resolve teleport.midori.phoenix.tyo:443:119.15.113.134 \
  "https://teleport.midori.phoenix.tyo:443/scripts/install.sh" | sudo bash
```

(Container alternative: image `public.ecr.aws/gravitational/tbot-distroless:18.11.12`.)

---

## 3. Agent host — configure `tbot`

`midori-tbot.yaml` (paths in the agent user's HOME so no root is needed):

```yaml
version: v2
onboarding:
  join_method: token
  token: <join-token-from-step-1>
  # NOTE: do NOT also pass --insecure on the CLI — ca_pins and --insecure are
  # mutually exclusive in tbot. With the self-signed Proxy today, --insecure wins
  # (see §5), so this ca_pins line is commented out until a real cert is in place.
  # ca_pins: ["sha256:2de90ec508c758b13ac81cffbb508ba3812fc7188219a2219e1ba581fb6b670f"]
storage: { type: directory, path: /home/<user>/.tbot }
proxy_server: teleport.midori.phoenix.tyo:443
outputs:
  - type: kubernetes
    destination: { type: directory, path: /home/<user>/.tbot/kube }
    kubernetes_cluster: <tenant>
```

---

## 4. Agent host — run `tbot` (daemon)

```bash
tbot start -c midori-tbot.yaml --insecure
```

`tbot start` is a **long-running daemon** — it does not return. It joins once, stores
a **renewable** identity in `~/.tbot` (so the join token is never needed again),
renews the certs every ~20 min, and keeps the kubeconfig fresh. Run it as a
`systemd` service or a sidecar for real use; for a quick test, background it
(`… --insecure &`) or use a second terminal. (`--oneshot` writes once and exits, but
does not renew — not for an agent.)

Success looks like: `Fetched new bot identity`, then `Generated identity for
Kubernetes cluster kubernetes_cluster:<tenant> … roles=[<tenant>-access]`.

---

## 5. TLS today: self-signed Proxy → `--insecure`

The Proxy currently serves Teleport's default self-signed cert (`CN=localhost`),
so a client can't validate it by CA **or** hostname. Therefore:

- `tbot start … --insecure` is the only working option (trust-on-first-use; the one
  unverified handshake is the join). `ca_pins` can't carry the web-cert handshake,
  and `SSL_CERT_FILE` can't fix the `localhost` hostname mismatch.
- `curl` to the Proxy needs `-k` and the `/etc/hosts` entry.

**This all disappears with a real cert.** Two fixes (pick one — see DESIGN.md):

1. **Proper self-signed cert + CA distribution** (no public DNS needed): give the
   chart a cert whose SAN is `teleport.midori.phoenix.tyo`; agents trust the CA via
   `SSL_CERT_FILE`. Drop `--insecure`, use `ca_pins`.
2. **Real DNS + ACME** (TODO(A), cleanest): point a publicly-resolvable name at
   `119.15.113.134`, set `acme: true`. Then no `--insecure`, no `/etc/hosts`,
   no `-k` — the upstream `curl | bash` and `tbot start` commands work verbatim.

---

## 6. Use it — and the scope

Point the agent's `kubectl`/client at the kubeconfig `tbot` maintains:

```bash
export KUBECONFIG=/home/<user>/.tbot/kube/kubeconfig.yaml
kubectl get pods -n default      # ✅ allowed
kubectl create job j --image=busybox:1.36 -n default -- true   # ✅
kubectl get secrets -n default   # ⛔ Forbidden
kubectl get pods -n kube-system  # ⛔ Forbidden
```

The identity is confined to the least-privilege `<tenant>-runner` Role: pods,
pods/log, pods/exec, jobs, deployments, replicasets, configmaps, services, events
in the **`default`** namespace — **no Secrets, no other namespaces, no cluster-scoped
resources**.

`tbot` and `kubectl` must be **co-located** (same host or same pod): the kubeconfig
is exec-plugin based — `kubectl` reads the short-lived creds `tbot` keeps in the
destination dir. An agent packaged as a pod runs `tbot` as a sidecar sharing a volume.

---

## 6b. Discovering resources and limits (how an agent knows what to ask for)

A scoped agent can't `get nodes` or read its `ResourceQuota` (enforced host-side,
not in the vCluster), and it can't guess midori's GPU request model. So the
controller publishes a self-describing **`tenant-capabilities`** ConfigMap into the
vCluster's `default` namespace — the agent reads it with the `configmaps` grant it
already has:

```bash
kubectl get configmap tenant-capabilities -n default -o yaml
```

It contains, per tenant:
- `gpu.vendor` — `nvidia` or `amd`;
- `gpu.request-keys` — the exact keys to set on `resources.limits` and their
  semantics. **NVIDIA/HAMi:** `nvidia.com/gpu` (fractional GPU count),
  `nvidia.com/gpumem` (MiB per GPU), `nvidia.com/gpucores` (% SMs; 100 = exclusive).
  You do **not** set `midori.phoenix/gpu-memory` — the gVisor admission webhook
  derives it from `gpumem × gpus` and charges it to your quota. **AMD:**
  `amd.com/gpu` + `amd.com/gpu-vram-mib` (512-MiB units).
- `gpu.example.yaml` — a ready-to-apply GPU pod;
- `quota` — your effective limits (GPUs, GPU-memory total, CPU, memory, pods);
- `howto.headroom` — how to compute what's free.

**"What's available to allocate" = your quota − your current usage.** No cluster-wide
view is needed (nor exposed): sum the requests of your own running pods and subtract
from the quota.

```bash
kubectl get pods -n default -o json   # sum .spec.containers[].resources.requests
```

Over-quota pods are rejected at admission; a pod that can't be scheduled yet stays
`Pending` — watch `kubectl get events -n default`.

## 7. Operations

- **Audit** — everything the agent does is recorded:
  `kubectl -n teleport exec deploy/teleport-auth -- tctl` (sessions / events), or the
  Teleport web UI on the Proxy.
- **Revoke** — kills access immediately, nothing to rotate out of the agent:
  `tctl bots rm <agent-name>`.
- **List** — `tctl bots ls`, `tctl kube ls`.
- **Disable for the whole tenant** — untick the console checkbox (or
  `spec.access.teleport: false`); the controller tears down the agent, role and token,
  and the operator deregisters the `kube_cluster`.

---

## Gotchas (learned the hard way)

- **`ca_pins` XOR `--insecure`** in `tbot` (not both — unlike the host kube-agent).
  With today's self-signed cert, use `--insecure` and omit `ca_pins`.
- **Self-signed `CN=localhost`** → `SSL_CERT_FILE` won't help (hostname mismatch);
  only `--insecure` works until a real cert (§5).
- **Storage path** — `/var/lib/tbot` needs root; for a user-run agent put `storage`
  and the kube `destination` under the user's HOME.
- **Token** — 1-hour default TTL and single-use; only needed for the *first* join,
  after which `~/.tbot` holds a self-renewing identity. Re-mint with
  `tctl bots instances add <agent-name>`.
- **Daemon, not one-shot** — `tbot start` keeps running; `--oneshot` doesn't renew.
- **Co-location** — the kube output's kubeconfig is `kubeconfig.yaml` and is
  exec-plugin based, so the `tbot` binary must be reachable where `kubectl` runs.
- **`/etc/hosts`** — needed while on self-signed/no-DNS so the Proxy name resolves to
  the VIP.
