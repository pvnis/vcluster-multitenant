# phoenix-claw in tenant-phoenix-claw

[phoenix-claw](https://github.com/midokura/phoenix-claw) (MidoClaw: OpenClaw
agents in NVIDIA OpenShell sandboxes) runs inside the tenant's vCluster. Its
model provider is tenant-phoenix-serving's Phoenix Serving Gateway, reached
through the model broker (`../model-provider.yaml`, `../model-consumer.yaml`).

    UI + API         agentic-platform namespace; phoenix-claw main 57eaa10
                     (chart and images 0.0.0-main.765.g57eaa10, from registry.midori)
    OpenShell        0.1.2, one gateway per app tenant (namespace openshell-<sha8>),
                     installed by the chart's lifecycle Job
    sandboxes        agent-sandbox v0.4.6 (bundled into the chart when packaged)
    model            http://tenant-phoenix-serving.model-providers:8080/v1, Qwen3.8-27B
    sign-in          auth bypass; UI reachable only from the cluster's nodes (SSH tunnel)

## Status (2026-10-14): agent sandboxes cannot start under gVisor

Everything up to the sandboxes works: the UI and API, the OpenShell gateway, the
model provider (set, and the path to the Gateway tested end to end). Creating a
sandbox does not:

- OpenShell 0.1.x (phoenix-claw main) runs sandboxes without privileges, and
  replaces them with kernel features it checks for before starting
  (`openshell-sandbox/src/main.rs`, `qualify_runtime`): Landlock ABI v3 or newer,
  seccomp user notification with ADDFD, same-UID task-memory access, socket
  virtualization. gVisor offers neither of the first two: its `seccomp(2)`
  accepts only `SECCOMP_FILTER_FLAG_TSYNC` (`NEW_LISTENER` is EINVAL) and it has
  no Landlock syscalls. The agent container exits with
  `Landlock allow/deny probe: ... fully incompatible access-rights`.
- OpenShell 0.0.116 (the 2026.9-rc.1 release) runs sandboxes as root with
  SYS_ADMIN, NET_ADMIN, SYS_PTRACE, SYSLOG and AppArmor unconfined, which the
  tenant's baseline Pod Security refuses.

Every tenant pod runs under gVisor (the quota webhook sets the runtime class),
so neither runs as the platform stands. The options are a decision, not a fix:
see the session notes / the operator.

## Prerequisites (host side)

1. **The model link**, in the Tenant specs (the controller does the rest):

   ```bash
   kubectl patch tenant tenant-phoenix-serving --type merge -p '{"spec":{"modelProvider":{"enabled":true}}}'
   kubectl patch tenant tenant-phoenix-claw   --type merge -p '{"spec":{"modelProviders":["tenant-phoenix-serving"]}}'
   ```

2. **An API key on the serving Gateway**, issued with Phoenix Serving's own
   script against tenant-phoenix-serving's kubeconfig. Only its hash is stored
   there; the raw key is kept on midori-cp-0, mode 600:

   ```bash
   cd ~/phoenix-serving && umask 077 && KUBECONFIG=<tenant-phoenix-serving kubeconfig> \
     ./scripts/gen-apikey.sh --user phoenix-claw --group mido > ~/midori-build/phoenix-claw-apikey
   ```

   The file ends with a newline. Strip it wherever the key is used: a newline in
   an `Authorization` header ends the header block, and the Gateway then answers
   `LLM request body must be valid JSON`.

3. **The images, copied into registry.midori.** They are private on ghcr.io, and
   copying them keeps any GitHub credential out of the cluster (needs a GitHub
   token with `read:packages` on the copying host only):

   ```bash
   V=0.0.0-main.765.g57eaa10
   for img in agentic-api:$V agentic-ui:$V agentic-lifecycle:$V phoenix-claw:d532ffd; do
     crane copy --insecure ghcr.io/midokura/$img 127.0.0.1:30500/midokura/$img
   done
   ```

4. **The chart, packaged from the commit.** No chart has been published for main
   since July. CI adds the agent-sandbox CRD and controller when it packages;
   the repo's own script does the same:

   ```bash
   git -C ~/phoenix-claw archive 57eaa10 charts scripts | tar -x -C /tmp/claw-src
   (cd /tmp/claw-src && scripts/generate-agent-sandbox.sh && \
    helm package charts/agentic-platform --version $V --app-version $V)
   helm push agentic-platform-$V.tgz oci://127.0.0.1:30500/midokura/charts --plain-http
   ```

## Install (tenant kubeconfig)

```bash
T=tenant-phoenix-claw
kubectl -n tenant-system get secret $T-kubeconfig -o jsonpath='{.data.config}' | base64 -d > ~/tenants/$T.kubeconfig
export KUBECONFIG=~/tenants/$T.kubeconfig
# The chart templates its own release namespace: create it first as Helm's, not
# with --create-namespace (which then collides with the template).
kubectl create namespace agentic-platform
kubectl label ns agentic-platform app.kubernetes.io/managed-by=Helm
kubectl annotate ns agentic-platform meta.helm.sh/release-name=agentic-platform meta.helm.sh/release-namespace=agentic-platform
helm upgrade --install agentic-platform oci://127.0.0.1:30500/midokura/charts/agentic-platform \
  --version 0.0.0-main.765.g57eaa10 --plain-http -n agentic-platform -f values.yaml --timeout 15m
# Host side: let the nodes reach the UI (host kubeconfig).
kubectl apply -f ui-from-nodes.yaml
```

## Model provider

Set per app tenant through the API, which also adds the broker to the
sandboxes' egress profile. From midori-cp-0, with UI = the UI's host Service
ClusterIP (`kubectl -n tenant-phoenix-claw get svc | grep agentic-platform-ui`):

```bash
TOKEN=$(kubectl -n agentic-platform get secret agentic-platform-api -o jsonpath='{.data.AUTH_BYPASS_TOKEN}' | base64 -d)
jq -n --rawfile key ~/midori-build/phoenix-claw-apikey '{
  name: "phoenix-serving", base_url: "http://tenant-phoenix-serving.model-providers:8080/v1",
  model: "Qwen3.8-27B", api_key: ($key | rtrimstr("\n")), reasoning: true }' |
  curl -s -X PUT http://$UI/api/provider -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' --data-binary @-
```

## Use

`kubectl port-forward` cannot reach gVisor pods, so tunnel to the UI's ClusterIP
through a node instead:

```bash
ssh -L 8080:<UI ClusterIP>:80 ubuntu@10.30.30.31     # midori-cp-0
```

Then open http://localhost:8080. Only the cluster's nodes may reach the UI
(`ui-from-nodes.yaml`), so this needs SSH to a node; nobody else on the lab
network can reach it, which matters because the auth bypass lets anyone who
reaches it in.
