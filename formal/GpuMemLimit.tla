--------------------------- MODULE GpuMemLimit ---------------------------
(***************************************************************************)
(* Per-device GPU memory-limit enforcement (B300 README, defect #3).       *)
(*                                                                         *)
(* HAMi's `gpumem` quota is PER DEVICE. The gVisor webhook first used it   *)
(* as the whole-sandbox TOTAL (gpumem x #GPUs). A multi-GPU pod could then  *)
(* stack its entire total onto ONE device -- past that device's share and  *)
(* into a co-tenant's VRAM on the same card. The fix,                       *)
(* `--nvproxy-gpu-memory-limit-per-device`, attributes each allocation to   *)
(* the device it was made under (the NV01_DEVICE_0 of its alloc) and caps   *)
(* PER DEVICE; VRAM that cannot be attributed counts against EVERY device   *)
(* the pod uses.                                                           *)
(*                                                                         *)
(* CONSTANT PerDevice toggles the fix (per-device cap) vs the bug (total    *)
(* cap). Topology: p1 is a 2-GPU pod sharing device g0 with the 1-GPU pod   *)
(* p2; Card = 2*GpuMem sizes g0 for exactly both. Verified behaviour from   *)
(* tenant-nv-b: each GPU reports 50000 MiB; 45000 fits on both; +10000 on   *)
(* one GPU is refused -- which is exactly PerDeviceLimitHeld.               *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS GpuMem, Card, PerDevice
ASSUME GpuMem \in Nat /\ GpuMem >= 1
ASSUME Card \in Nat
ASSUME PerDevice \in BOOLEAN

Pods    == {"p1", "p2"}
Devices == {"g0", "g1"}
\* Placement: p1 is a 2-GPU pod; p2 is a 1-GPU pod sharing g0 with it.
Uses == [p \in Pods |-> IF p = "p1" THEN {"g0", "g1"} ELSE {"g0"}]

VARIABLES
    attr,   \* attr[p][d]: VRAM of pod p attributed to device d
    un      \* un[p]: pod p's unattributable VRAM (counts against every device p uses)

vars == <<attr, un>>

RECURSIVE SumFn(_)
SumFn(f) == IF DOMAIN f = {} THEN 0
            ELSE LET x == CHOOSE e \in DOMAIN f : TRUE
                 IN f[x] + SumFn([e \in (DOMAIN f \ {x}) |-> f[e]])

\* What pod p holds on device d: its attributed VRAM there, plus its
\* unattributable VRAM (which is charged to every device p uses).
Charged(p, d) == attr[p][d] + un[p]
TotalUsed(p)  == un[p] + SumFn([d \in Uses[p] |-> attr[p][d]])
Total(p)      == GpuMem * Cardinality(Uses[p])
DeviceLoad(d) == SumFn([p \in {q \in Pods : d \in Uses[q]} |-> Charged(p, d)])

TypeOK == /\ attr \in [Pods -> [Devices -> Nat]]
          /\ un \in [Pods -> Nat]

Init == /\ attr = [p \in Pods |-> [d \in Devices |-> 0]]
        /\ un   = [p \in Pods |-> 0]

\* Admission for a 1-unit allocation attributed to device d.
AdmitAttr(p, d) == IF PerDevice THEN Charged(p, d) + 1 <= GpuMem
                                ELSE TotalUsed(p) + 1 <= Total(p)

\* Admission for a 1-unit UNATTRIBUTABLE allocation: under the fix it must fit
\* on EVERY device p uses (it is charged to all of them).
AdmitUn(p) == IF PerDevice THEN \A d \in Uses[p] : Charged(p, d) + 1 <= GpuMem
                           ELSE TotalUsed(p) + 1 <= Total(p)

AllocAttr(p, d) == /\ d \in Uses[p]
                   /\ AdmitAttr(p, d)
                   /\ attr' = [attr EXCEPT ![p][d] = attr[p][d] + 1]
                   /\ UNCHANGED un

AllocUn(p) == /\ Uses[p] # {}
              /\ AdmitUn(p)
              /\ un' = [un EXCEPT ![p] = un[p] + 1]
              /\ UNCHANGED attr

FreeAttr(p, d) == /\ attr[p][d] > 0
                  /\ attr' = [attr EXCEPT ![p][d] = attr[p][d] - 1]
                  /\ UNCHANGED un

FreeUn(p) == /\ un[p] > 0
             /\ un' = [un EXCEPT ![p] = un[p] - 1]
             /\ UNCHANGED attr

Next == \E p \in Pods :
            \/ AllocUn(p)
            \/ FreeUn(p)
            \/ \E d \in Devices : (AllocAttr(p, d) \/ FreeAttr(p, d))

Spec == Init /\ [][Next]_vars

-----------------------------------------------------------------------------
(* Properties *)

\* SECURITY: no pod holds more than its per-device limit on any device it uses.
\* (The webhook's "+10000 on one GPU is refused" is this invariant.)
PerDeviceLimitHeld == \A p \in Pods, d \in Uses[p] : Charged(p, d) <= GpuMem

\* ISOLATION: no device ever holds more than its capacity -- no tenant's VRAM
\* spills into another tenant's share on that card. Assumes placement sized the
\* card (sum of GpuMem over pods on a device <= Card), which this topology meets.
NoOversubscription == \A d \in Devices : DeviceLoad(d) <= Card
=============================================================================
