"""Residency manager for the model-paging POC.

Weights are a *clean* cache of a host-resident master: eviction is free (no
writeback), only fault-in costs bandwidth. See manifests/midori/MODEL-PAGING.md.

This module is pure policy + accounting — no GPU, no vLLM. The simulator feeds
it accesses and reads back the fault-in latency; a real backend
(vllm_backend.py) performs the sleep/wake the manager decides.

First-cut policy (matches the design note):
  - clean cache: eviction just frees VRAM, never a copy-out.
  - whole-model granularity.
  - LRU victim selection, with two fairness rules:
      1. evict the requesting tenant's OWN idle models first;
      2. never drop a tenant below its reserved resident floor.
  - active (pinned) models are never evicted.
  - fault-in latency = weight bytes / bandwidth(master tier).
"""

from __future__ import annotations

from dataclasses import dataclass

MIB = 1024 * 1024  # bytes per MiB


@dataclass(frozen=True)
class Tier:
    """A place a clean master can live. bw_gbps is fault-in bandwidth to VRAM,
    in decimal GB/s (1 GB = 1e9 bytes). Order tiers by *measured* bandwidth; the
    topology section of MODEL-PAGING.md lists realistic values per interconnect."""

    name: str
    bw_gbps: float


@dataclass(frozen=True)
class Model:
    name: str
    tenant: str
    size_mib: int        # weight footprint in VRAM
    master_tier: str     # which Tier holds the clean master


class CapacityError(RuntimeError):
    """A model cannot be made resident even after evicting every eligible victim
    (reserved floors + pinned models leave too little room, or the model alone
    exceeds the budget)."""


@dataclass
class _Entry:
    model: Model
    last_used: float
    pins: int = 0        # >0 => in service, never evictable


class ResidencyManager:
    """Decides which models' weights are resident in one GPU's VRAM budget."""

    def __init__(self, vram_budget_mib: int, tiers, reserved_mib=None):
        self.budget = int(vram_budget_mib)
        self.tiers = {t.name: t for t in tiers}
        self.reserved = dict(reserved_mib or {})   # tenant -> MiB floor
        self.resident: dict[str, _Entry] = {}
        self.used_mib = 0
        # stats
        self.hits = 0
        self.misses = 0
        self.evictions = 0
        self.mib_faulted = 0
        self.capacity_stalls = 0

    # ---- queries ----
    def is_resident(self, name: str) -> bool:
        return name in self.resident

    def tenant_resident_mib(self, tenant: str) -> int:
        return sum(e.model.size_mib for e in self.resident.values()
                   if e.model.tenant == tenant)

    def fault_seconds(self, model: Model) -> float:
        tier = self.tiers[model.master_tier]
        return (model.size_mib * MIB) / (tier.bw_gbps * 1e9)

    @property
    def hit_rate(self) -> float:
        total = self.hits + self.misses
        return self.hits / total if total else 0.0

    # ---- core ----
    def access(self, model: Model, now: float) -> float:
        """Make `model` resident (evicting as needed) and return fault-in
        seconds (0.0 on a hit). Does not pin; the caller pins while serving.
        Raises CapacityError if the model cannot be admitted."""
        if model.size_mib > self.budget:
            self.capacity_stalls += 1
            raise CapacityError(f"{model.name} ({model.size_mib} MiB) > budget "
                                f"({self.budget} MiB)")
        e = self.resident.get(model.name)
        if e is not None:
            e.last_used = now
            self.hits += 1
            return 0.0
        self.misses += 1
        self._ensure_room(model)
        self.resident[model.name] = _Entry(model, now)
        self.used_mib += model.size_mib
        self.mib_faulted += model.size_mib
        return self.fault_seconds(model)

    def pin(self, name: str) -> None:
        self.resident[name].pins += 1

    def unpin(self, name: str) -> None:
        e = self.resident[name]
        e.pins = max(0, e.pins - 1)

    # ---- eviction ----
    def _ensure_room(self, incoming: Model) -> None:
        while self.used_mib + incoming.size_mib > self.budget:
            victim = self._pick_victim(incoming.tenant)
            if victim is None:
                self.capacity_stalls += 1
                raise CapacityError(
                    f"cannot fit {incoming.name}: no evictable victim "
                    f"(used {self.used_mib}/{self.budget} MiB)")
            self._evict(victim)

    def _pick_victim(self, incoming_tenant: str):
        """Best idle victim, or None. Sort key: own-tenant-first, then LRU.
        Skips any model whose eviction would drop its tenant below its floor.
        Recomputed each call, so multi-evictions respect floors live."""
        best_key = None
        best_name = None
        for name, e in self.resident.items():
            if e.pins > 0:
                continue
            t = e.model.tenant
            floor = self.reserved.get(t, 0)
            if floor and self.tenant_resident_mib(t) - e.model.size_mib < floor:
                continue  # would breach this tenant's reserved floor
            key = (0 if t == incoming_tenant else 1, e.last_used)
            if best_key is None or key < best_key:
                best_key, best_name = key, name
        return best_name

    def _evict(self, name: str) -> None:
        e = self.resident.pop(name)
        self.used_mib -= e.model.size_mib
        self.evictions += 1
        # clean cache: nothing is written back — the master already holds it.
