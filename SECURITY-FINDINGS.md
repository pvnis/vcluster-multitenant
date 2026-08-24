# Cross-cluster tenancy findings (vCluster layer)

Companion to the gVisor-side `../gvisor/SECURITY-FINDINGS.md`. This file holds the
Kubernetes/vCluster-tenancy findings from the 2026-08-13 red-team, kept out of
the gVisor repo per project convention. The two isolation layers are orthogonal:
findings here are about the cluster-tenancy boundary (vCluster + host syncer),
while the gVisor-side file covers the sandbox GPU boundary. See
`../gvisor/GPU-ISOLATION.md` for how the layers fit together. The red-teamer held only a tenant
vCluster token (tenant-nv-a) and attacked from inside it.

## OPEN — most important unverified avenue

### The vCluster imposes no PodSecurity; the tenancy boundary rests on the host syncer
A `privileged: true` pod mounting `hostPath: /` **passed the vCluster's own
server-side admission** (`kubectl apply --dry-run=server` → created), and a
tenant holds `can-i * *= yes` inside its own vCluster (expected — it is admin of
the *virtual* cluster). So the vCluster does nothing to stop a tenant *authoring*
a host-escape pod spec.

Whether that spec actually gets host privileges depends **entirely on the
host-side vCluster syncer and sensai's node PodSecurity**:
- Does the syncer strip `privileged` / `hostPath` / hostPID/hostNetwork when it
  translates a virtual pod to a real one on the host?
- Does the host node's PodSecurity admission reject a privileged/hostPath pod
  arriving from the syncer's service account?

This was **not** tested end-to-end — launching a real privileged host-mounting
container was (correctly) blocked by the red-team harness's safety guardrail. It
needs an operator to verify host-side, not a tenant-side probe.

**Verify:** author a benign privileged+hostPath pod in a throwaway tenant, let it
schedule, and check on the host whether the synced pod (a) exists with
`privileged`/`hostPath` intact and (b) can read a host path it should not. If the
syncer passes securityContext through unchanged and host PodSecurity is
permissive for the syncer SA, this is a real host-escape for any tenant — a
cluster-tenancy break independent of, and more severe than, anything found at the
gVisor layer.

## HELD
- **SA token scope** — the in-pod service-account token is vCluster-scoped
  (`system:serviceaccount:default:default`, aud `kubernetes.default.svc`) and
  points at the vCluster API (a ClusterIP), not the host API. No host-cluster
  audience.
- **Secrets** — `get secrets -A` inside the vCluster is empty; host secrets are
  not exposed to the tenant.
- **Runtime class** — the tenant cannot escape the Sentry by choosing another
  runtime; the node forces runsc for every pod regardless of `runtimeClassName`
  (see the gVisor-side findings).
