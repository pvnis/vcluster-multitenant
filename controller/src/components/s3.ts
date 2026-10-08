// The tenant's key on the shared S3 gateway.
//
// Keys live in Secret s3-gateway/s3-gateway-tenant-keys, one entry per tenant
// (value "<access>,<secret>"), mounted into the gateway, which turns each file
// into an --auth-key flag at startup (manifests/midori/s3-gateway.yaml). So a
// new tenant never edits the gateway's Deployment. A key change takes effect
// when the gateway restarts, which the controller triggers by writing a hash
// of all keys into a pod-template annotation it alone owns.

import { createHash } from 'node:crypto';
import type { V1Deployment, V1Secret } from '@kubernetes/client-node';
import type { Kube } from '../kube.ts';
import type { ComponentResult, Tenant } from '../types.ts';
import { ensureCredentials, readCredentials } from './credentials.ts';

const NS = 's3-gateway';
const KEYS = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 's3-gateway-tenant-keys', namespace: NS } };
const DEPLOY = { apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 's3-gateway', namespace: NS } };
const HASH_ANNOTATION = 'midori.phoenix/tenant-keys-hash';

export async function reconcileS3(kube: Kube, t: Tenant): Promise<ComponentResult> {
  const name = t.metadata!.name!;
  const keys = await kube.read<V1Secret>(KEYS);
  const liveEntry = keys?.data?.[name] ? Buffer.from(keys.data[name], 'base64').toString() : undefined;
  const object = `Secret/${NS}/s3-gateway-tenant-keys[${name}]`;

  if (!t.spec.s3.enabled) {
    if (t.spec.management === 'Manage' && liveEntry) await removeKey(kube, name);
    const drift = t.spec.management === 'Observe' && liveEntry ? [{ component: 'S3', object, change: 'delete' as const, paths: [] }] : [];
    return { drift, condition: { type: 'S3Ready', status: drift.length ? 'False' : 'True', reason: 'Disabled', message: 's3 disabled for this tenant' } };
  }

  if (t.spec.management === 'Observe') {
    const creds = await readCredentials(kube, name);
    const want = creds?.s3AccessKey && creds.s3SecretKey ? `${creds.s3AccessKey},${creds.s3SecretKey}` : undefined;
    const drift = [];
    if (!liveEntry) drift.push({ component: 'S3', object, change: 'create' as const, paths: [] });
    else if (want && want !== liveEntry) drift.push({ component: 'S3', object, change: 'update' as const, paths: ['value'] });
    if (!want) drift.push({ component: 'S3', object: `Secret/tenant-system/${name}-credentials`, change: 'create' as const, paths: [] });
    return { drift, condition: { type: 'S3Ready', status: drift.length ? 'False' : 'True', reason: drift.length ? 'Drift' : 'InSync', message: liveEntry ? 'key present on the gateway' : 'no key on the gateway' } };
  }

  const c = await ensureCredentials(kube, name);
  const entry = `${c.s3AccessKey},${c.s3SecretKey}`;
  if (entry !== liveEntry) {
    // Each tenant's entry under its OWN field manager: an apply declares all
    // of a manager's fields, so one shared manager would delete every other
    // tenant's key on each write.
    await kube.apply({ ...KEYS, type: 'Opaque', data: { [name]: Buffer.from(entry).toString('base64') } } as V1Secret,
      false, managerFor(name));
    await rollGateway(kube);
  }
  return { drift: [], condition: { type: 'S3Ready', status: 'True', reason: entry !== liveEntry ? 'KeyWritten' : 'InSync', message: 'key on the gateway' } };
}

const managerFor = (tenant: string) => `midori-tenant-controller/s3/${tenant}`;

export async function removeKey(kube: Kube, name: string): Promise<void> {
  const keys = await kube.read<V1Secret>(KEYS);
  if (!keys?.data?.[name]) return;
  // A JSON-patch remove is exact whoever owns the entry (adopted keys were
  // written by kubectl, not by this tenant's manager). "/" in a key would be
  // "~1"; tenant names cannot contain it.
  await kube.jsonPatchSecret(NS, KEYS.metadata.name, [{ op: 'remove', path: `/data/${name}` }]);
  await rollGateway(kube);
}

async function rollGateway(kube: Kube): Promise<void> {
  const keys = await kube.read<V1Secret>(KEYS);
  const h = createHash('sha256').update(JSON.stringify(Object.entries(keys?.data ?? {}).sort())).digest('hex').slice(0, 16);
  const d = await kube.read<V1Deployment>(DEPLOY);
  if (d?.spec?.template.metadata?.annotations?.[HASH_ANNOTATION] === h) return;
  await kube.apply({
    ...DEPLOY,
    spec: { template: { metadata: { annotations: { [HASH_ANNOTATION]: h } } } },
  } as unknown as V1Deployment, false, 'midori-tenant-controller/s3-gateway-roll');
}
