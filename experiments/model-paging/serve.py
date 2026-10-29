"""Paging-aware OpenAI proxy over per-model vLLM servers.

The real serving architecture. Each model runs as its own vLLM OpenAI server
started with sleep mode enabled:

    VLLM_SERVER_DEV_MODE=1 vllm serve <path> --port <p> --enable-sleep-mode \
        --gpu-memory-utilization <u>     # u sized so the resident set fits

A sleeping server (level 1) holds its weights in CPU RAM and frees VRAM. This
proxy speaks the OpenAI API, and on each request it makes the target model
resident — waking its server (POST /wake_up) and sleeping idle victims
(POST /sleep) per the ResidencyManager — then forwards the request, streaming
included. So continuous batching and streaming are the upstream vLLM servers',
and a standard load generator (`vllm bench serve`) can drive it unchanged:

    vllm bench serve --backend openai-chat --base-url http://PROXY:8000 \
        --model <name> --request-rate <r> --num-prompts <n> --dataset-name random

Run one `vllm bench serve` per model (see benchctl.py) to get a multi-model,
Zipfian, bursty trace that actually exercises paging.

The wake/sleep calls and the request forwarding are injectable, so the control
flow is unit-tested with fakes (test_serve.py) — no GPU, no vllm, no httpx.
Endpoints are per vLLM's dev-mode docs; confirm the exact shapes for your
version (docs.vllm.ai/en/latest/features/sleep_mode/).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time

from pager import ModelPager
from residency import CapacityError, Model, ResidencyManager, Tier
from simulate import DEFAULT_TIERS, make_policy


# --------------------------------------------------------------------------
# Backend: wake/sleep the per-model vLLM servers over HTTP.
# --------------------------------------------------------------------------
async def _default_post(url: str) -> None:
    import httpx
    async with httpx.AsyncClient(timeout=60.0) as c:
        r = await c.post(url)
        r.raise_for_status()


class ServerBackend:
    """load = wake a model's vLLM server; evict = sleep it. No infer() — the
    proxy forwards requests to the upstream server directly."""

    def __init__(self, servers, http_post=None, sleep_level=1):
        self.servers = dict(servers)            # name -> base_url
        self.sleep_level = sleep_level
        self._post = http_post or _default_post
        self.loads = 0
        self.evicts = 0

    async def load(self, name: str) -> float:
        t0 = time.perf_counter()
        await self._post(f"{self.servers[name]}/wake_up")
        self.loads += 1
        return time.perf_counter() - t0

    async def evict(self, name: str) -> None:
        await self._post(f"{self.servers[name]}/sleep?level={self.sleep_level}")
        self.evicts += 1

    async def infer(self, *a, **k):
        raise NotImplementedError("the proxy forwards requests; no infer here")


# --------------------------------------------------------------------------
# Proxy service: route by model, acquire residency, forward, release.
# --------------------------------------------------------------------------
async def _default_forward(base_url, path, body, stream):
    import httpx
    async with httpx.AsyncClient(timeout=None) as c:
        r = await c.post(base_url + path, json=body)
        return r.status_code, r.json()


class ProxyService:
    def __init__(self, pager: ModelPager, servers, forward=None):
        self.pager = pager
        self.servers = dict(servers)
        self._forward = forward or _default_forward
        self.records = []        # (model, hit, setup_s, ok)

    async def handle(self, path, body, stream=False):
        """Non-streaming request path (also what the tests drive). Returns
        (status, json). The streaming path lives in build_app so it can hold the
        pin across the SSE stream."""
        model = body.get("model")
        if model not in self.servers:
            return 404, {"error": {"message": f"unknown model {model!r}"}}
        t0 = time.perf_counter()
        try:
            _fault, hit = await self.pager.acquire(model)
        except CapacityError:
            return 503, {"error": {"message": f"cannot admit {model}"}}
        setup = time.perf_counter() - t0
        try:
            status, resp = await self._forward(self.servers[model], path, body, stream)
        finally:
            await self.pager.release(model)
        self.records.append((model, hit, setup, status < 400))
        return status, resp


def build_app(service: ProxyService):
    """FastAPI app (imported lazily; GPU-node deps). Streaming holds the pin
    until the SSE generator is exhausted."""
    import httpx
    from fastapi import FastAPI, Request
    from fastapi.responses import JSONResponse, StreamingResponse

    app = FastAPI()
    client = httpx.AsyncClient(timeout=None)

    async def _proxy(path, request):
        body = await request.json()
        model = body.get("model")
        if model not in service.servers:
            return JSONResponse(status_code=404,
                                content={"error": {"message": f"unknown model {model!r}"}})
        try:
            await service.pager.acquire(model)
        except CapacityError:
            return JSONResponse(status_code=503,
                                content={"error": {"message": f"cannot admit {model}"}})
        base = service.servers[model]
        if body.get("stream"):
            async def gen():
                try:
                    async with client.stream("POST", base + path, json=body) as r:
                        async for chunk in r.aiter_raw():
                            yield chunk
                finally:
                    await service.pager.release(model)
            return StreamingResponse(gen(), media_type="text/event-stream")
        try:
            r = await client.post(base + path, json=body)
            return JSONResponse(status_code=r.status_code, content=r.json())
        finally:
            await service.pager.release(model)

    @app.post("/v1/completions")
    async def completions(request: Request):
        return await _proxy("/v1/completions", request)

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        return await _proxy("/v1/chat/completions", request)

    @app.get("/v1/models")
    async def models():
        return {"object": "list",
                "data": [{"id": n, "object": "model"} for n in service.servers]}

    return app


# --------------------------------------------------------------------------
# Wiring.  config.json: [{"name","url","size_mib","tenant"?,"master_tier"?}, ...]
# --------------------------------------------------------------------------
def load_config(path):
    with open(path) as f:
        entries = json.load(f)
    models, servers = [], {}
    for e in entries:
        models.append(Model(e["name"], e.get("tenant", e["name"]),
                            int(e["size_mib"]), e.get("master_tier", "pinned_ram")))
        servers[e["name"]] = e["url"].rstrip("/")
    return models, servers


def build_service(models, servers, budget_mib, policy="lru",
                  tiers=None, http_post=None, forward=None):
    tiers = tiers or DEFAULT_TIERS
    mgr = ResidencyManager(budget_mib, tiers, policy=make_policy(policy))
    backend = ServerBackend(servers, http_post=http_post)
    pager = ModelPager(mgr, backend, models)
    return ProxyService(pager, servers, forward=forward), pager, backend


def main():
    p = argparse.ArgumentParser(description="Paging-aware OpenAI proxy over vLLM servers")
    p.add_argument("--config", required=True, help="models config JSON")
    p.add_argument("--budget", type=int, required=True, help="VRAM budget MiB")
    p.add_argument("--policy", choices=["lru", "cost", "freq"], default="lru")
    p.add_argument("--host", default="0.0.0.0")
    p.add_argument("--port", type=int, default=8000)
    args = p.parse_args()

    import uvicorn
    models, servers = load_config(args.config)
    service, _, _ = build_service(models, servers, args.budget, args.policy)
    uvicorn.run(build_app(service), host=args.host, port=args.port)


if __name__ == "__main__":
    main()
