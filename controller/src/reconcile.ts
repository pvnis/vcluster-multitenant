// One reconcile of one Tenant: every component in order, each failing on its
// own, then a single status write.

import type { KubernetesObject } from '@kubernetes/client-node';
import type { Kube } from './kube.ts';
import type { Templates } from './templates.ts';
import { reconcileObjects } from './components/objects.ts';
import { deleteVCluster, reconcileVCluster } from './components/vcluster.ts';
import { reconcileS3, removeKey } from './components/s3.ts';
import { deleteGrafana, reconcileGrafana } from './components/grafana.ts';
import { deleteCredentials } from './components/credentials.ts';
import {
  ALLOW_DELETE, FINALIZER, withDefaults,
  type ComponentResult, type Condition, type Tenant, type TenantStatus,
} from './types.ts';

const log = (tenant: string, msg: string) => console.log(JSON.stringify({ ts: new Date().toISOString(), tenant, msg }));

export async function reconcileTenant(kube: Kube, templates: Templates, raw: Tenant): Promise<void> {
  const t = withDefaults(raw);
  const name = t.metadata!.name!;
  const mode = t.spec.management;

  if (t.metadata?.deletionTimestamp) return handleDeletion(kube, templates, t);
  if (mode === 'Manage' && !(t.metadata?.finalizers ?? []).includes(FINALIZER)) {
    await kube.patchTenant(name, { metadata: { finalizers: [...(t.metadata?.finalizers ?? []), FINALIZER] } });
  }

  const r = templates.render(t);
  const steps: Array<[string, () => Promise<ComponentResult>]> = [
    // Order matters in Manage: the namespace before anything in it.
    ['Namespace', () => reconcileObjects(kube, 'Namespace', r.present.Namespace, [], mode)],
    ['Quota', () => reconcileObjects(kube, 'Quota', r.present.Quota, [], mode)],
    ['Network', () => reconcileObjects(kube, 'Network', r.present.Network, r.absent.Network ?? [], mode)],
    ['VCluster', () => reconcileVCluster(kube, templates, t)],
    ['S3', () => reconcileS3(kube, t)],
    ['Metrics', () => reconcileObjects(kube, 'Metrics', r.present.Metrics, [], mode)],
    ['Grafana', () => reconcileGrafana(kube, templates, t)],
  ];

  const conditions: Condition[] = [];
  const status: TenantStatus = { drift: [] };
  for (const [component, step] of steps) {
    try {
      const res = await step();
      conditions.push(res.condition);
      status.drift!.push(...res.drift);
      Object.assign(status, res.status ?? {});
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log(name, `${component}: ${message}`);
      conditions.push({ type: `${component}Ready`, status: 'False', reason: 'Error', message: message.slice(0, 500) });
    }
  }

  const now = new Date().toISOString();
  const previous = new Map((t.status?.conditions ?? []).map((c) => [c.type, c]));
  for (const c of conditions) {
    const p = previous.get(c.type);
    c.lastTransitionTime = p && p.status === c.status ? p.lastTransitionTime : now;
  }
  const failed = conditions.some((c) => c.reason === 'Error');
  // Several components may report the same object (the credentials Secret
  // serves both S3 and Grafana); list it once.
  const seen = new Set<string>();
  status.drift = status.drift!.filter((d) => {
    const k = `${d.change}|${d.object}`;
    return seen.has(k) ? false : (seen.add(k), true);
  });
  status.conditions = conditions;
  status.driftCount = status.drift!.length;
  status.observedGeneration = t.metadata?.generation;
  status.phase = mode === 'Observe' ? (failed ? 'Degraded' : 'Observing') : failed ? 'Degraded' : 'Ready';
  await kube.patchTenantStatus(name, status);
  log(name, `${mode}: phase=${status.phase} drift=${status.driftCount}`);
}

async function handleDeletion(kube: Kube, templates: Templates, t: Tenant): Promise<void> {
  const name = t.metadata!.name!;
  const finalizers = t.metadata?.finalizers ?? [];
  if (!finalizers.includes(FINALIZER)) return;
  const release = async () =>
    kube.patchTenant(name, { metadata: { finalizers: finalizers.filter((f) => f !== FINALIZER) } });

  // Observe never changed anything, so deleting the Tenant only stops
  // management; the tenant itself is left exactly as it is.
  if (t.spec.management !== 'Manage') {
    log(name, 'deleted in Observe: releasing, tenant left untouched');
    return release();
  }
  if (t.metadata?.annotations?.[ALLOW_DELETE] !== 'true') {
    await kube.patchTenantStatus(name, {
      phase: 'Blocked',
      conditions: [{
        type: 'Deleting', status: 'False', reason: 'NotAllowed', lastTransitionTime: new Date().toISOString(),
        message: `deleting destroys the tenant's control plane and data; annotate ${ALLOW_DELETE}="true" to proceed, or set management: Observe to stop managing it instead`,
      }],
    });
    log(name, 'deletion blocked: no allow-delete annotation');
    return;
  }

  log(name, 'tearing down');
  await kube.patchTenantStatus(name, { phase: 'Deleting' });
  const r = templates.render(t);
  // Reverse of creation. Each step tolerates "already gone", so a teardown
  // interrupted halfway resumes on the next reconcile.
  await deleteGrafana(kube, name);
  await removeKey(kube, name);
  for (const o of r.present.Metrics) await kube.delete(o);
  await deleteVCluster(name);
  const clusterScoped = (o: KubernetesObject) => !o.metadata?.namespace;
  for (const o of [...r.present.Network, ...(r.absent.Network ?? [])]) if (clusterScoped(o)) await kube.delete(o);
  // The internet floor and the standard floor share names; both are covered
  // by the render above. The namespace takes every namespaced object with it.
  await kube.delete(r.present.Namespace[0]);
  for (let i = 0; i < 120 && (await kube.read(r.present.Namespace[0])); i++) await new Promise((s) => setTimeout(s, 5000));
  if (await kube.read(r.present.Namespace[0])) throw new Error(`namespace ${name} still terminating after 10 minutes`);
  await deleteCredentials(kube, name);
  log(name, 'teardown complete');
  await release();
}
