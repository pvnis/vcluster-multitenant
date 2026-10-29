"""ModelPager — the online model-paging daemon.

Wraps the ResidencyManager (policy) and a Backend (engines) into a concurrent
request server. On each request it makes the model resident — waking it (and
evicting idle victims) if it was sleeping — then runs inference, holding a pin so
the model can't be evicted mid-flight.

Concurrency model (correct, deliberately simple):
  - one asyncio lock *per model* serializes that model's transitions, so
    concurrent requests for a sleeping model trigger exactly one wake and the
    rest see it resident (resident-in-manager implies physically loaded, because
    the admitter holds the model lock across the whole wake);
  - one global *transition* lock serializes the actual DMAs (sleep/wake share
    PCIe, so running two at once would only split the bandwidth);
  - a condition variable guards the manager and lets an admission that found all
    victims pinned wait until an in-flight request unpins one.
Inference itself holds no lock (only a pin), so many requests to resident models
run concurrently and the backend batches them.
"""

from __future__ import annotations

import asyncio
import time
from collections import defaultdict
from dataclasses import dataclass, field

from residency import CapacityError, Model, ResidencyManager


@dataclass
class Record:
    model: str
    tenant: str
    hit: bool
    fault_s: float
    setup_s: float       # time from request arrival to inference start
    ok: bool = True


@dataclass
class Stats:
    records: list = field(default_factory=list)
    rejects: int = 0


class ModelPager:
    def __init__(self, manager: ResidencyManager, backend, models):
        self.mgr = manager
        self.be = backend
        self.models = {m.name: m for m in models}
        self._cond = asyncio.Condition()           # guards mgr; signals unpins
        self._transition = asyncio.Lock()          # serializes real DMAs
        self._model_locks = defaultdict(asyncio.Lock)
        self.stats = Stats()
        self.hits = 0
        self.misses = 0

    async def generate(self, model_name: str, prompt: str, max_tokens: int = 16):
        model = self.models[model_name]
        t0 = time.perf_counter()
        try:
            fault, hit = await self._ensure_resident(model)
        except CapacityError:
            self.stats.rejects += 1
            self.stats.records.append(
                Record(model.name, model.tenant, False, 0.0, 0.0, ok=False))
            raise
        setup = time.perf_counter() - t0
        try:
            result = await self.be.infer(model.name, prompt, max_tokens)
        finally:
            async with self._cond:
                self.mgr.unpin(model.name)
                self._cond.notify_all()            # a pin freed -> admissions may retry
        self.stats.records.append(
            Record(model.name, model.tenant, hit, fault, setup))
        return result

    async def _ensure_resident(self, model: Model):
        async with self._model_locks[model.name]:
            # fast path: already resident (and, under this lock, physically loaded)
            async with self._cond:
                if self.mgr.is_resident(model.name):
                    self.mgr.access(model, time.perf_counter())
                    self.mgr.pin(model.name)
                    self.hits += 1
                    return 0.0, True
            # miss: serialize the DMA, reserve (waiting if all victims pinned),
            # then physically evict victims and wake the model.
            self.misses += 1
            async with self._transition:
                while True:
                    async with self._cond:
                        try:
                            _modeled, victims = self.mgr.admit(model, time.perf_counter())
                            self.mgr.pin(model.name)
                            break
                        except CapacityError:
                            if not self._can_ever_fit(model):
                                raise      # too big, or floors make it impossible
                            await self._cond.wait()   # a pin may free the room
                for v in victims:
                    await self.be.evict(v)
                fault = await self.be.load(model.name)
            return fault, False

    def _can_ever_fit(self, model: Model) -> bool:
        """Could this model fit if every currently-pinned model finished and
        released its pin? Pins are transient (an in-flight infer holds no lock
        and will complete), so waiting only helps when freeing all non-floor
        space would make room. If not, reject now instead of hanging."""
        if model.size_mib > self.mgr.budget:
            return False
        freeable = 0
        by_tenant = {}
        for e in self.mgr.resident.values():
            by_tenant[e.model.tenant] = by_tenant.get(e.model.tenant, 0) + e.model.size_mib
        for t, mib in by_tenant.items():
            freeable += max(0, mib - self.mgr.reserved.get(t, 0))
        free = self.mgr.budget - self.mgr.used_mib
        return model.size_mib <= free + freeable
