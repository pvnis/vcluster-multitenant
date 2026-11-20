# Residency protocol (proxy-less path)

The wire protocol between a per-vLLM **residency agent** (`agent.py`) and the
**broker** (the Go `residency.Manager` + RPC server in the gpu-scheduler;
`broker.py` is the Python reference). It replaces the shared OpenAI proxy
(`serve.py`) for multi-tenant clusters: there is no data-path component, only
control signals, so tenant request/response bytes never leave the tenant.

One agent per vLLM instance (one model). The agent **dials** the broker — the
same direction and trust model as a gVisor sandbox dialing the gpu-scheduler for
GPU time — so no inbound admin surface is exposed on the tenant's vLLM.

## Transport

Newline-delimited JSON objects, bidirectional, over a unix socket (or TCP).
Every message has a `t` (type) and a `model` field.

## Messages

Agent → broker:

| `t` | fields | meaning |
| --- | --- | --- |
| `register` | `model, tenant, size_mib, tier, resident` | on connect; declares the model and whether vLLM currently holds VRAM |
| `acquire` | `model` | a request arrived and the model is not resident+pinned; make it resident |
| `release` | `model` | the model went idle (no in-flight work); it may be evicted |
| `slept` | `model` | ack: vLLM has slept (VRAM freed) as directed |

Broker → agent:

| `t` | fields | meaning |
| --- | --- | --- |
| `grant` | `model` | your `acquire` succeeded; VRAM is free — wake vLLM and serve |
| `reject` | `model, reason` | the model can never fit the budget; fail the request |
| `sleep` | `model` | you were chosen as a victim; sleep vLLM once idle, then `slept` |

## Agent state machine (per model)

- **idle/asleep** → a request arrives → send `acquire`, block the request until
  `grant`, then `wake_up` vLLM, serve. Concurrent requests to an already-resident
  model just serve (one `acquire` per cold→warm transition — wake coalescing).
- **serving** (in-flight > 0) → the model is *pinned*; the broker won't evict it.
- in-flight → 0 → send `release`.
- receive `sleep`: if idle, `sleep(level=1)` vLLM and `slept`; if a request is
  in-flight, defer — new requests wait — and complete the sleep when it drains.
  The broker committed the eviction when it sent `sleep`, so the agent always
  converges (worst case a victim that raced a request does one extra wake later).

## Broker orchestration (per `acquire(X)`)

Admissions are serialized (one at a time — sleep/wake share PCIe). The broker:
1. `Admit(X)` on the `residency.Manager` → commits the decision: evicts the
   planned victims in accounting, reserves + pins X. If X can't fit because every
   candidate is pinned (busy), park X and retry on the next `release`; if X can
   never fit the budget, `reject`.
2. Push `sleep` to each victim's agent; wait for their `slept` acks (VRAM
   physically freed).
3. `grant` X.

On `release(X)`: `Unpin(X)` and retry any parked acquires (capacity may have
freed). On agent disconnect: evict the model from accounting (its VRAM is gone).

## Production vs reference

- **Production broker:** the Go `residency.Manager` (gvisor
  `pkg/gpusched/residency/`) wrapped by an RPC server that speaks this protocol,
  colocated in `runsc gpu-scheduler` (see that package's `INTEGRATION.md`). It
  exchanges only the control signals above — never request content.
- **Reference broker:** `broker.py` here, the same logic over the Python
  `ResidencyManager` (the 1:1 source of the Go port), used to test the agent
  end-to-end (`test_agent.py`) with no GPU.
- **Agent in production:** a vLLM plugin or a localhost sidecar in the tenant's
  pod, driving `VLLMBackend` (sleep/wake). In tests it drives `MockBackend`.
