# Batch vs serving: priority, preemption, and reclaim

> Design, 2026-11-19. The clean long-term answer to "batch jobs are Pending while
> idle/low-value work holds the GPUs." Make batch work **preempt idle filler** and
> **survive being bumped**, without letting a tenant self-escalate past its tier.

## Problem

Capacity on the two nvidia nodes is committed to serving tenants
(phoenix-serving, aisware) and to a choreographed demo (the `demo-board` engine's
GPU "burners" in demo-chat/research/vision). Batch work — the ocudu-isac radar
sweeps and Sionna ray-tracing, tenant-sim sims — then sits Pending
(`CardInsufficientMemory`/`CardInsufficientCore`, `Insufficient cpu`). Raising a
tenant's *quota* does nothing: quota is a ceiling, not capacity. We need a
*scheduling* answer: batch reclaims from idle filler, serving is protected, and a
preempted batch job resumes rather than loses its work.

## The three tiers (host PriorityClasses)

| class | value | preemptionPolicy | for |
| --- | --- | --- | --- |
| `midori-serving` | 100000 | PreemptLowerPriority | latency-sensitive serving |
| `midori-batch` | 10000 | PreemptLowerPriority | batch sims (sweeps, Sionna) |
| `midori-idle` | 100 | **Never** | opportunistic filler (the demo burners) |

`system-cluster-critical`/`system-node-critical` stay above all. Net: **batch
preempts idle; serving preempts batch and idle; idle preempts nothing.** The demo
burners become `idle`, so batch evicts them when it needs room and they refill
when batch drains — which is exactly the behaviour the demo wants anyway
(opportunistic GPU filler).

## Per-tenant gating (so a tenant can't self-escalate)

A tenant must not set `priorityClassName: midori-serving` to jump the queue. Same
shape as the `lb-pool` gate:

1. New Tenant field **`spec.scheduling.class: serving | batch | idle`** — the
   tenant's **maximum** tier (default `batch`). The controller writes a namespace
   label `midori.phoenix/priority-max: <tier>`.
2. The **vCluster syncer** translates each pod's `priorityClassName` to the host
   class (host PriorityClasses must exist; the tenant's in-vcluster class name
   maps to a host one).
3. A host **ValidatingAdmissionPolicy** denies a tenant Service/Pod whose
   effective priority **exceeds** the namespace's `priority-max` — so an
   `idle`-tier tenant can't run `batch`, a `batch` tenant can't run `serving`.
4. Map existing tenants: serving tenants → `serving`; ocudu-isac, tenant-sim →
   `batch`; **demo-\* → `idle`**.

## Two scheduling layers (both apply — don't conflate)

- **kube-scheduler + HAMi = admission / preemption.** Decides *which* pods hold a
  GPU slice; this is where batch evicts idle.
- **GHOST (`runsc-gpu-scheduler`) = runtime share.** Credit-weights (`gpucores`)
  the pods that are *already* admitted to a GPU.

Priority/preemption is the **admission** layer; GHOST weights are the **runtime**
layer. They stack: preemption frees a slice for a batch pod, then GHOST time-slices
whatever co-resides.

> ⚠️ **Validated 2026-11-19 — GPU preemption does NOT work here.** The `hami-scheduler`
> places GPU pods via a `vgpu-scheduler-extender` that declares only `filterVerb`
> and `bindVerb` — **no preemption verb** — and lists every GPU resource
> (`nvidia.com/gpu`, `gpumem`, `gpucores`, `gpumem-percentage`,
> `midori.phoenix/gpu-memory`) as `ignoredByScheduler: true`. So the in-tree
> `DefaultPreemption` can't reason about freeing GPU (it's told to ignore it), and
> the extender that *does* decide GPU fit has no preemption hook and computes fit
> from live node annotations (a preemption dry-run doesn't actually remove the
> victim, so the card still reads full). **k8s preemption cannot evict a GPU pod to
> free a slice.** This is a known HAMi limitation.
>
> **What this changes:**
> - **CPU/memory preemption still works** — those resources are *not* ignored, so
>   the default scheduler preempts on them normally. The PriorityClass tiers below
>   are fully effective for the **CPU radar sweeps** (batch evicts idle for CPU/mem).
> - **For the GPU half, eviction is off the table; use one of:**
>   1. **HAMi task priority** (`nvidia.com/priority`, one of the managed resources)
>      — a *runtime* GPU-compute priority where low-priority tasks yield to
>      high-priority ones. No eviction (the idle pod keeps its gpumem reservation),
>      but batch gets the GPU *time*. Evaluate this first — it's native.
>   2. **A custom reclaim controller** for the `idle` tier: on batch GPU demand,
>      signal the idle workloads (e.g. the `demo-board` engine) to **release**
>      their burners, freeing the slice; refill when batch drains. This is the only
>      way to actually free the gpumem *reservation*.
>   3. Combine: HAMi task-priority for soft runtime sharing + the reclaim
>      controller for hard capacity reclaim under sustained pressure.

## Graceful preemption + swappable memory

A preempted batch sim must not lose work:

- **Checkpoint/resume convention** for the `batch`/`idle` tiers: catch SIGTERM →
  checkpoint → exit → reschedule & resume (app-level, or CRIU), with a long
  `terminationGracePeriodSeconds`.
- **Host memory swap:** enable **k8s NodeSwap** on the GPU nodes for Burstable/
  BestEffort (batch/idle) pods — memory pressure then swaps instead of OOM-killing,
  so more work coexists and a bumped pod swaps out cheaply.
- **GPU memory paging:** for resident GPU state, tie into the **model-paging /
  VRAM-cache** work (`model-paging-agent` worktree) so a preempted GPU job pages
  its state out of VRAM and back on resume.

## Quota interaction

Use **priority-scoped ResourceQuota** (`spec.scopeSelector` by PriorityClass) so
batch/idle work gets separate, generous-but-preemptible limits without consuming
serving's guaranteed quota.

## Phased rollout

1. **Validate HAMi preemption** — the plan's GPU half hinges on it. (Config check
   now; empirical test — a `batch` pod preempting an `idle` GPU pod — needs running
   GPU workloads, so it's an operator-run step.)
2. Define the 3 PriorityClasses; prove **CPU/memory** preemption end-to-end (that
   part works with the default scheduler regardless of HAMi).
3. Add `spec.scheduling.class` + controller gating (namespace label + admission
   guard + vCluster priority translate).
4. Map tenants; set **demo-\* → idle** so batch reclaims from them.
5. Graceful preemption: NodeSwap on the GPU nodes + the checkpoint convention;
   integrate model-paging for GPU state.
6. Priority-scoped quotas.

## Coordination

Overlaps two active worktrees — **`hetero-gpu-design`** (GPU scheduling) and
**`model-paging-agent`** (the swappable-memory piece). Align with both before
building so we don't duplicate or conflict. The demo-\*→idle mapping also touches
the `demo-live` session's engine (its burners become preemptible).
