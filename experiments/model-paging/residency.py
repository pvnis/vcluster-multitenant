"""Residency manager for model paging — the policy brain.

Weights are a *clean* cache of a host-resident master: eviction is free (no
writeback), only fault-in costs bandwidth. See manifests/midori/MODEL-PAGING.md.

Pure policy + accounting — no GPU, no vLLM, no concurrency. The simulator
(simulate.py) and the online daemon (pager.py) both drive it; the daemon turns
its decisions into real engine sleep/wake calls.

First-cut policy (matches the design note):
  - clean cache: eviction just frees VRAM, never a copy-out.
  - whole-model granularity.
  - LRU victim selection, with two fairness rules:
      1. evict the requesting tenant's OWN idle models first;
      2. never drop a tenant below its reserved resident floor.
  - active (pinned) models are never evicted.
  - fault-in latency = weight bytes / bandwidth(master tier).

Admission is atomic: `admit()` either plans + applies a full set of evictions
and reserves the model, or raises CapacityError having changed nothing. This
matters for the daemon, which must call backend.evict() for exactly the victims
the manager freed.
"""

from __future__ import annotations

from dataclasses import dataclass

MIB = 1024 * 1024  # bytes per MiB


@dataclass(frozen=True)
class Tier:
    """A place a clean master can live. bw_gbps is fault-in bandwidth to VRAM,
    decimal GB/s (1 GB = 1e9 bytes). Order tiers by *measured* bandwidth; the
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
    exceeds the budget). Admission state is left unchanged."""


@dataclass
class _Entry:
    model: Model
    last_used: float
    pins: int = 0        # >0 => in service, never evictable


# -- eviction policies: order idle, non-protected victims (lower rank = evict
#    first). Fairness (own-tenant-first) and floor/pin protection are invariants
#    applied on top, so a policy only reorders among eligible victims. --
class LRU:
    """Least-recently-used first."""

    def on_access(self, model: Model, now: float) -> None:
        pass

    def rank(self, entry: "_Entry", incoming: Model, mgr: "ResidencyManager") -> float:
        return entry.last_used


class CostAwareLRU:
    """LRU, but protect models that are expensive to fault back in. Among
    similarly-aged idle models, evict the one cheapest to reload first — so a
    master on a slow tier (NVMe) is kept over one on a fast tier (pinned RAM /
    NVLink) at equal recency. `beta` is seconds of extra staleness tolerated per
    second of refault cost. This is the cost-model placement the design calls for,
    scoped to one node (ServerlessLLM's `q + n/b`, victim side)."""

    def __init__(self, beta: float = 30.0):
        self.beta = beta

    def on_access(self, model: Model, now: float) -> None:
        pass

    def rank(self, entry: "_Entry", incoming: Model, mgr: "ResidencyManager") -> float:
        return entry.last_used + self.beta * mgr.fault_seconds(entry.model)


class FrequencyCost:
    """Admission/eviction cost model (TinyLFU / GDSF-flavored). Keeps a decaying
    access-frequency estimate per model and evicts, among eligible victims, the
    one with the lowest *retention priority* `freq * (1 + beta*refault_seconds)`
    (oldest first to break ties). So a model that is both popular and expensive to
    reload is kept; a one-off model is evicted first. Unlike plain LRU this
    resists cache pollution by a 'scan' of cold models that would otherwise push
    the hot working set out.

    Admission on a single node must still wake the requested model (there is no
    remote copy to serve from), but a just-admitted one-off starts at frequency 1
    and so becomes the prime victim next, bounding the damage to the working set.
    `age_period` halves all frequencies periodically so popularity adapts."""

    def __init__(self, beta: float = 10.0, age_period: int = 256):
        self.beta = beta
        self.age_period = age_period
        self.freq: dict[str, float] = {}
        self.ops = 0

    def on_access(self, model: Model, now: float) -> None:
        self.ops += 1
        if self.age_period and self.ops % self.age_period == 0:
            for k in self.freq:
                self.freq[k] *= 0.5
        self.freq[model.name] = self.freq.get(model.name, 0.0) + 1.0

    def rank(self, entry: "_Entry", incoming: Model, mgr: "ResidencyManager"):
        f = self.freq.get(entry.model.name, 1.0)
        priority = f * (1.0 + self.beta * mgr.fault_seconds(entry.model))
        return (priority, entry.last_used)   # low priority, then oldest, first


class ResidencyManager:
    """Decides which models' weights are resident in one GPU's VRAM budget."""

    def __init__(self, vram_budget_mib: int, tiers, reserved_mib=None, policy=None):
        self.budget = int(vram_budget_mib)
        self.tiers = {t.name: t for t in tiers}
        self.reserved = dict(reserved_mib or {})   # tenant -> MiB floor
        self.policy = policy or LRU()
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

    # ---- admission ----
    def access(self, model: Model, now: float) -> float:
        """Make `model` resident (evicting as needed) and return fault-in
        seconds (0.0 on a hit). Convenience wrapper over admit() for callers
        (the simulator) that don't need the victim list."""
        return self.admit(model, now)[0]

    def admit(self, model: Model, now: float):
        """Make `model` resident and return (fault_seconds, [evicted names]).
        On a hit: (0.0, []). On a miss: evicts the planned victims, reserves the
        model, and returns the fault-in cost + the victims the caller must now
        actually free (backend.evict). Raises CapacityError (changing nothing)
        if the model cannot be admitted. Does NOT pin — caller pins while
        serving."""
        if model.size_mib > self.budget:
            self.capacity_stalls += 1
            raise CapacityError(f"{model.name} ({model.size_mib} MiB) > budget "
                                f"({self.budget} MiB)")
        self.policy.on_access(model, now)   # frequency/recency signal for the policy
        e = self.resident.get(model.name)
        if e is not None:
            e.last_used = now
            self.hits += 1
            return 0.0, []
        self.misses += 1
        plan = self._plan_eviction(model)
        if plan is None:
            self.capacity_stalls += 1
            raise CapacityError(
                f"cannot fit {model.name}: no eviction plan "
                f"(used {self.used_mib}/{self.budget} MiB)")
        for name in plan:
            self._evict(name)
        self.resident[model.name] = _Entry(model, now)
        self.used_mib += model.size_mib
        self.mib_faulted += model.size_mib
        return self.fault_seconds(model), plan

    def pin(self, name: str) -> None:
        self.resident[name].pins += 1

    def unpin(self, name: str) -> None:
        e = self.resident[name]
        e.pins = max(0, e.pins - 1)

    # ---- eviction planning ----
    def _plan_eviction(self, incoming: Model):
        """Return the ordered list of victims to evict so `incoming` fits, or
        None if impossible. Pure dry-run — mutates nothing. Victim order:
        requesting-tenant's own idle first, then LRU; skips pinned models and any
        whose eviction would breach its tenant's reserved floor."""
        if self.used_mib + incoming.size_mib <= self.budget:
            return []
        used = self.used_mib
        tnow = {}
        for e in self.resident.values():
            tnow[e.model.tenant] = tnow.get(e.model.tenant, 0) + e.model.size_mib
        removed = set()
        plan = []
        while used + incoming.size_mib > self.budget:
            best_key = best_name = best_entry = None
            for name, e in self.resident.items():
                if name in removed or e.pins > 0:
                    continue
                t = e.model.tenant
                floor = self.reserved.get(t, 0)
                if floor and tnow[t] - e.model.size_mib < floor:
                    continue
                key = (0 if t == incoming.tenant else 1,
                       self.policy.rank(e, incoming, self))
                if best_key is None or key < best_key:
                    best_key, best_name, best_entry = key, name, e
            if best_name is None:
                return None
            removed.add(best_name)
            plan.append(best_name)
            used -= best_entry.model.size_mib
            tnow[best_entry.model.tenant] -= best_entry.model.size_mib
        return plan

    def _evict(self, name: str) -> None:
        e = self.resident.pop(name)
        self.used_mib -= e.model.size_mib
        self.evictions += 1
        # clean cache: nothing is written back — the master already holds it.
