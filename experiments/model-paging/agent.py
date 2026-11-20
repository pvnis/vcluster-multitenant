"""Per-vLLM residency agent — the proxy-less serving path.

One agent runs per vLLM instance (as a vLLM plugin, or a localhost sidecar in the
tenant's own pod — never a shared cross-tenant proxy). It dials the broker's
residency socket the same way a gVisor sandbox dials the gpu-scheduler for GPU
time, and participates in residency for its one model:

  - on a request while the model is not resident, it `acquire`s from the broker
    (which may evict idle models elsewhere), waits for the grant, wakes vLLM, and
    serves; concurrent requests to an already-resident model just serve;
  - while it has in-flight work the model is pinned (the broker won't evict it);
  - when it goes idle it `release`s, so the broker may later evict it;
  - when the broker pushes a `sleep` directive (the model was chosen as a victim)
    the agent sleeps vLLM once idle; new requests arriving meanwhile wait until
    the sleep completes and then re-acquire. The broker is the source of truth
    (it committed the eviction when it sent `sleep`); the agent always converges.

Only control signals cross the socket (model id, size, acquire/grant/sleep) —
never request content, so tenant data never leaves the tenant and the broker
stays the same trust level as the existing time-slice scheduler.

Wire protocol (newline-delimited JSON, bidirectional); see PROTOCOL.md.
  agent->broker: register, acquire, release, slept
  broker->agent: grant, reject, sleep

The agent drives a Backend (backend.py): MockBackend for tests, VLLMBackend
(sleep/wake) in production. It is transport-agnostic — given an asyncio
reader/writer pair (unix socket in production, an in-memory pipe in tests).
"""

from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass


@dataclass
class AgentModel:
    name: str
    tenant: str
    size_mib: int
    master_tier: str = "pinned_ram"


class RejectedError(RuntimeError):
    """The broker rejected admission (the model can never fit the budget)."""


class ResidencyAgent:
    def __init__(self, model: AgentModel, backend, reader, writer,
                 resident: bool = False):
        self.m = model
        self.be = backend
        self.reader = reader
        self.writer = writer
        self.resident = resident          # does vLLM currently hold VRAM?
        self.inflight = 0
        self.waking = False               # an acquire+wake is in progress
        self.sleep_pending = False        # broker asked to sleep; waiting to drain
        self._grant = None                # "grant" | reject-reason | None(pending)
        self.cv = asyncio.Condition()
        self._recv_task = None

    async def _send(self, **msg):
        self.writer.write((json.dumps(msg) + "\n").encode())
        await self.writer.drain()

    async def start(self):
        await self._send(t="register", model=self.m.name, tenant=self.m.tenant,
                         size_mib=self.m.size_mib, tier=self.m.master_tier,
                         resident=self.resident)
        self._recv_task = asyncio.create_task(self._recv_loop())

    async def close(self):
        if self._recv_task:
            self._recv_task.cancel()
        try:
            self.writer.close()
            await self.writer.wait_closed()
        except Exception:
            pass

    # ---- request path (serves ONLY this agent's model / tenant) ----
    async def handle_request(self, prompt: str, max_tokens: int = 16):
        await self._enter()
        try:
            return await self.be.infer(self.m.name, prompt, max_tokens)
        finally:
            await self._leave()

    async def _enter(self):
        first = False
        async with self.cv:
            while self.sleep_pending:          # don't start on a model being evicted
                await self.cv.wait()
            self.inflight += 1
            if self.resident and not self.waking:
                return                         # fast path: already up
            if not self.waking:
                first = True                   # we drive the acquire + wake
                self.waking = True
                self._grant = None
                await self._send(t="acquire", model=self.m.name)
            else:
                while self.waking:             # someone else is waking it
                    await self.cv.wait()
                if not self.resident:
                    self.inflight -= 1
                    raise RejectedError("rejected")
                return
            while self._grant is None:         # first caller waits for the grant
                await self.cv.wait()
            if self._grant != "grant":
                reason = self._grant
                self.inflight -= 1
                self.waking = False
                self.cv.notify_all()
                raise RejectedError(reason)
        if first:
            await self.be.load(self.m.name)    # vLLM wake_up (slow DMA, outside cv)
            async with self.cv:
                self.resident = True
                self.waking = False
                self.cv.notify_all()

    async def _leave(self):
        async with self.cv:
            self.inflight -= 1
            if self.inflight == 0:
                if self.sleep_pending:         # honor the deferred sleep now
                    await self.be.evict(self.m.name)
                    self.resident = False
                    self.sleep_pending = False
                    await self._send(t="slept", model=self.m.name)
                else:
                    await self._send(t="release", model=self.m.name)
                self.cv.notify_all()

    # ---- broker -> agent ----
    async def _recv_loop(self):
        while True:
            line = await self.reader.readline()
            if not line:
                return
            msg = json.loads(line)
            t = msg.get("t")
            if t in ("grant", "reject"):
                async with self.cv:
                    self._grant = "grant" if t == "grant" else msg.get("reason", "rejected")
                    self.cv.notify_all()
            elif t == "sleep":
                async with self.cv:
                    if self.inflight == 0 and self.resident and not self.waking:
                        await self.be.evict(self.m.name)
                        self.resident = False
                        await self._send(t="slept", model=self.m.name)
                    else:
                        self.sleep_pending = True      # drained in _leave
                    self.cv.notify_all()
