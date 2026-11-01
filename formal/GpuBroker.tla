---------------------------- MODULE GpuBroker ----------------------------
(***************************************************************************)
(* An abstract model of the midori per-node GPU time-slice broker         *)
(* (`runsc gpu-scheduler` + the driver's `g_ghostGroups` table).          *)
(*                                                                         *)
(* It re-derives the real fail-open defect (B300 README, defect #1): the   *)
(* group table allocated a slot per channel group and NEVER freed one on   *)
(* teardown, so after enough sandboxes the table filled and new contexts   *)
(* ran UNENFORCED -- their GPU-time weight silently ignored, with nothing  *)
(* logged (a 75/25 pair then measured 645:644 instead of ~3:1).           *)
(*                                                                         *)
(* Abstraction: each tenant sandbox holds at most one channel "group" at   *)
(* a time (a simplification -- a real NCCL pod holds many; read a "slot"   *)
(* here as one unit of a sandbox's table footprint). A group is ENFORCED   *)
(* iff it holds a slot in the finite table. `leaked` counts slots still    *)
(* held by groups that are already gone -- the bug.                        *)
(*                                                                         *)
(* Four CONSTANTS let one spec cover the whole design space:               *)
(*   FreeOnDestroy  TRUE  = the fix (release the slot in kchangrpapiDestruct)*)
(*                  FALSE = the historical leak                            *)
(*   FailClosed     TRUE  = refuse to start a group when the table is full  *)
(*                  FALSE = admit it unenforced (the real "fail-open")      *)
(*                                                                         *)
(* See formal/README.md for the configs and what each one demonstrates.    *)
(***************************************************************************)
EXTENDS Naturals, FiniteSets

CONSTANTS
    Sandboxes,      \* set of tenant sandbox ids, e.g. {s1, s2, s3}
    MaxSlots,       \* size of the group table (real: 256; keep small for TLC)
    FreeOnDestroy,  \* BOOLEAN -- TRUE frees the slot on teardown (the fix)
    FailClosed      \* BOOLEAN -- TRUE blocks a new group when the table is full

ASSUME MaxSlots \in Nat /\ MaxSlots >= 1
ASSUME FreeOnDestroy \in BOOLEAN
ASSUME FailClosed \in BOOLEAN

VARIABLES
    live,       \* subset of Sandboxes with a currently-running group
    enforced,   \* subset of `live` whose group holds a table slot
    leaked      \* count of slots held by groups that have already been torn down

vars == <<live, enforced, leaked>>

\* Slots physically occupied = those held by running enforced groups
\* plus those leaked by the bug.
UsedSlots == Cardinality(enforced) + leaked

TypeOK ==
    /\ live \subseteq Sandboxes
    /\ enforced \subseteq live
    /\ leaked \in 0..MaxSlots

Init ==
    /\ live = {}
    /\ enforced = {}
    /\ leaked = 0

\* A sandbox starts a channel group. It gets a slot (is enforced) iff the
\* table has room. If it is full: fail-open admits it UNENFORCED (the real
\* behaviour), fail-closed blocks the start entirely.
Create(s) ==
    /\ s \notin live
    /\ LET room == UsedSlots < MaxSlots IN
         /\ FailClosed => room
         /\ live' = live \cup {s}
         /\ enforced' = IF room THEN enforced \cup {s} ELSE enforced
         /\ UNCHANGED leaked

\* A sandbox tears its group down. The fix frees its slot here; the bug
\* leaves the slot occupied forever (leaked += 1).
Destroy(s) ==
    /\ s \in live
    /\ live' = live \ {s}
    /\ enforced' = enforced \ {s}
    /\ leaked' = IF (~FreeOnDestroy) /\ (s \in enforced)
                 THEN leaked + 1
                 ELSE leaked

Next == \E s \in Sandboxes : (Create(s) \/ Destroy(s))

\* Weak fairness on teardown: groups do eventually get torn down, so the
\* table *can* drain -- which makes the liveness property below meaningful.
Spec == Init /\ [][Next]_vars /\ WF_vars(\E s \in Sandboxes : Destroy(s))

-----------------------------------------------------------------------------
(* Properties *)

\* SECURITY (safety): no running group is left unenforced. A violation is a
\* fail-open -- a tenant running with its GPU-time weight/limit NOT applied,
\* i.e. able to starve or exceed its share. This is the property the bug broke.
EnforcementActive == live \subseteq enforced

\* RESOURCE (safety): the table holds no slot for a group that is already gone.
NoSlotLeak == leaked = 0

\* SANITY (safety): the table is never oversubscribed.
SlotsBounded == UsedSlots <= MaxSlots

\* LIVENESS: the table never gets PERMANENTLY stuck full -- i.e. enforcement
\* is never *permanently* disabled. The leak makes "full" a trap state.
Drains == []<>(UsedSlots < MaxSlots)
=============================================================================
