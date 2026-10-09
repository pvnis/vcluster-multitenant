# Choosing GPU types for models on a mixed-generation cluster

**Status: design for discussion (2026-10-09).** Nothing here is built. It
extends [controller/MIXED-GPUS.md](controller/MIXED-GPUS.md), which covers only
quota and whole-card accounting, to the larger question: which model should run
on which kind of card, and how the system decides.

## The question

midori has four RTX A6000s today. Clusters grow by generations, so we should
expect A6000s next to Ada (L40S, RTX 6000 Ada), Blackwell workstation cards
(RTX PRO 6000) and perhaps Hopper or Blackwell data-centre parts. Phoenix
Serving runs many models at once, of different sizes and precisions, and routes
requests to them by name. We want each model deployment to land on the GPU type
and fraction that serves it best, without an operator working that out by hand
for every model and every new card.

Two short answers first.

**Is this a HAMi enhancement?** Mostly no. Choosing a GPU type for a model needs
facts the scheduler never sees: the checkpoint's precision, the vLLM engine
settings, the context length, the traffic and the latency targets. HAMi's job is
to *enforce* a choice and pack devices. That part already works through the
`nvidia.com/use-gputype` / `nouse-gputype` pod annotations, which filter cards by
type during placement (`HAMi/pkg/device/devices.go:792-815`, applied in
`pkg/device/nvidia/device.go:1003-1022`). The decision belongs in the serving
layer. A few small HAMi changes would help, and are listed under "HAMi" below.

**Does HAMi have this problem in mind?** No. In HAMi, "heterogeneous" means
several vendors (NVIDIA, Ascend, Cambricon, and others), not several NVIDIA
generations. Its scheduler has no cost or type preference: its node and device
scores count only used slots, cores and memory (`pkg/scheduler/policy/node_policy.go:106-130`,
`gpu_policy.go:200-230`). Per-model resource names exist only for Ascend chips
(`charts/hami/values.yaml`, `devices.ascend.configs`). There is no issue,
proposal or roadmap item for model-aware or cost-aware type selection. HAMi's
2026 roadmap is about adopting Kubernetes DRA (Dynamic Resource Allocation, the
newer API for requesting devices by their attributes) through the separate
HAMi-DRA project ([CNCF, 2026-08](https://www.cncf.io/blog/2026/08/07/does-kubernetes-dra-replace-hami/)).
That would give us better tools to express a choice, but nothing that makes one.

## What decides the right GPU

Four things decide which card suits a model. The first two are hard
constraints. The second two are preferences.

**1. Precision support.** A checkpoint's number format needs particular hardware.
This matters more as models ship in FP8 and FP4:

| Generation (compute capability) | Cards | BF16 | FP8 W8A8 | INT4 AWQ/GPTQ (Marlin) | NVFP4 / MXFP4 | Attention, FP8 KV cache |
|---|---|---|---|---|---|---|
| Ampere (8.0, 8.6) | A100, **A6000** | yes | no; FP8 checkpoints run weight-only (W8A16 Marlin) | yes | weight-only Marlin fallback | FA2 (no FP8 KV); FlashInfer/Triton for FP8 KV |
| Ada (8.9) | L40S, RTX 6000 Ada | yes | yes | yes | weight-only | as Ampere |
| Hopper (9.0) | H100, H200 | yes | yes, best | yes | weight-only | FA3, FP8 KV |
| Blackwell DC (10.0) | B200, B300 | yes | yes | yes | native | FlashInfer/FA4, FP8 KV |
| Blackwell (12.0) | RTX PRO 6000 | yes | yes | yes | native, kernels still immature | check per vLLM release |

Sources: vLLM [FP8](https://docs.vllm.ai/en/stable/quantization/fp8.html),
[quantization](https://docs.vllm.ai/en/stable/features/quantization/) and
[attention backends](https://docs.vllm.ai/en/latest/design/attention_backends/);
LLM Compressor [scheme minimums](https://docs.vllm.ai/projects/llm-compressor/en/latest/steps/choosing-scheme/);
SM120 FP4 reports on [discuss.vllm.ai](https://discuss.vllm.ai/t/sm120-rtx-pro-6000-nvfp4-moe-performance-report-qwen3-5-397b/2536).

"Runs" is not the same as "runs well". An FP8 checkpoint loads on an A6000 but
gets none of FP8's compute speed-up. NVFP4 loads on anything from Ampere up but
is native only on Blackwell. Phoenix Serving already records this, in comments
only: `profiles/qwen38-nvfp4-nvidia-x1.yaml` says "needs Blackwell sm_100/120",
and `qwen38-int4-nvidia-x1.yaml` says A6000 runs it through Marlin W4A16.

**2. Memory fit.** The card, or the fraction of it, has to hold:

- the weights at the chosen precision,
- the KV cache for the context length times the concurrency we promise
  (KV bytes per token = 2 x layers x KV heads x head size x bytes per element;
  for example about 128 KB per token for an 8B Llama-3 in FP16),
- 10-30% for activations and runtime overhead.

A model that fits only at short context or low concurrency is a different
deployment from the same model at full context. The fit check is therefore on
(model, precision, context, concurrency), not on model size alone.

**3. Speed of each phase.** Generating tokens (decode) reads all the weights for
every token, so it is limited by memory bandwidth. Processing the prompt
(prefill) is limited by compute. So small, chatty models are ranked by
bandwidth per unit of cost, and long-prompt or RAG models by compute per unit of
cost:

| Card | Memory | Bandwidth |
|---|---|---|
| RTX A6000 | 48 GB | 768 GB/s |
| L40S | 48 GB | 864 GB/s |
| RTX 6000 Ada | 48 GB | 960 GB/s |
| RTX PRO 6000 Blackwell (server) | 96 GB | 1.6 TB/s |
| A100 80 GB | 80 GB | ~1.9-2.0 TB/s |
| H100 SXM | 80 GB | 3.35 TB/s |
| H200 | 141 GB | 4.8 TB/s |
| B200 | 180-192 GB | 8 TB/s |

The figures come from the datasheets and secondary sources linked in the
research notes. They are inputs to an estimate, not measurements.

**4. Scarcity.** A 96 GB card is the only home for some models. Filling it with a
4B model that would be equally happy on an A6000 strands it. A good choice
favours the smallest class that serves a model well, and saves the
large-memory classes for models that need them.

## Prior work

Published work agrees on the shape of the solution: a hard feasibility filter,
then a cost minimisation that uses measured profiles.

- **Mélange** ([Griggs et al., 2024](https://arxiv.org/abs/2404.14527)) models
  the choice of GPU mix as cost-aware bin packing, solved with an ILP in about a
  second. Its main finding: the cheapest GPU depends on request size, rate and
  latency target, not on the model alone. Small requests with loose targets
  belong on cheap cards. It needs a one-off profile per GPU type (under an hour
  each), the request-length histogram, the rate, the time-per-token target and
  the cost of each card. It is offline and simple to adopt. It saved up to 77%
  against a single GPU type.
- **AIBrix's GPU optimizer** ([docs](https://aibrix.readthedocs.io/latest/features/heterogeneous-gpu.html),
  [paper](https://arxiv.org/abs/2504.03648)) is the one production
  implementation:
  - one Deployment per (model, GPU type), all sharing a model label;
  - benchmark profiles per pair;
  - the gateway's request traces feed a Mélange-style ILP, which outputs replicas
    per GPU type as an autoscaler metric.

  Its limits: it assumes whole GPUs and needs a benchmark for every pair.
- **llm-d's workload variant autoscaler** ([arXiv 2603.09730](https://arxiv.org/abs/2603.09730))
  scales "variants" (the same model on different accelerators) and prefers the
  cheaper ones. llm-d has since deprecated its CRD in favour of KEDA (Kubernetes
  event-driven autoscaling) plus the endpoint picker
  ([docs](https://llm-d.ai/docs/architecture/advanced/autoscaling)). The
  *variant* concept is the useful part.
- **Coral** ([arXiv 2605.04357](https://arxiv.org/abs/2605.04357), May 2026)
  optimises **many models** at once over a mixed GPU fleet, which is exactly our
  case, and reports up to 2.8x lower cost. I have read only the abstract; it is
  worth reading in full before phase 3 below.
- **Prefill/decode disaggregation** runs prompt processing on compute-heavy
  cards and token generation on bandwidth-heavy ones. Splitwise, DistServe and
  HexGen-2 do this, as do NVIDIA Dynamo, llm-d P/D and the
  [Spheron post](https://www.spheron.network/blog/heterogeneous-gpu-inference-cost-optimization/).
  It is the biggest saving in the literature, but it moves the KV cache between
  cards and needs RDMA-class networking. We have PCIe cards, no RDMA and gVisor
  sandboxes, so it is **out of scope** here.
  Helix and ThunderServe split a model's layers across GPU types, which does not
  match our one-replica-per-pod deployment.

## Design

### D1. The GPU class is chosen when a model is deployed, not when a pod is scheduled

A pod could, in principle, say "an H100, else an L40S, else an A6000" and let the
scheduler pick (Kubernetes DRA prioritized lists do exactly this). For LLM serving
this is the wrong layer, because the vLLM configuration depends on the card:

- container image (CUDA or kernel builds),
- quantization format,
- KV-cache dtype and attention backend,
- `gpu-memory-utilization`, context length and concurrency,
- tensor-parallel size.

So do the GPU-memory charge and the quota class (see D6). A replica configured
for one card is wrong on another. Scheduling-time fallback is only safe when the
configuration does not depend on the card, which for LLMs is rare.

So a deployment is a **variant**: (model, precision, GPU class, fraction or count,
engine settings). The selector chooses variants. The scheduler places pods of a
variant only on its class.

This matches how Phoenix Serving already composes a deployment. Its profiles are
`<model>-<hardware>` combinations layered from `modelProfiles` and
`hardwareProfiles` (`docs/adr/deployment-profile-layering.md`). Today the hardware
presets are generic (`nvidia-x1`, `nvidia-x4`, `mi300x-x1`). They become
per-class (`a6000-x1`, `rtxpro6000-x1`, `h100-x2`, ...).

### D2. A GPU class catalogue is the single source of truth

| Field | Example | Used by |
|---|---|---|
| `id` | `a6000` | everything below |
| `nvmlName` | `NVIDIA RTX A6000` | HAMi `use-gputype` (substring, case-insensitive: keep ids unambiguous) |
| `gfdProduct` | `NVIDIA-RTX-A6000` | node label match |
| `computeCapability` | `8.6` | feasibility rules |
| `memoryMiB` | `46068` (as HAMi registers it, not the datasheet) | fit, whole-card charge |
| `bandwidthGBs`, `fp16TFLOPS`, `fp8TFLOPS` | `768`, ... | estimates |
| `nvlink` | pairs / none | multi-GPU placement |
| `costWeight` | relative internal cost | ranking |
| `qualified` | gVisor `nvproxy` + driver tested | entry gate |

`qualified` matters for us in particular. Every tenant GPU pod runs under
gVisor's GPU proxy (`nvproxy`) on our own driver build. A new card generation
does not enter the catalogue until that stack is shown to work on it.

The catalogue lives once, in this repo (a ConfigMap rendered from
`manifests/midori/gpu-classes.yaml`), and is read by:

- the node labeller,
- the gVisor webhook,
- the tenant controller and its UI,
- Phoenix Serving's selector.

Nodes get a `midori.phoenix/gpu-class=<id>` label. GPU Feature Discovery's
`nvidia.com/gpu.product` label would do, but it is ambiguous on a node with mixed
cards, and its names differ from NVML's.

### D3. Selection: filter, then rank, then pack

**Inputs.** Each model preset gains a small requirements block. Phoenix Serving's
`presets/models/*.yaml` already holds most of it:

```yaml
requirements:
  checkpoints:            # precision -> weights size; which formats exist
    nvfp4: { weightsGiB: 6.1 }
    int4-awq: { weightsGiB: 6.4 }
    bf16: { weightsGiB: 16.4 }
  kvBytesPerToken: 147456 # from the model config
  context: { min: 32768, target: 131072 }
  concurrency: 26         # sequences the deployment promises
  shape: decode-heavy     # or prefill-heavy; refined later from traffic
  slo: { ttftMs: 2000, tpotMs: 50 }
```

**Filter (hard).** Keep a (precision, class, fraction) combination only if:

- the class is `qualified`;
- the precision has native support on the class's compute capability, or
  weight-only support with an explicit `allowWeightOnly` on the model;
- weights + KV(context.min x concurrency) + overhead fit in the fraction's
  memory. A combination that fits only `context.min` and not `context.target`
  is kept but marked degraded;
- multi-GPU (tensor parallel) uses one class only, on one node, and prefers
  NVLink-connected cards. Mixed classes in one tensor-parallel group run at the
  slowest card's pace and waste the larger card's memory.

**Rank (soft).** Order the survivors by estimated cost per million tokens at the
latency target:

- **With a profile** (D4): tokens per second at the target for the model's
  request-length mix, divided into the class's cost share.
- **Without one, a first-order estimate:**
  - decode tokens/s per sequence ≈ bandwidth x efficiency / bytes read per token
    (weights + KV at the average context);
  - prefill time ≈ 2 x parameters x prompt tokens / (TFLOPS x efficiency).

  The efficiency factors are calibrated from the first few profiles. AIBrix's
  authors suggest exactly this as a lighter substitute for full profiling.
- Prefer native precision over weight-only fallbacks.
- **Scarcity penalty:** add a penalty proportional to how many other deployed
  models can run *only* on this class, so a 4B model does not take the one card
  a large model needs.

**Pack (fleet).** The first two steps choose per model. The fleet step chooses for
all models together. It is a Mélange-style ILP:

- **minimise** total cost;
- **subject to** each model's demand served within target, card capacity per
  class (in HAMi fractions) and tenant quotas;
- **output** replicas per variant.

This is phase 3. Until then, the per-model ranking is used greedily, in priority
order.

### D4. Profiles are measured, under fractions

Phoenix Serving already has the harness (`scripts/benchmark/`, guidellm). It
needs to write machine-readable results instead of comments and docs. The profile
key is (model, precision, class, fraction, engine settings). The value is
throughput at the latency target per input/output-length bucket, which is
Mélange's format.

Fractions are different hardware as far as profiles go. HAMi's `gpucores` is a
time-slice weight under gVisor, so an A6000 at 25%, 50% and 100% are three
"classes" to the profiler. None of the published work profiles fractional GPUs.
That is new ground for us, and the main reason to measure rather than estimate.

Profiles are stored as a ConfigMap or CRD per model in Phoenix Serving's
namespace, versioned with the vLLM image. A new image invalidates them.

### D5. Pinning a variant to its class

- **Node level:** a `nodeSelector` on `midori.phoenix/gpu-class`. Phoenix
  Serving's chart already renders `nodeSelector` and `affinity`
  (`inferenceserviceconfig-vllm.yaml:52-66`).
- **Device level, needed only when one node holds two classes:**
  `nvidia.com/use-gputype: <nvmlName>`. The chart cannot set pod annotations
  today (`charts/phoenix-serving`, vLLM pod template). That needs a small chart
  change, or the gVisor webhook can derive the annotation from the class label
  it reads (D6).
- **Later:** a DRA ResourceClaim with a CEL selector on `productName` or
  `cudaComputeCapability` replaces both. DRA is GA since Kubernetes 1.34 and
  prioritized lists are stable in 1.36. NVIDIA's DRA driver publishes those
  attributes ([reference](https://dra-driver-nvidia-gpu.sigs.k8s.io/docs/reference/resourceslice-attributes/)).
  HAMi-DRA is NVIDIA-only and its chart is still in progress. Keep the
  selector's output abstract (class, memory, cores) so it can render either form.

### D6. Quota and accounting per class (resolves MIXED-GPUS.md)

Today the webhook assumes one card size: `--nvidia-whole-card-mib=46068` turns
whole cards, percentages and `gpucores: 100` into MiB of an A6000. On a mixed
cluster that is wrong in three ways:

- a whole-card pod on an 80 GB card is held to 46 GB, and the rest of the card
  is left to others;
- it cannot land on a smaller card at all;
- a percentage becomes MiB of an A6000, not of the card the pod gets.

With D1 the class is known before admission, so:

- **Require a class on every GPU pod** on a mixed cluster. The webhook reads it
  from the pod's `midori.phoenix/gpu-class` node selector, or from a default
  class the admin sets per tenant, and sets `use-gputype` to match.
- **Use that class's card size** for whole-card, percentage and exclusive pods,
  instead of the single flag value. The catalogue replaces
  `--nvidia-whole-card-mib`.
- **Charge per-class quota-only resources:** `midori.phoenix/gpu-memory-<class>`
  (MiB x GPUs) and `midori.phoenix/gpus-<class>`. This uses the trick already
  in use for `midori.phoenix/gpu-memory`: the resources exist only for the quota,
  HAMi's scheduler ignores them, and the kubelet drops them.
- **Make Tenant quotas per class:** `quota.gpu: { a6000: {memoryMiB, attachments},
  rtxpro6000: {...} }`. The UI shows commitment per class.

This is MIXED-GPUS.md's option B, done by our webhook rather than by HAMi
resource names. HAMi has per-model resource names only for Ascend, not NVIDIA.

### D7. Routing across variants

A model served by several variants needs traffic spread across them. Two ways:

1. **One InferencePool across the variants.** The llm-d endpoint picker already
   balances on queue depth and prefix-cache hits, so a faster variant naturally
   takes more load. This needs checking: KServe creates one pool per
   `LLMInferenceService`, so the variants may have to share one service, or the
   pool may have to be defined outside KServe.
2. **Weighted alias targets in AgentGateway.** The alias ADR
   (`docs/adr/model-aliases.md`) allows one target today and names multiple
   targets as later work. Weights would come from the planner.

The Mélange result (small requests to cheap cards, large to big ones) suggests a
later endpoint-picker scorer keyed on prompt length and the pod's class label.
It is worth doing only once profiles show a real difference.

## Where each piece lives

| Piece | Home |
|---|---|
| Class catalogue, node labels | vcluster-multitenant `manifests/midori/` |
| Per-class whole-card size, class pinning, per-class quota resources | gVisor webhook (`webhook/pkg/gpushare`) |
| Per-class Tenant quota, UI commitment by class | vcluster-multitenant `controller/` |
| Model requirements, per-class hardware presets, feasibility check, ranking, profiles | phoenix-serving (chart and `scripts/`) |
| Fleet planner, replicas per variant | phoenix-serving, later (feeds KEDA) |
| Device filtering, packing | HAMi, unchanged |

## HAMi: what to ask upstream

None of this blocks the design.

1. **Exact type matching.** `use-gputype` matches by case-insensitive substring,
   so `A100` also matches `A100-SXM4-80GB`, and a short token can over-match.
   Propose an exact-match form (or match on a normalised id).
2. **Per-model resource names for NVIDIA**, as `devices.ascend.configs` does for
   Ascend. With them, per-class quota would not need our webhook. D6 works
   without it.
3. **A scarcity-aware device score.** When a pod allows several types, prefer the
   one with the least spare memory that fits, to avoid stranding large cards.
   This only matters if we ever allow multi-type pods, which D1 avoids.
4. **Watch HAMi-DRA.** It would replace annotations with CEL selectors and
   consumable capacity. Today it cannot run alongside device-plugin mode and
   has no topology scheduling.

## Phases

| Phase | Trigger | Delivers |
|---|---|---|
| 0 | now (one class) | Class catalogue with `a6000`; node labels; model presets gain `requirements`; benchmark harness writes profiles. No behaviour change. |
| 1 | a second class is ordered | Per-class hardware presets; feasibility check at render time (refuse an NVFP4 profile on A6000 unless weight-only is allowed); webhook per-class card size and quota resources; Tenant quota per class. Operators still choose the class, with the check guarding them. |
| 2 | two classes running | `hardwareRef: auto`: filter + rank (estimates, then profiles) picks the variant at deploy time; profiles of fractions. |
| 3 | several models x classes | Fleet planner (Mélange/Coral style) choosing replicas per variant; traffic across variants (D7); KEDA scaling from planner output. |
| 4 | HAMi-DRA mature | ResourceClaims instead of labels and annotations. |

## To decide

1. Do we accept D1, a fixed class per variant, and give up scheduling-time
   fallback between classes?
2. Who owns the class catalogue: the cluster (this repo) or Phoenix Serving?
   This design says the cluster, because quota and the webhook need it first.
3. Cost weights: real card prices, power, or an internal scarcity score?
4. Per-class tenant quotas from the first mixed day, or one pooled quota with
   class steering (option C) until a tenant needs a guarantee?
5. SLO targets per model: needed for ranking and for the planner, and not
   defined anywhere today.
6. Is prefill/decode disaggregation ever on the table? It would need RDMA and a
   KV-transfer path that works with gVisor.
