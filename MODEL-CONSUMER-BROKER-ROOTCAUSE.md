# Model-consumer / broker: why cross-tenant inference returns nothing

**Status:** diagnosed 2026-11-27. The break is on the **provider (serving) side** —
`broker → agentgateway` — not the consumer path and not the platform network
policy. Consumer-side wiring (`spec.modelProviders`, the model-consumer CNPs,
the floor, platform-guard, the replicated Service) is correct and functional.

## Symptom

A consumer tenant that lists a provider in `Tenant.spec.modelProviders` gets a
broker it cannot get a response from. From a consumer vCluster workload pod:

```
curl http://PROVIDER.model-providers:8080/v1/models      # hangs, 0 bytes, times out
```

This reproduces for **every** consumer, including `tenant-agents` (a 44-day-old
consumer whose deployed `agent-demo` ConfigMap uses exactly this path). So the
feature has not been returning inference for anyone.

## What is actually happening (traced)

The path is: `consumer pod → broker (model-providers/PROVIDER) → model-gateway.PROVIDER:8080 → agentgateway pod`.

1. **consumer → broker: works.** A verbose probe from a consumer vCluster pod
   **TCP-connects** to the broker (both via the replicated ClusterIP
   `10.43.39.17:8080` and the broker pod IP `10.42.6.111:8080`), sends the GET,
   then receives **0 bytes** and hangs until the client timeout.
   - Control: the *same* pod reaches **s3-gateway** (identical platform-guard
     exemption, a ClusterIP in a neutral namespace) and gets `HTTP 400`
     immediately. So vCluster pods can reach platform ClusterIPs, and every
     policy layer admits the broker too. Earlier bare `000` readings were
     *connect-but-hang*, not connect-failure.

2. **broker is healthy.** `model-providers/PROVIDER` is haproxy:2.8.5-alpine,
   `mode tcp`, listening on `0.0.0.0:8080`, pod `1/1 Running`. Ingress is
   correctly locked to `fromEntities:[host]` + the per-consumer CNPs.

3. **broker → gateway is where data stops.** haproxy's backend is
   `model-gateway.PROVIDER.svc.cluster.local:8080`. Its log shows the backend
   **resolved and `UP/READY`** — but that status is **DNS-resolution-based; there
   is no health check**. The client hangs the *full* timeout rather than being
   dropped at haproxy's 5 s `timeout connect`, which means **haproxy did connect
   to the gateway but the gateway returned nothing** to the relayed plain-HTTP
   request.

4. **The gateway doesn't serve plain HTTP on :8080.** `model-gateway`
   (`10.43.5.165`) points at the provider's **agentgateway v1.7.0** pod
   (`10.42.5.16`, `1/1 Running` 10 d). agentgateway's data listeners are
   configured dynamically (only `:15020` metrics is a static containerPort). The
   broker relays **plain TCP/HTTP** to `:8080`; the agentgateway listener there
   evidently expects something else (TLS / HTTP-2). This matches a prior note
   that the broker was meant to **TLS-tunnel `:8080 → gateway:443`** — i.e. the
   broker template and the gateway listener disagree on port/protocol.

## Root cause

The broker (`manifests/midori/model-provider.yaml`, `backend gateway → server
model-gateway.PROVIDER:8080`) forwards **plain TCP** to an agentgateway listener
that does not answer plain HTTP on that port. haproxy has no health check, so it
advertises the backend as UP and silently hangs every client.

This is a **serving-side** defect (the provider's agentgateway listener config
and/or the broker's upstream port+protocol in `model-provider.yaml`). It is not
the consumer wiring, the tenant floor, the platform-guard, or the replicated
Service.

## Proposed fix (serving side — pick one, with the serving team)

- **A. Match the broker to the gateway's real listener.** If the agentgateway
  inference listener is TLS on `:443` (or h2c on another port), change the broker
  backend to that target. For TLS, either terminate at haproxy
  (`server ... ssl verify none` + `mode http`, or an `mode tcp` tunnel to `:443`)
  or expose a plain-HTTP listener on the gateway for the broker to hit.
- **B. Give the gateway a plain-HTTP listener on `:8080`** that `model-gateway`
  targets, so the existing `mode tcp` relay works unchanged.
- **C. Add a real health check to the broker** (`option httpchk` / `check`) so a
  mis-wired backend fails fast and visibly instead of hanging — do this
  regardless of A/B, so this class of bug surfaces immediately.

## Validation (before/after)

From a fresh non-sandbox pod inside any consumer vCluster:

```
curl -sS -m 8 -H "Authorization: Bearer $MODEL_KEY" \
  http://PROVIDER.model-providers:8080/v1/models
```

Should go from **hang/0-bytes → `200`/`401`**. Then confirm name resolution of
`PROVIDER.model-providers` inside the consumer vCluster (one earlier probe saw
`NXDOMAIN` for the replicated headless Service — recheck once the gateway leg is
fixed; it may have been a test artifact, otherwise it is a second, smaller fix on
the replicated-Service DNS).

## Consumer side: confirmed correct, no change needed

- `Tenant.spec.modelProviders` provisioning (controller renders model-consumer
  CNPs + `networking.replicateServices.fromHost`) reconciles cleanly; the broker
  Service replicates into the consumer vCluster.
- The consumer egress CNP and broker ingress CNP are byte-identical to the
  working-reference consumer `tenant-agents`.
- The tenant floor does **not** deny the broker (`model-providers` has no
  `tenant` label; the broker IPs are in the floor's CIDR-except ranges), and
  `platform-guard` **exempts** `app=model-broker`.

Once the serving-side gateway leg is fixed, consumer inference works with no
further consumer-side changes.
