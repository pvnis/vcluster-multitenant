# Model-consumer / broker: why cross-tenant inference returns nothing

**Status: RESOLVED 2026-11-27.** The break was on the **provider (serving) side** —
`broker → agentgateway` — not the consumer path or the platform network policy.
Root cause: the gateway's only listener is **HTTPS on :443**, but `model-gateway`
and the broker targeted a **dead :8080**. Fix applied and verified end-to-end (a
phoenix-claw vCluster pod now gets `200` + the model list through the broker, by
name, in ~35 ms). See **Resolution** at the bottom.

Consumer-side wiring (`spec.modelProviders`, the model-consumer CNPs, the floor,
platform-guard, the replicated Service) was correct and functional throughout.

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

4. **The gateway answers *nothing* on `:8080`.** `model-gateway` (`10.43.5.165`,
   targetPort 8080) points at the provider's **agentgateway v1.7.0** pod
   (`10.42.5.16`, `1/1 Running` 10 d). Through the broker's plain-TCP relay:
   - a plain HTTP `GET` → **0 bytes**, hangs;
   - a TLS `ClientHello` with **every SNI tried** (the gateway FQDN, `model-gateway`,
     and a deliberately bogus name) → **no `ServerHello`**, hangs.
   A no-response-for-any-protocol-or-SNI listener is **not** simple TLS/SNI gating
   (a non-matching SNI would normally get a TLS alert or a default cert). The
   agentgateway pod **declares no `:8080` port** (only `:15020` metrics and a
   `:15021` health check), its listeners are delivered by **xDS** (dynamic; the
   static `config.yaml` has only bootstrap + apiKey auth attributes), and it does
   **apiKey auth**. The most likely cause is that its real inference listener is
   **not on `:8080`** (the Gateway listener port/protocol moved), so the
   platform's `model-gateway:8080` Service — and the broker behind it — now target
   a port nothing serves, and haproxy retries/holds.

**What changed:** the broker and consumer wiring are unchanged (`model-provider.yaml`
untouched since 2026-10-14; live haproxy still `server gateway model-gateway.PROVIDER:8080`
plain). The provider's serving stack moved to an xDS-driven agentgateway (Envoy),
and the listener the broker targets no longer answers. **Not** the consumer-side
Envoy egress proxy — plain `curl` pods reproduce it with no sidecar in the path.

**Answered (read the provider's `Gateway` in its vCluster):** the
`phoenix-serving-gateway` (agentgateway) has **one listener — HTTPS on :443, TLS
terminate, no hostname restriction**, and does apiKey auth. The LB Service exposes
`443→443` and a stale `8080→8080` that nothing serves. So `model-gateway`'s
`targetPort: 8080` and the broker's `:8080` backend pointed at the dead port.

## Root cause

The broker (`manifests/midori/model-provider.yaml`, `backend gateway → server
model-gateway.PROVIDER:8080`) forwards **plain TCP** to an agentgateway listener
that does not answer plain HTTP on that port. haproxy has no health check, so it
advertises the backend as UP and silently hangs every client.

This is a **serving-side** defect (the provider's agentgateway listener config
and/or the broker's upstream port+protocol in `model-provider.yaml`). It is not
the consumer wiring, the tenant floor, the platform-guard, or the replicated
Service.

## Resolution (applied + verified)

Three coupled changes in `manifests/midori/model-provider.yaml`, targeting the
gateway's real **HTTPS :443** listener. The broker's **front door stays :8080**
(the agent code and the replicated Service call `http://<provider>.model-providers:8080`);
only the **gateway-facing** side moved to 443:

1. **`model-gateway` Service** `8080→8080` ⟶ **`443→443`**.
2. **`allow-model-broker` CNP** ingress port `8080` ⟶ **`443`** (the broker→gateway hop).
3. **broker haproxy** `mode tcp` ⟶ **`mode http`**, backend
   `server gateway model-gateway.PROVIDER:443 **ssl verify none check**` — it
   terminates the consumer's plain HTTP and **re-originates TLS** to the gateway,
   and `check` (over SSL) now fails fast instead of hanging if the backend is wrong.

**Verified end-to-end** from a phoenix-claw vCluster pod (by name, through the
broker): no-auth → `401 authentication failed` in 28 ms (reaches the gateway's
apiKey auth); with the provider key → **`200` + the model list**
(`auto, cheap-vmodel, Qwen3.5-4B, Qwen3.8-27B, reasoning-vmodel`) in ~35 ms. The
earlier `NXDOMAIN` for the replicated name did not reproduce — it was a test
artifact. `tenant-agents` rides the same broker, so it is fixed by the same change.

**How it was applied / durability:** the change is committed here *and* applied
live by patching the controller's `tenant-templates` ConfigMap (the controller
reads templates fresh per reconcile and server-side-applies them), then
restarting the broker once to load the new haproxy config. **The live template
patch is out-of-band from git — merge this PR so a controller redeploy keeps the
fix.** Follow-up worth doing: add a config checksum annotation to the broker
Deployment so future haproxy.cfg changes roll the pod automatically (today a
manual restart is needed).

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
