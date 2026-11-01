# formal/ — machine-checkable models of midori's critical properties

First model: **`GpuBroker.tla`** — the per-node GPU time-slice broker
(`runsc gpu-scheduler` + the driver's `g_ghostGroups` table). It re-derives, as a
model-checked counterexample, the real **fail-open** defect from the B300 bring-up
(`manifests/b300/README.md`, defect #1): the group table allocated a slot per
channel group and **never freed one on teardown**, so after enough sandboxes the
table filled and new GPU contexts ran **unenforced** — their time-slice weight
silently ignored, nothing logged (a 75/25 pair then measured 645:644 instead of
~3:1).

We model the *design*, in TLA+, because that bug is a resource-lifecycle /
concurrency bug, not a code typo — exactly the class a model checker catches and a
code proof of the wrong design would miss.

## What it models

Each tenant **sandbox** holds at most one channel **group** at a time (a
simplification — a real NCCL pod holds many; read one "slot" as one unit of a
sandbox's table footprint). A group is **enforced** iff it holds a slot in the
finite table of size `MaxSlots`. `leaked` counts slots still held by groups that
are already gone — the bug.

Two booleans cover the whole design space in one spec:

| CONSTANT | TRUE | FALSE |
| --- | --- | --- |
| `FreeOnDestroy` | the fix: release the slot in `kchangrpapiDestruct` | the historical leak |
| `FailClosed` | refuse to start a group when the table is full | admit it unenforced (the real "fail-open") |

## The properties

- **`EnforcementActive`** (safety, *the security property*): `live ⊆ enforced` — no
  running group is unenforced. A violation **is** a fail-open: a tenant whose GPU
  weight/limit is not applied, free to starve or exceed its share.
- **`NoSlotLeak`** (safety): `leaked = 0` — the table holds no slot for a group
  that is already gone.
- **`SlotsBounded`** (safety): the table is never oversubscribed.
- **`Drains`** (liveness): `[]<>(UsedSlots < MaxSlots)` — the table never gets
  *permanently* stuck full, i.e. enforcement is never *permanently* disabled.

## Configs and what each demonstrates

| config | `FreeOnDestroy` | `FailClosed` | `MaxSlots` | expected result |
| --- | --- | --- | --- | --- |
| `GpuBroker_bug.cfg` | FALSE | FALSE | 3 | **FAILS** `NoSlotLeak` (and `EnforcementActive`, `Drains`) — the historical bug |
| `GpuBroker_fixed.cfg` | TRUE | FALSE | 3 | **all hold** — freeing + a table sized for peak makes fail-open admission harmless |

Two more worth running by editing the constants in a copy of a `.cfg`:

- **Undersized** (`FreeOnDestroy=TRUE, FailClosed=FALSE, MaxSlots=2`): `EnforcementActive`
  **still FAILS**. Lesson: freeing the slot is necessary but **not sufficient** — the
  table must also be sized for peak concurrent groups, or fail-open recurs under load.
- **Fail-closed** (`FreeOnDestroy=TRUE, FailClosed=TRUE, MaxSlots=2`): `EnforcementActive`
  **holds** (an unenforced group is never admitted) and `Drains` holds (slots free
  up). Lesson: fail-closed trades availability for the guarantee — but note that for a
  real CUDA context you often cannot refuse creation, so the practical guarantee is
  *free the slots + size the table ≥ peak + alert on full*, not blocking.

## Expected TLC output (verified by hand; see "Running" to reproduce)

`GpuBroker_bug.cfg` → the shortest counterexample to `NoSlotLeak` is 2 steps:

```
State 1 (Init):   live = {}      enforced = {}      leaked = 0
State 2 Create(s1): live = {s1}  enforced = {s1}    leaked = 0
State 3 Destroy(s1): live = {}   enforced = {}      leaked = 1   <-- NoSlotLeak violated
```

and the slot never comes back. Continue filling by leak and `EnforcementActive`
breaks too — a new group runs while `live ⊄ enforced`:

```
… Create(s2),Destroy(s2),Create(s3),Destroy(s3)  → leaked = 3 = MaxSlots (table full of ghosts)
  Create(s1): room = (UsedSlots < MaxSlots) = (3 < 3) = FALSE
            → s1 admitted UNENFORCED: live = {s1}, enforced = {}   <-- EnforcementActive violated
```

`GpuBroker_fixed.cfg` → TLC explores the full (small) state space and reports **no
violations**; `Drains` holds under weak-fairness of teardown.

## Running

Needs Java + the TLA+ tools (`tla2tools.jar` from
<https://github.com/tlaplus/tlaplus/releases/latest>):

```bash
java -cp tla2tools.jar tlc2.TLC -config GpuBroker_bug.cfg   GpuBroker.tla   # expect violations
java -cp tla2tools.jar tlc2.TLC -config GpuBroker_fixed.cfg GpuBroker.tla   # expect clean
```

## Scope and assumptions (state these in any claim)

- This checks a **design model**, not the Go/C code. It proves the *broker's
  slot-lifecycle logic* is correct (or finds where it isn't) under the modeled
  actions — it assumes the driver, the Sentry, and the hardware behave as modeled.
- "One group per sandbox" is a simplification. To model a real multi-group sandbox,
  give each sandbox a weight of slots and have `Create`/`Destroy` move that many;
  the properties are unchanged.

## Second model: `Isolation.als` — tenant isolation (Alloy)

Alloy is the right tool for "is there a path tenant→tenant / tenant→platform
through the policy set?" — bounded model-finding over relational logic.
`Isolation.als` models the Cilium policy architecture: the deny **floor**
(cross-tenant), **platform-guard** (tenant→platform except DNS + S3), and tenant
self-widening (adversarial `allow`, with `permitted = allow − deny` so **denies
win**).

| command | expected |
| --- | --- |
| `check CrossTenantIsolation` | no counterexample — the floor denies cross-tenant regardless of tenant-authored allows |
| `check GuardEnforcesPlatformIsolation` | no counterexample — with the guard, no tenant reaches a non-exempt platform endpoint |
| `check NoTenantToForbiddenPlatform` | **counterexample** — *without* the guard, a tenant's `egress:{}` reaches a platform internal (the real pre-guard hole) |
| `run DnsAndS3ReachableUnderGuard` | instance — the guard isn't over-broad; DNS + S3 stay reachable |

The counterexample to `NoTenantToForbiddenPlatform` is the model-checked form of
the hole `platform-guard` closed: a tenant workload with a permitted flow to an
`OtherPlatform` workload (Loki / Prometheus / HAMi / webhook / registry).

What it proves and assumes:
- **Single-hop** reachability (a direct connection a Cilium policy governs) — the
  right semantics for netpol. App-level pivots (tenant→S3, then S3 forwards) are a
  different threat model, out of scope.
- `allow` is adversarial (any tenant egress); `deny` is the platform's floor+guard;
  `permitted = allow − deny` encodes "Cilium denies beat anything a tenant writes"
  — the property that makes tenant self-service NetworkPolicy safe.
- **Bounded** to scope 6: a clean `check` means "no counterexample up to 6 atoms of
  each kind," not a universal proof. Raise the scope for more confidence.

Running: open `Isolation.als` in the Alloy Analyzer
(<https://github.com/AlloyTools/org.alloytools.alloy/releases>) and Execute each
command, or run it headless with its CLI. Each `check` reports "No counterexample
found" or shows one in the visualizer.

## Next models (planned)

- **Per-device GPU memory limit** (TLA+) — "no tenant's attributed VRAM exceeds its
  limit" (the `--nvproxy-gpu-memory-limit-per-device` accounting; B300 defect #3).
- **Isolation extensions** (Alloy) — add tenant→internet (the `network.internet`
  gate) and tenant-authored NetworkPolicy ingress; raise the scope.
