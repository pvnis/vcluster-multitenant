module isolation
/*
 * Tenant-isolation model for the midori multi-tenant cluster.
 *
 * Mirrors the Cilium policy architecture:
 *   - the deny FLOOR (manifests/cilium/tenant-floor.yaml + per-tenant *-floor
 *       CCNPs): denies tenant -> other-tenant (and tenant -> outside, not
 *       modeled here -- see "Extensions" in formal/README.md).
 *   - platform-guard.yaml: denies tenant -> platform EXCEPT cluster DNS and the
 *       S3 gateway.
 *   - tenants may sync their OWN NetworkPolicies, but Cilium DENIES WIN, so a
 *       tenant cannot widen past the floor/guard. We model that by letting the
 *       ALLOW relation be adversarial (any tenant-authored egress, incl.
 *       egress:{}) while the platform's DENY relation is fixed by the floor/
 *       guard, and taking   permitted = allow - deny.
 *
 * Bounded checks below reproduce, as a counterexample, the real pre-guard hole:
 * a tenant with egress:{} reached Loki, Prometheus, the HAMi scheduler, the
 * quota webhook, and the in-cluster registry (where it started an image push).
 */

abstract sig Namespace {}

abstract sig Platform extends Namespace {}
one sig Dns, S3 extends Platform {}     // coredns, s3-gateway: reachable from tenants BY DESIGN
sig OtherPlatform extends Platform {}   // kube-system internals, observability, registry, webhook, HAMi, ...

sig Tenant extends Namespace {}

sig Workload { ns: one Namespace }

// allow = any policy, including adversarial tenant-authored egress.
// deny  = the platform's Cilium deny rules (floor + guard). Deny wins.
one sig Net {
  allow: Workload -> Workload,
  deny:  Workload -> Workload
}

// A flow is permitted iff some policy allows it and no deny rule forbids it.
fun permitted : Workload -> Workload { Net.allow - Net.deny }

// Pods in the same namespace always have connectivity.
fact SameNamespaceAllowed {
  all s, d: Workload | s.ns = d.ns implies s->d in Net.allow
}

// The deny FLOOR: cross-tenant traffic is always denied (per-tenant *-floor CCNPs).
fact DenyFloor {
  all s, d: Workload |
    (s.ns in Tenant and d.ns in Tenant and s.ns != d.ns) implies s->d in Net.deny
}

// platform-guard: tenant -> platform is denied, EXCEPT Dns and S3.
pred PlatformGuard {
  all s, d: Workload |
    (s.ns in Tenant and d.ns in OtherPlatform) implies s->d in Net.deny
}

/* ---------------------------- properties ---------------------------- */

// Cross-tenant isolation: no permitted flow between two different tenants.
assert CrossTenantIsolation {
  no s, d: Workload |
    s->d in permitted and s.ns in Tenant and d.ns in Tenant and s.ns != d.ns
}

// Platform isolation UNDER the guard: no tenant reaches a non-exempt platform
// endpoint while platform-guard is in effect.
assert GuardEnforcesPlatformIsolation {
  PlatformGuard implies
    (no s, d: Workload | s->d in permitted and s.ns in Tenant and d.ns in OtherPlatform)
}

// The SAME property WITHOUT the guard -- expected to FAIL (the real hole).
assert NoTenantToForbiddenPlatform {
  no s, d: Workload | s->d in permitted and s.ns in Tenant and d.ns in OtherPlatform
}

// Sanity: the guard is not over-broad -- DNS and the S3 gateway stay reachable.
pred DnsAndS3ReachableUnderGuard {
  PlatformGuard
  some s: Workload, d: Workload |
    s.ns in Tenant and d.ns in (Dns + S3) and s->d in permitted
}

/* ---------------------------- commands ----------------------------- */

check CrossTenantIsolation for 6           // EXPECT: no counterexample (floor always on)
check GuardEnforcesPlatformIsolation for 6 // EXPECT: no counterexample (guard closes it)
check NoTenantToForbiddenPlatform for 6    // EXPECT: COUNTEREXAMPLE (the pre-guard hole)
run DnsAndS3ReachableUnderGuard for 6      // EXPECT: instance (carve-out still works)
