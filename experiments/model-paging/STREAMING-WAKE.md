# Streaming wake (weight DMA ∥ prefill) + the overcommit benchmark

The engine change that overlaps the weight fault-in with the first forward pass,
how it rides the existing KServe serving path, and the runbook to measure how far
we can overcommit at a target SLO. The simulator already predicts the curve
(`simulate.py --wake overlap`); the GPU runs calibrate it.

> **Not buildable/runnable in the authoring env** (no GPU; vLLM needs CUDA, and
> GPU execution is out of scope for this session). The vLLM patch below is a
> concrete sketch against current internals — build and verify it on a GPU box;
> the exact class/method paths move between vLLM versions, so confirm against the
> installed one.

## 1. What overlap means here

On a cold wake you recompute KV from the prompt, so the first forward pass **is
the prefill** — a single layered pass. Stock `wake_up()` is blocking: it copies
*all* weights back, then prefills, so the cold cost is `fault + prefill`. The
change streams the weight copy in layer order on a copy stream and gates each
layer's compute on its own copy-completion event, so copy(i+1) overlaps
compute(i): cold cost → `max(fault, prefill)`. Decode (graph-captured, needs all
weights) runs normally afterwards — by then every layer is resident. So the
overlap window is exactly the **first, eager prefill** after a wake.

## 2. The vLLM change

Two pieces, and a generic way to avoid editing every model.

**(a) Streaming restore in the allocator.** vLLM sleep mode offloads/restores
weight memory through `CuMemAllocator` (`vllm/device_allocator/cumem.py`). Add a
restore that issues the host→device copies on a dedicated copy stream in
registration order (≈ layer order) and records a CUDA event per layer group,
returning `{layer_index: event}` without synchronizing:

```python
# sketch — CuMemAllocator
def wake_up_streaming(self, copy_stream, layer_of):      # layer_of: ptr/handle -> layer idx
    events = {}
    with torch.cuda.stream(copy_stream):
        for handle in self.tracked_in_registration_order():
            self._remap_and_copy_h2d(handle)             # async H2D on copy_stream
            li = layer_of(handle)
            ev = torch.cuda.Event(); ev.record(copy_stream)
            events[li] = ev                              # last copy of that layer wins
    return events
```

**(b) Gate each layer's compute on its event (generic, no per-model edits).**
Walk the model's decoder layers and install a one-shot `forward_pre_hook` that
makes the compute stream wait on that layer's event, then removes itself:

```python
# sketch — installed on the first post-wake prefill
def install_streaming_gates(model, events):
    handles = []
    for i, layer in enumerate(model.model.layers):       # llama/qwen/... layout
        ev = events.get(i)
        if ev is None:
            continue
        def pre_hook(mod, args, _ev=ev, _h=[]):
            torch.cuda.current_stream().wait_event(_ev)
            _h[0].remove()                               # fire once
            return None
        h = layer.register_forward_pre_hook(pre_hook)
        pre_hook.__defaults__[-1].append(h)              # or capture h properly
    return handles
```

The worker's wake path (`vllm/v1/worker/gpu_worker.py` /
`gpu_model_runner.py`) calls `wake_up_streaming` instead of the blocking
`wake_up`, installs the gates, and lets the first scheduled prefill run — it
naturally stalls per layer only until that layer's weights land.

**Caveats / risks (verify on GPU):**
- **CUDA graphs:** decode is graph-captured with fixed weight pointers — do *not*
  stream into a captured graph. Streaming applies to the **eager prefill** only;
  by first decode step, weights are resident. Confirm the first prefill after a
  wake runs eager (piecewise/eager prefill), not under a replayed graph.
- **Allocation→layer mapping:** `CuMemAllocator` tracks a flat allocation list;
  you need `layer_of`. Copying in construction order and bucketing by the module
  that created each allocation is the usual way; validate the order matches
  execution.
- **Copy vs compute overlap** uses the DMA copy engine vs SMs — real overlap, but
  measure: small/first layers may be copy-bound and stall compute briefly.
- **Tensor-parallel:** each rank streams its shard, its own events; the gate is
  per-rank.
- Fallback: if a layer's event is missing (mapping gap), the gate degenerates to
  a full sync — correct, just not overlapped.

Expose it as `sleep_mode="streaming"` or a `wake_up(streaming=True)` flag so the
residency agent / KServe path can opt in per model.

## 3. Riding the existing KServe serving path

No new shared proxy. Each model is a KServe predictor (an `InferenceService` /
the cluster's `LLMInferenceService`) running vLLM with sleep mode. Residency is a
**per-predictor agent** (this repo's `agent.py`) as a sidecar in the predictor
pod (or a vLLM plugin), on localhost — within the tenant, never cross-tenant:

- the **KServe router stays unchanged**; it routes to the predictor service as
  today;
- inside the predictor pod the agent fronts localhost vLLM: on a request it
  `acquire`s from the broker, triggers the streaming `wake_up`, forwards to vLLM,
  and `release`s on idle; on a broker `sleep` it sleeps once idle;
- the broker is the Go `residency.Manager` in the gpu-scheduler (one per GPU
  node), exchanging only control signals.

For a first measurement you can skip the sidecar and drive sleep/wake centrally
(a script calling each predictor's `/sleep` `/wake_up` per the residency policy),
but the sidecar is the production shape.

## 4. Benchmark runbook (GPU node)

Goal: the measured overcommit-vs-goodput curve for **blocking vs streaming**
wake, to compare against `simulate.py`'s prediction.

1. **Deploy N models** as KServe predictors with sleep mode
   (`VLLM_SERVER_DEV_MODE=1 --enable-sleep-mode`), `--gpu-memory-utilization`
   sized so a chosen resident set `K` fits; start the cold ones asleep.
2. **Build two vLLM images**: stock (blocking wake) and patched (streaming wake);
   run the sweep against each.
3. **Broker + agents**: run the residency broker (Go server, or `broker.py` for a
   quick pass) and an agent per predictor.
4. **Drive load** across all models at the KServe router with `benchctl.py`
   (`--base-url <kserve-router>`, `--backend openai-chat`), Zipfian rates, bursty
   (`--burstiness`), `--num-prompts` per model. vLLM streams tokens, so
   `vllm bench serve` reports real **TTFT**.
5. **Sweep overcommit** = vary `K` (how many models may be awake) via the broker
   budget; at each point compute **goodput** = fraction of requests with
   `TTFT ≤ SLO` (post-process the per-request results in `bench-*.json`), and
   p50/p99 TTFT.
6. **Compare** the measured `goodput(overcommit)` and the max overcommit at the
   target goodput, blocking vs streaming, against the simulator table. Use the
   measured wake latency (`backend.py measure_wake`) and prefill time to
   recalibrate `simulate.py`'s tiers / `prefill_s_per_tok` so the model matches,
   then trust it for operating-point choices.

### Predicted baseline (from the simulator, to validate against)

`python3 simulate.py --no-sweep` (2 s TTFT SLO, 95% goodput, bursty multi-model):

```
overcommit   gp_blocking   gp_overlap   p99_blk_ms   p99_ovl_ms
   1.0x           1.0          1.0          953          943
   2.0x          0.982        0.997        2202         1679
   3.0x          0.95         0.991        2916         1958
   6.0x          0.89         0.967        3889         2572
   8.0x          0.848        0.955        4289         2857
max overcommit @ goodput >= 95%:  blocking 3.0x,  overlap 8.0x
```

So in this scenario the engine change lifts the sustainable overcommit from ~3×
to ~8× at the same SLO — the number to confirm (and recalibrate) on the GPU.
