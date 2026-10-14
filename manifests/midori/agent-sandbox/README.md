# Agent sandboxes on midori: kubernetes-sigs/agent-sandbox

[agent-sandbox](https://github.com/kubernetes-sigs/agent-sandbox) v1.0.6 runs
fine in a midori tenant, because it does not sandbox anything itself: one
sandbox is one pod, and the isolation is the platform's.

- **Kernel:** every tenant pod is a gVisor sandbox (the quota webhook sets the
  runtime class). Commands run as uid 1000 under `4.19.0-gvisor`.
- **Network:** the tenant's Cilium floor, plus the sandbox's own NetworkPolicy,
  which is effective only with the platform's sandbox label (below).
- **Kubernetes:** sandboxes mount no service account token.

NVIDIA OpenShell, which phoenix-claw uses, cannot run here: it builds its own
sandbox from Landlock and seccomp user notification (or root, veth and
nftables), which gVisor does not provide (`../phoenix-claw/README.md`).

## Install (tenant kubeconfig)

```bash
kubectl apply --server-side -f \
  https://github.com/kubernetes-sigs/agent-sandbox/releases/download/v1.0.6/sandbox-with-extensions.yaml
kubectl apply -f sandbox.yaml     # namespace agents, SandboxTemplate + SandboxWarmPool "python"
```

`sandbox.yaml` runs `python:3.12-slim` with `sandboxd` (the v1.0.6 build from
the project's staging registry; there is no release image yet) copied in by an
init container. Agents drive it with the SDK, `pip install
'k8s-agent-sandbox[grpc]==1.0.6'`, in in-cluster Service mode.

## The sandbox label: `midori.phoenix/network: sandbox`

Kubernetes and Cilium policies only ever add allows, and the platform gives
every pod in a tenant intra-tenant traffic, DNS and, per tenant, the internet,
S3 and model providers. A sandbox's own "deny all egress" NetworkPolicy
therefore changed nothing: measured, a sandbox reached example.com and the
model broker.

Pods labelled `midori.phoenix/network: sandbox` are left out of all of those
(`../../cilium/tenant-allow.yaml`, `tenant-sandbox`). They are also selected
default-deny in both directions, with only kubelet probes allowed. A labelled
pod therefore gets exactly what its own NetworkPolicy allows, inside the floor,
and the label can only ever take access away. `sandbox.yaml` puts it on the
template's pods. The managed NetworkPolicy there admits only pods labelled
`app: agent`, on sandboxd's ports, and allows no egress at all.

## Tested (2026-10-14, tenant-agents)

`agent.yaml` (needs the tenant's model link and an API key, see the file):

| check | result |
| --- | --- |
| claim from the warm pool | 0.3-0.4 s |
| kernel / user | `4.19.0-gvisor`, uid 1000 |
| sandbox → internet, DNS, model broker, tenant API, cluster DNS | blocked |
| sandbox → another sandbox | blocked |
| tenant pod without `app: agent` → sandbox | blocked |
| agent → sandbox (sandboxd REST + gRPC) | works |
| model writes code, sandbox runs it, model reports | correct (fib(30) = 832040, SHA-256 of "midori") |

`/etc/hosts` in every pod names the tenant API (`kubernetes.default`). It
resolves, but connections to it are blocked.
