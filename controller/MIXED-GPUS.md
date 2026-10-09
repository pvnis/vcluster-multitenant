# Whole-card GPU memory, and clusters with mixed GPUs: to decide

**Status: open, to discuss and decide later (noted 2026-10-08).** What is
done today, why it only works while every card is the same, and the options
for when a second card type arrives.

## The problem

A pod that asks for `nvidia.com/gpu` without `nvidia.com/gpumem` gets whole
cards, but declares no GPU memory. ResourceQuota only counts what pods
declare, so such a pod held 46 GiB per card while the tenant's
`gpuMemoryMiB` quota charged it 0: the UI read "0 GiB requested" on a cluster
whose four cards were all held.

## What is done today (uniform cluster)

- **Reporting:** the UI and Grafana show GPU memory *held* (slices at their
  request, whole cards at a full card) and *in use* (DCGM), from Prometheus.
- **Behaviour:** the gVisor quota webhook makes whole-card memory explicit. A
  container asking for `nvidia.com/gpu` without `nvidia.com/gpumem` or
  `nvidia.com/gpumem-percentage` is given `nvidia.com/gpumem` = one card
  (46068 MiB, a webhook flag), so the quota charges it like any other pod.
  Deployed 2026-10-08 (webhook `4409f996b`, gpuslicing) and tested on a
  scratch tenant (whole-GPU pod refused under a 10000 MiB quota, admitted
  and charged 46068 under a one-card quota; slices and percentage pods
  unchanged; vCluster's syncer leaves the host-side change alone).
  Since 2026-10-09 (`8256a2d49`) percentages and `gpucores: 100` pods are
  stated in MiB of the same card too, and quotas bound
  `midori.phoenix/gpu-memory` (MiB x GPUs).
  This is correct **only while every card has the same memory**: at admission
  the webhook cannot know which card the pod will land on.

## Why mixed GPUs break it

With, say, A6000s (48 GB) and H100s (80 GB) in one cluster:

- "A whole card" has no single MiB value at admission time.
- A MiB quota mixes two kinds of card: 92 GiB could mean two A6000s or one
  H100 and change, and says nothing about which a tenant may have.
- HAMi places by memory: a pod asking 46068 MiB fits an H100 too, leaving 34
  GiB of it stranded for anyone else wanting a whole card.

## Options

Everything the webhook turns into MiB (whole cards, percentages,
`gpucores: 100`) depends on that one card size.

**A. Size-free whole cards: `nvidia.com/gpumem-percentage: 100`.**
HAMi's own way to say "all of whichever card" (it cannot be combined with
`nvidia.com/gpumem`). The webhook would set it instead of a MiB value.
Placement works on any card; but the quota then counts percent of *a* card,
not memory, so `gpuMemoryMiB` no longer bounds whole-card use and a
"percent" quota treats an A6000 and an H100 as equal.

**B. Quota per GPU class (recommended to evaluate first).**
Give each card type its own resource names (HAMi's resource naming is
configurable per device type), e.g. `nvidia.com/a6000`,
`nvidia.com/a6000-mem`, `nvidia.com/h100`, ... Tenants get quotas per class
("2 A6000 + 1 H100"), pods ask for the class they need, memory quotas stay
meaningful within a class, and the webhook's full-card default becomes a
per-class constant it can know at admission. Costs: pod specs name a class;
HAMi configuration and the controller's quota model grow a dimension; the UI
shows commitment per class.

**C. Pin by model, keep one resource name.**
Node labels per GPU model plus HAMi's `nvidia.com/use-gputype` annotation to
steer pods. Simplest to run, but quotas cannot distinguish classes at all.

**D. Keep the cluster uniform.**
Separate clusters (or separate HAMi-managed pools with their own tenants) per
card type. Avoids the problem; costs flexibility.

## To decide

1. Will midori (or its successors) mix card types, and which?
2. Should tenants be granted capacity per class (B), or is one pool with
   steering enough (C)?
3. For whole cards: MiB per class (B), or percent (A)?
4. What happens to running tenants' quotas when classes are introduced.

Until then, the webhook's full-card default (`--nvidia-whole-card-mib`)
assumes one card size; adding a different card means revisiting this first.
