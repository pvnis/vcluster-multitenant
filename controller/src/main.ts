// The tenant controller: watches Tenants, reconciles each on change and every
// RESYNC_SECONDS (drift from outside the controller shows up then), one at a
// time. A single replica; there is no leader election, so never run two.

import { makeInformer, type KubernetesObject } from '@kubernetes/client-node';
import { Kube } from './kube.ts';
import { Templates } from './templates.ts';
import { reconcileTenant } from './reconcile.ts';
import { reconcileAdminLoki } from './components/grafana.ts';
import { WorkQueue } from './workqueue.ts';
import { GROUP, PLURAL, VERSION, type Tenant } from './types.ts';

const RESYNC_SECONDS = Number(process.env.RESYNC_SECONDS ?? 300);
const TEMPLATE_DIR = process.env.TEMPLATE_DIR ?? '/templates';
// --once: reconcile every Tenant once, in its own mode, and exit.
// --observe: the same, but every Tenant treated as Observe and nothing
//   written at all (not even status) -- a safe dry run against the cluster.
const READ_ONLY = process.argv.includes('--observe');
const ONCE = READ_ONLY || process.argv.includes('--once');

const kube = Kube.load();
const templates = new Templates(TEMPLATE_DIR);
const log = (msg: string, extra: object = {}) => console.log(JSON.stringify({ ts: new Date().toISOString(), msg, ...extra }));

async function get(name: string): Promise<Tenant | undefined> {
  return (await kube.read<Tenant>({ apiVersion: `${GROUP}/${VERSION}`, kind: 'Tenant', metadata: { name } }));
}

async function work(name: string): Promise<void> {
  try {
    const t = await get(name); // always the latest, never a stale event copy
    if (t) await reconcileTenant(kube, templates, t, READ_ONLY);
  } catch (e) {
    log('reconcile failed', { tenant: name, error: e instanceof Error ? e.message : String(e) });
  }
}

// State that spans all Tenants.
async function globals(): Promise<void> {
  try {
    const all = (await kube.listTenants()) as Tenant[];
    // Observe means no writes at all: shared state is first written only once
    // some Tenant is under management. But once it exists it is ours to keep
    // current -- otherwise deleting the last managed Tenant would leave that
    // tenant listed forever (seen: tenant-e2e stayed in the admin Loki header).
    const exists = await kube.read({ apiVersion: 'v1', kind: 'Secret',
      metadata: { name: 'grafana-datasource-loki-admin', namespace: 'observability' } });
    if (!exists && !all.some((t) => t.spec?.management === 'Manage')) return;
    await reconcileAdminLoki(kube, all.map((t) => t.metadata!.name!).filter(Boolean));
  } catch (e) {
    log('global reconcile failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

const queue = new WorkQueue(work, async () => { if (!READ_ONLY) await globals(); });

async function enqueueAll(): Promise<void> {
  await queue.add(...(await kube.listTenants()).map((t) => t.metadata!.name!));
}

async function main(): Promise<void> {
  log('starting', { resyncSeconds: RESYNC_SECONDS, templates: TEMPLATE_DIR, once: ONCE, readOnly: READ_ONLY });
  if (ONCE) {
    await enqueueAll();
    return;
  }
  const path = `/apis/${GROUP}/${VERSION}/${PLURAL}`;
  const informer = makeInformer<KubernetesObject>(kube.kc, path, async () =>
    ({ apiVersion: `${GROUP}/${VERSION}`, kind: 'TenantList', metadata: {}, items: await kube.listTenants() }) as never);
  const onChange = (obj: KubernetesObject) => {
    const t = obj as Tenant;
    // Status writes come back as updates; only spec changes (generation),
    // deletion and never-reconciled objects need work now. Everything else
    // waits for the resync.
    const fresh = t.metadata?.generation !== t.status?.observedGeneration;
    if (fresh || t.metadata?.deletionTimestamp) {
      void queue.add(t.metadata!.name!);
    }
  };
  informer.on('add', onChange);
  informer.on('update', onChange);
  informer.on('delete', () => void globals());
  informer.on('error', (err) => {
    log('watch error, restarting in 5s', { error: String(err) });
    setTimeout(() => void informer.start(), 5000);
  });
  await informer.start();
  setInterval(() => void enqueueAll(), RESYNC_SECONDS * 1000);
  await enqueueAll();
}

main().catch((e) => {
  log('fatal', { error: e instanceof Error ? e.stack : String(e) });
  process.exit(1);
});
