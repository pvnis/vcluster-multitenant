// Give a tenant's public LoadBalancer Services a fabric VIP.
//
// A Service labelled midori.phoenix/lb-pool=public draws a VIP from the public
// /26 LB-IPAM pool (manifests/midori/cilium-bgp.yaml) and Cilium advertises it
// over BGP -- the fabric replacement for an OpenStack floating IP. We stamp the
// label HOST-SIDE with the plain Kubernetes API, on purpose: the vCluster patch
// that could do it (sync.toHost.services.patches) is a vCluster Pro feature and
// crashes the open-source syncer. This component never touches vCluster values,
// so it cannot restart or crash a tenant's control plane.
//
// Gated to the operator's grant (loadBalancers.public with a non-zero count).
// The host admission guard (load-balancer-guard.yaml) independently denies the
// label to un-granted tenants, so the two agree and a tenant cannot self-serve.
//
// Latency: a newly-created LoadBalancer Service is labelled on the next reconcile
// of its Tenant (a spec change or the periodic resync), not instantly. A Service
// informer would make it immediate; left for later.

import type { Kube } from '../kube.ts';
import type { ComponentResult, Drift, Management, Tenant } from '../types.ts';

const LABEL = 'midori.phoenix/lb-pool';
const POOL = 'public';
// JSON Pointer to the label key (RFC 6901: '/' -> '~1', '~' -> '~0').
const POINTER = `/metadata/labels/${LABEL.replace(/~/g, '~0').replace(/\//g, '~1')}`;
const MANAGER = 'midori-controller-lb';

interface Svc {
  metadata?: { name?: string; labels?: Record<string, string> };
  spec?: { type?: string };
}

// Pure: which LoadBalancer Services need the pool label added or removed, given
// whether the tenant is granted public load balancers. No I/O, so it is unit-
// testable without a cluster.
export function lbPoolActions(services: Svc[], granted: boolean): { add: string[]; remove: string[] } {
  const add: string[] = [];
  const remove: string[] = [];
  for (const s of services) {
    if (s.spec?.type !== 'LoadBalancer' || !s.metadata?.name) continue;
    const has = s.metadata.labels?.[LABEL] === POOL;
    if (granted && !has) add.push(s.metadata.name);
    else if (!granted && has) remove.push(s.metadata.name);
  }
  return { add, remove };
}

export async function reconcileLoadBalancers(kube: Kube, t: Tenant, mode: Management): Promise<ComponentResult> {
  const ns = t.metadata!.name!;
  // api.expose also entitles the tenant to a public VIP (its API service), so
  // it counts as granted even without a loadBalancers.public grant -- otherwise
  // this would strip the label off the API service and drop its VIP.
  const granted = (t.spec.loadBalancers.count > 0 && t.spec.loadBalancers.public) || t.spec.api.expose;
  const list = await kube.getPath<{ items?: Svc[] }>(`/api/v1/namespaces/${ns}/services`);
  const { add, remove } = lbPoolActions(list.items ?? [], granted);

  const drift: Drift[] = [];
  for (const name of add) {
    drift.push({ component: 'LoadBalancers', object: `Service/${ns}/${name}`, change: 'update', paths: [`metadata.labels.${LABEL}`] });
    if (mode === 'Manage') {
      // Server-side apply of only the label, under our own field manager, so we
      // own that one field and leave everything the syncer owns untouched.
      await kube.apply({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace: ns, labels: { [LABEL]: POOL } } }, false, MANAGER);
    }
  }
  for (const name of remove) {
    drift.push({ component: 'LoadBalancers', object: `Service/${ns}/${name}`, change: 'update', paths: [`-metadata.labels.${LABEL}`] });
    if (mode === 'Manage') {
      await kube.jsonPatchService(ns, name, [{ op: 'remove', path: POINTER }]);
    }
  }

  return {
    drift,
    condition: {
      type: 'LoadBalancersReady',
      status: mode === 'Manage' || drift.length === 0 ? 'True' : 'False',
      reason: mode === 'Manage' ? 'Applied' : drift.length === 0 ? 'InSync' : 'Drift',
      message: granted
        ? `public pool: ${add.length} labelled, ${remove.length} cleared`
        : `not public: ${remove.length} label(s) cleared`,
    },
  };
}
