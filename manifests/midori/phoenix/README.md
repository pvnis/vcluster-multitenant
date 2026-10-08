# tenant-phoenix: Phoenix Serving inside its own vCluster

Phoenix Serving (`github.com/midokura/phoenix-serving` @ 9b8513a, unmodified)
serving Qwen3.5-4B on midori, built 2026-10-07.

**tenant-phoenix was deleted on 2026-10-08** (vCluster, namespace and its
volume, floor policies, Prometheus proxy, S3 gateway key, Grafana org and
user). This file stays as the recipe and the record of what it took;
`../../../values/tenant-phoenix.yaml` stays because it is the template for the
vCluster overlay. Its successor is **tenant-phoenix-serving** (4 GPUs, public
internet via `../tenant-internet.yaml`), where the platform layer is installed
as below and the model is left to the tenant's operator.

Unlike vm-nv-dmd1, where the serving control plane was installed cluster-wide
on the host and only the model sat in a tenant namespace (so every request
crossed the tenant boundary), **the whole stack runs inside the tenant's
vCluster**: cert-manager, the CRDs, the AgentGateway and KServe controllers,
the Gateway, the endpoint picker and vLLM. The tenant owns its Gateway API
CRDs, so `GATEWAY_API_ENABLED` stays at its default. Every pod of it is a gVisor
sandbox (vCluster forces `runtimeClassName: gvisor`), including the
controllers.

    vCluster API   https://<any node>:32143   (~/tenants/tenant-phoenix.kubeconfig on cp-0)
    inference      http://<any node>:31226/v1/...   (the Gateway's NodePort)
    model          Qwen/Qwen3.5-4B, 20480 MiB / weight 60 of one A6000
    weights        s3://midori/models/Qwen/Qwen3.5-4B, via the S3 gateway

## Bring-up, in order

All paths are relative to this repo; `$T` is
`~/tenants/tenant-phoenix.kubeconfig`.

1. **Host side** (host kubeconfig), as for any midori tenant: namespace
   `tenant-phoenix` labelled `gvisor=`, `tenant=tenant-phoenix`, PSA
   `baseline`; `../tenant-quota.yaml` (2 GPUs / 92136 MiB),
   `../tenant-netpol.yaml`, `../../cilium/tenant-floor.yaml`,
   `../../cilium/tenant-allow.yaml`, `../tenant-s3-allow.yaml`; then
   `vcluster create tenant-phoenix … --values tenant.yaml nv-tenant.yaml
   midori-tenant.yaml tenant-phoenix.yaml`.
2. **An S3 gateway key** for the tenant: `TENANT_PHOENIX_KEY` in the
   `s3-gateway` Secret (see `../s3-gateway.yaml`).
3. **Stage the weights** from a host with internet (they cannot come from
   inside a tenant). On midori-nv-0:
   `hf download Qwen/Qwen3.5-4B --local-dir …` then
   `rclone copy --exclude ".cache/**" … rgw:midori/models/Qwen/Qwen3.5-4B`.
   **Exclude `.cache/`**: HuggingFace's bookkeeping was 31 of the 45 objects,
   and every extra object and directory costs ~1 s per request on this RGW.
4. **Platform**, from a phoenix-serving checkout (helm 3 and `yq` required):
   `KUBECONFIG=$T OBSERVABILITY_ENABLED=false ./scripts/setup.sh`.
   Observability is off to save the GPU nodes' RAM.
5. **Credentials for KServe's storage-initializer**:
   `KUBECONFIG=$T ./s3-credentials.sh ~/midori-build/s3keys/tenant-phoenix`.
6. **Model**: `KUBECONFIG=$T helm install phoenix-serving charts/phoenix-serving
   -n inference-serving -f values-model.yaml`.
7. **Host side**: `sed s/TENANT/<tenant>/g gateway-ingress.yaml | kubectl apply -f -`, so clients outside
   the cluster reach the Gateway's NodePort.

## Verified

| check | result |
| --- | --- |
| weights through the S3 gateway | 9.3 GB in 328 s (storage-initializer) |
| vLLM inside the sandbox | "Free memory on device (19.74/20.0 GiB)", KV cache 252,646 tokens, 7.71x -- identical to vm-nv-dmd1 |
| host pod | `runtimeClassName: gvisor`, `nvproxy-gpu-memory-limit=21474836480`, `nvproxy-gpu-weight=60`; host `nvidia-smi` shows the process using 17476 MiB of the card's 46068 |
| request inside the tenant (Gateway → EPP → vLLM) | completion returned |
| `GET /v1/models` via the NodePort on nv-0, nv-1 and cp-1 | `["Qwen/Qwen3.5-4B"]` from each |
| 40-token completion via nv-1's NodePort, from cp-0 | 0.83 s |

Not tested: a client outside the cluster. All of the above came from cluster
nodes, which arrive as `remote-node` or `host`; an outside client lands as
`world`, which `gateway-ingress.yaml` also allows.

## What it took, and what to expect

- **The tenant control plane needs more than `tenant.yaml` gives it.** At
  1 CPU / 1Gi it crashed during the CRD install: kine's SQLite reads hit
  DeadlineExceeded, kube-controller-manager lost its lease and exited, and
  helm saw `unexpected EOF`. `../../../values/tenant-phoenix.yaml` raises it to
  4 CPU / 4Gi. The crash left `phoenix-serving-crds` in `pending-install`;
  with no CRs yet, uninstalling that release and re-running `setup.sh` was
  safe.
- **`READY` stays `False / WaitingForGateway`, and that is expected.** The
  KServe controller checks InferencePool acceptance through the v1alpha2 API
  ("Using InferencePool v1alpha2 API for HTTPRoute"), while the pool that
  exists is v1 and *is* `Accepted` by the Gateway. phoenix-serving's own
  deploy notes say to check with a real request instead. Its
  `deploy-serving.sh` waits on that condition, which is why the model was
  installed with plain `helm install`.
- **Weights are fetched on every pod start** (`storage.type: none`): no RWX
  storage on this site, and `local-path` would pin the model to one node. See
  `../OPENSTACK-GAPS.md`, items 3 and 4.
- **The Gateway's LoadBalancer stays `<pending>`** (no Octavia), so clients
  use the NodePort, which the host picked (31226) and which changes if the
  Service is recreated.
- From `helm install` (18:12) to serving (18:41) took 29 minutes, including
  a first weights download that failed on the listing timeout (fixed in the
  gateway with `--use-server-modtime`). Of the measured parts: weights 328 s,
  model load 19 s, torch.compile 69 s and warmup 116 s inside the sandbox.
  The first storage-initializer did not start until 7 minutes after install,
  with its image already on the node; that gap was not explained. The vLLM,
  EPP and storage-initializer images are now pre-pulled on both GPU nodes.
