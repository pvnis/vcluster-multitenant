# Teleport ZTNA access for Midori tenants

Identity-based, audited access to a tenant's Kubernetes API for agents (and
humans) **without exposing the API server to the internet** — a per-tenant
option (`spec.access.teleport`) replacing the `api.expose` public-VIP+allowlist
path with a zero-trust broker.

**Connecting an agent?** The step-by-step runbook is [AGENT-ACCESS.md](AGENT-ACCESS.md)
(create a bot, install/run `tbot`, use the kubeconfig, revoke, and the self-signed-cert
caveats). This file is the architecture and decisions.

## Why (vs `api.expose`)

`api.expose` trusts a **network location** (source-IP allowlist) and a
**long-lived SA token**, and puts the k8s API on a public VIP. Teleport replaces
all three: **identity** (short-lived certs per agent), **least-privilege** per
session, **no public API surface** (agents dial outbound), and **audit** of every
session. The gVisor / Cilium-floor / per-tenant-quota isolation underneath is
unchanged — blast radius stays one tenant.

## Architecture

```
            (public /26 VIP, the ONLY inbound port)
  agent ──TLS/x509──►  Teleport Proxy ──►  Teleport Auth (CA, roles)   [teleport-cluster, ns teleport]
    │                        ▲
    │ tbot: short-lived      │ reverse tunnel (OUTBOUND from each tenant)
    │ certs (Machine ID)     │
    └────────────────────────┴── teleport-kube-agent (per tenant) ──► tenant vCluster API
                                  registers kube_cluster "<tenant>", impersonates the caller's RBAC
```

- **`teleport-cluster`** (Auth + Proxy) runs once, in ns `teleport`. The **Proxy**
  is exposed on a **public `/26` LoadBalancer VIP** (the same Cilium LB-IPAM + BGP
  mechanism we built) — the single public ingress for the whole platform. Auth is
  private. Standalone to start (one Auth, one Proxy, local/SQLite backend); HA
  later.
- **`teleport-kube-agent`, one per enabled tenant**, runs **host-side** in the
  tenant's namespace, pointed at the tenant's vCluster API (via the
  `<tenant>-kubeconfig` Secret the controller already mints). It **dials outbound**
  to the Proxy (reverse tunnel) and registers the vCluster as Teleport
  `kube_cluster` "<tenant>". **The tenant's API gets no inbound exposure at all.**
  Teleport **impersonates** the caller's k8s identity, so the agent's broad
  kubeconfig is governed by Teleport roles → tenant RBAC.
- **Agents authenticate with Machine ID (`tbot`)** — a sidecar that renews
  short-lived certs; the autonomous sim runner connects *through* the Proxy to its
  own `kube_cluster`, scoped by a Teleport role to a least-privilege Role in its
  namespace. No static token; revoke = disable the bot at Auth.

## The tenant option

```yaml
spec:
  access:
    teleport: true            # register this tenant's API with Teleport
    # the controller then creates, for this tenant:
    #  - a scoped Teleport role (kube_groups -> a namespaced k8s Role)
    #  - a teleport-kube-agent (host-side) registering kube_cluster "<tenant>"
    #  - a join token (kubernetes-SA join; no shared secret)
    #  - a bot (Machine ID) identity for the agent, output as a kubeconfig the
    #    operator hands to the agent (short-lived, auto-renewed by tbot)
```

Mutually exclusive-ish with `api.expose`: once Teleport is the access path, the
public API VIP is unnecessary (keep `api.expose` only as allowlisted break-glass).

## Decisions (defaults chosen; confirm the starred ones)

- **Edition: Teleport Community (OSS), self-hosted.** Free, sufficient for machine
  access + Kubernetes access + audit log. Enterprise only buys SSO beyond
  GitHub, Access Requests, per-session MFA, device trust — not needed for machine
  agents. ★ (switch to Enterprise only if humans need full SSO/approvals.)
- **Proxy public address + cert.** The Proxy needs a public address and a TLS cert
  agents trust. Options: (a) a **DNS name** under the owned public range + ACME
  (cleanest), or (b) the raw `/26` VIP + a **self-signed CA** distributed to
  agents (works air-gapped, no DNS). ★ Which? (I'll default to a hostname +
  self-signed CA until a real DNS name is chosen.)
- **Agent placement: host-side per tenant** (uses the vCluster kubeconfig the
  controller already has; platform-managed; no tenant-sandbox egress needed).
  Alternative: agent *inside* the vCluster (cleaner identity, but a sandboxed
  workload needing egress to the Proxy). ★ Defaulting host-side.
- **Backend: standalone (SQLite on a PVC)** for now; HA (Postgres/etcd + ≥2
  replicas) is a later step.

## Phased plan

1. **Platform** — deploy `teleport-cluster` (Auth+Proxy) in ns `teleport`, Proxy on
   a `/26` VIP (`lb-pool=public`), standalone. Verify Proxy reachable, `tctl`
   works. *(This file's `teleport-cluster-values.yaml`.)*
2. **Wire tenant-sim by hand** — a `teleport-kube-agent` registering its vCluster,
   a scoped role, and a `tbot` agent identity; prove `tsh kube` access end-to-end
   and that it shows in the audit log. Compare against the `api.expose` path.
3. **Controller option** — DONE (code). `spec.access.teleport` (CRD + types +
   UI); component `controller/src/components/teleport.ts` renders the per-tenant
   role + join token (operator CRs) + kube-agent (host) and the impersonation RBAC
   (into the vCluster, via a second client from the `<tenant>-kubeconfig` Secret).
   Templatized as `tenant-teleport-{host,vcluster}.yaml`; 36 unit tests pass,
   typecheck clean. **teleport-operator enabled** (helm rev 2; Auth restarted once,
   Proxy + agent tunnels untouched) and the CR path validated end-to-end — a
   rendered `TeleportRoleV7` + `TeleportProvisionToken` reconcile into Auth on apply
   and are removed on delete. REMAINING: rebuild/redeploy the controller image +
   apply the new CRD + refresh the templates ConfigMap, then flip the flag on a
   disposable tenant (never a real one first — the vcluster lesson).

## Not in scope yet

HA Teleport; human SSO; Access Requests/approvals; app/DB access (Teleport also
brokers those — future); retiring `api.expose` (keep as break-glass until Teleport
is proven).

## Alternatives considered: Teleport vs OpenZiti (for later review)

Raised 2026-11-19: since our access is machine-to-machine (autonomous agents, not
humans), is an overlay mesh like **OpenZiti** a better fit than Teleport? Captured
here for a future revisit; **decision for now: keep Teleport** for this problem.

The real split: OpenZiti is a **protocol-agnostic zero-trust overlay mesh** (secure
any TCP/UDP; embed an SDK so services have zero inbound ports; fully Apache-2.0).
Teleport is a **protocol-aware access broker** (understands SSH/k8s/DB/RDP/web; open-
core, Community = Apache-2.0). "Teleport = humans only" is outdated: **Machine ID
(`tbot`)** is first-class machine identity (issues SPIFFE SVIDs too) — that's what our
agents use.

Why Teleport fits *this* problem (agents → a tenant's **Kubernetes API**, scoped +
audited + no inbound):
- The target is the **k8s API**, a protocol Teleport is deeply aware of, so we get for
  free: k8s-native least-privilege (role → kube_group → namespaced RBAC Role),
  **kubectl-level audit** (verb/resource/namespace — exactly the accountability an
  autonomous-agent platform wants), and per-request L7 authz. OpenZiti would secure the
  *connection* to the API port but is protocol-agnostic — k8s authz + audit would be
  bolted on separately.
- The "no inbound / dark service" property we **already have**: the kube-agent dials
  OUTBOUND (reverse tunnel); the single Teleport Proxy VIP is the only ingress — for a
  multi-tenant platform, one hardened, audited choke point is a feature.
- Our entire usage (Machine ID, k8s access, RBAC scoping, audit) is in Teleport
  **Community (Apache-2.0)**; the Enterprise wall is human-governance (SSO beyond GitHub,
  Access Requests, device trust, per-session MFA, FedRAMP) we don't use.

Reconsider / add **OpenZiti** only if the requirement changes shape: agents need
**arbitrary tenant services over arbitrary protocols** (general mesh, not just the kube
API); zero-trust **embedded in agent/app code via SDK** (truly dark, no agent/proxy hop);
**edge/IoT** or hybrid-cloud machine-to-machine networking; or a hard **no-open-core**
principle. Stack note: in our architecture OpenZiti would overlap **Cilium** (the CNI /
network-policy / BGP layer), not Teleport — so "use both" for us is really *Cilium
(fabric) + Teleport (k8s access broker)*, which is what we have, unless cross-tenant
service-to-service networking becomes a real requirement.
