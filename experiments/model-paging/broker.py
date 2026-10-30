"""Reference residency broker (Python) for the proxy-less path.

The production broker is the Go residency.Manager + RPC server in the gVisor
gpu-scheduler (gvisor/pkg/gpusched/residency/). This Python broker is the same
logic over the ResidencyManager in residency.py — a reference and the test
counterpart for agent.py. It speaks the wire protocol (PROTOCOL.md) to one agent
per model.

Design: admissions are orchestrated one at a time (an asyncio lock, like the
proxy's transition lock — sleep/wake share PCIe anyway). On `acquire(X)` it
commits the decision in the Manager (evict victims in accounting, reserve +
pin X), pushes `sleep` to each victim's agent, waits for their `slept` acks (VRAM
physically freed), then `grant`s X. Agents always converge to the Manager's
decision, so accounting stays the source of truth. If X can't fit because every
candidate is pinned (busy), it parks X and retries on the next `release`; if X
can never fit the budget, it `reject`s.
"""

from __future__ import annotations

import asyncio
import json

from residency import CapacityError, Model, ResidencyManager


class ResidencyBroker:
    def __init__(self, manager: ResidencyManager):
        self.mgr = manager
        self.writers = {}          # model -> StreamWriter
        self.models = {}           # model -> residency.Model
        self.slept_events = {}     # victim model -> asyncio.Event
        self.pending = []          # FIFO of model names awaiting capacity
        self._adm = asyncio.Lock() # serialize admission orchestrations
        self._clock = 0.0

    def _tick(self):
        self._clock += 1.0
        return self._clock

    async def _send(self, to, **msg):
        w = self.writers.get(to)
        if w is None:
            return
        w.write((json.dumps(msg) + "\n").encode())
        await w.drain()

    # ---- connection handler (one per agent) ----
    async def serve(self, reader, writer):
        me = None
        try:
            while True:
                line = await reader.readline()
                if not line:
                    break
                msg = json.loads(line)
                t = msg.get("t")
                if t == "register":
                    me = msg["model"]
                    self.models[me] = Model(me, msg["tenant"], int(msg["size_mib"]),
                                            msg.get("tier", "pinned_ram"))
                    self.writers[me] = writer
                elif t == "acquire":
                    asyncio.create_task(self._acquire(msg["model"]))
                elif t == "release":
                    self._release(msg["model"])
                elif t == "slept":
                    ev = self.slept_events.get(msg["model"])
                    if ev:
                        ev.set()
        finally:
            if me:
                self._disconnect(me)
            try:
                writer.close()
            except Exception:
                pass

    def _disconnect(self, model):
        self.writers.pop(model, None)
        if self.mgr.is_resident(model):
            self.mgr._evict(model)     # free accounting; its VRAM is gone with it

    # ---- admission ----
    def _can_ever_fit(self, m: Model) -> bool:
        if m.size_mib > self.mgr.budget:
            return False
        by_tenant = {}
        for e in self.mgr.resident.values():
            by_tenant[e.model.tenant] = by_tenant.get(e.model.tenant, 0) + e.model.size_mib
        freeable = sum(max(0, mib - self.mgr.reserved.get(t, 0)) for t, mib in by_tenant.items())
        free = self.mgr.budget - self.mgr.used_mib
        return m.size_mib <= free + freeable

    async def _acquire(self, name):
        m = self.models[name]
        async with self._adm:
            if self.mgr.is_resident(name):
                self.mgr.pin(name)             # already up (raced) -> just pin + grant
                await self._send(name, t="grant", model=name)
                return
            try:
                _fault, victims = self.mgr.admit(m, self._tick())
            except CapacityError:
                if self._can_ever_fit(m):
                    if name not in self.pending:
                        self.pending.append(name)
                else:
                    await self._send(name, t="reject", model=name, reason="exceeds budget")
                return
            self.mgr.pin(name)                 # hold X while it serves
            # physically evict the victims, then grant.
            evs = []
            for v in victims:
                ev = asyncio.Event()
                self.slept_events[v] = ev
                evs.append((v, ev))
                await self._send(v, t="sleep", model=v)
            for v, ev in evs:
                await ev.wait()
                self.slept_events.pop(v, None)
            await self._send(name, t="grant", model=name)

    def _release(self, name):
        self.mgr.unpin(name)
        # capacity may have freed; retry everything parked (FIFO).
        parked, self.pending = self.pending, []
        for n in parked:
            asyncio.create_task(self._acquire(n))
