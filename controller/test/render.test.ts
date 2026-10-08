// Rendering tests against the repo's real manifests (npm pretest exports them
// to test/.templates) and the live tenants' Helm values (test/fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Templates } from '../src/templates.ts';
import { withDefaults, type Tenant } from '../src/types.ts';
import { diffPaths, deepMerge } from '../src/diff.ts';

const T = new Templates('test/.templates');

function tenant(name: string, spec: Record<string, unknown>): Tenant {
  return withDefaults({ apiVersion: 'midori.phoenix/v1alpha1', kind: 'Tenant', metadata: { name }, spec } as unknown as Tenant);
}

const names = (objs: { kind?: string; metadata?: { name?: string; namespace?: string } }[]) =>
  objs.map((o) => `${o.kind}/${o.metadata?.namespace ?? ''}/${o.metadata?.name}`).sort();

test('no placeholder survives rendering', () => {
  const r = T.render(tenant('tenant-x', { quota: { gpus: 2, gpuMemoryMiB: 92136 }, gateway: { expose: true } }));
  const text = JSON.stringify(r);
  for (const p of ['TENANT', 'NAMESPACE', 'GPUMEM', '"GPUS"']) assert.ok(!text.includes(p), `left over: ${p}`);
});

test('standard tenant: the runbook objects, internet allow absent', () => {
  const r = T.render(tenant('tenant-nv-a', { quota: { gpus: 4, gpuMemoryMiB: 4096 } }));
  assert.deepEqual(names(r.present.Network), [
    'CiliumClusterwideNetworkPolicy//tenant-nv-a-floor',
    'CiliumClusterwideNetworkPolicy//tenant-nv-a-floor-workloads',
    'CiliumNetworkPolicy/tenant-nv-a/allow-control-plane-access',
    'CiliumNetworkPolicy/tenant-nv-a/allow-prometheus-scrape',
    'CiliumNetworkPolicy/tenant-nv-a/tenant-baseline-allow',
    'CiliumNetworkPolicy/tenant-nv-a/tenant-s3-gateway',
    'NetworkPolicy/tenant-nv-a/allow-same-tenant',
    'NetworkPolicy/tenant-nv-a/default-deny-ingress',
  ]);
  assert.deepEqual(names(r.absent.Network), [
    'CiliumNetworkPolicy/tenant-nv-a/allow-gateway-ingress',
    'CiliumNetworkPolicy/tenant-nv-a/tenant-internet',
  ]);
  const quota = r.present.Quota.find((o) => o.kind === 'ResourceQuota') as any;
  assert.equal(quota.spec.hard['requests.nvidia.com/gpu'], '4');
  assert.equal(quota.spec.hard['requests.nvidia.com/gpumem'], '4096');
});

test('internet tenant: internet floor, its allow present, no denial of 0.0.0.0/0', () => {
  const r = T.render(tenant('tenant-y', { quota: { gpus: 4, gpuMemoryMiB: 184272 }, network: { internet: true } }));
  const floor = r.present.Network.find((o) => o.metadata?.name === 'tenant-y-floor-workloads') as any;
  const cidrs = floor.spec.egressDeny.flatMap((d: any) => (d.toCIDRSet ?? []).map((c: any) => c.cidr));
  assert.ok(!cidrs.includes('0.0.0.0/0'));
  assert.ok(cidrs.includes('169.254.0.0/16'));
  assert.ok(floor.spec.egressDeny.some((d: any) => d.toEntities?.includes('kube-apiserver')));
  assert.ok(r.present.Network.some((o) => o.metadata?.name === 'tenant-internet'));
  assert.ok(!r.absent.Network.some((o) => o.metadata?.name === 'tenant-internet'));
});

test('the standard floor denies node identities (the pending fix)', () => {
  const r = T.render(tenant('tenant-z', { quota: { gpus: 1, gpuMemoryMiB: 1 } }));
  for (const n of ['tenant-z-floor', 'tenant-z-floor-workloads']) {
    const f = r.present.Network.find((o) => o.metadata?.name === n) as any;
    assert.ok(f.spec.egressDeny.some((d: any) => d.toEntities?.includes('remote-node')), n);
  }
});

// The vCluster values must equal what `vcluster create` stored for the live
// tenants (minus vclusterctl's own telemetry block), or adoption would
// upgrade -- and restart -- their control planes.
for (const [name, port, size] of [
  ['tenant-nv-a', 31943, 'small'],
  ['tenant-nv-b', 32043, 'small'],
  ['tenant-phoenix-serving', 32243, 'large'],
] as const) {
  test(`vCluster values match the live release: ${name}`, () => {
    const live = JSON.parse(readFileSync(`test/fixtures/helm-values-${name}.json`, 'utf8'));
    delete live.telemetry;
    const want = T.vclusterValues(tenant(name, { quota: { gpus: 0, gpuMemoryMiB: 0 }, controlPlane: { size } }), port);
    assert.deepEqual(diffPaths(live, want), []);
  });
}

test('deepMerge: maps merge, lists replace', () => {
  assert.deepEqual(deepMerge({ a: { b: 1, l: [1, 2] } }, { a: { c: 2, l: [3] } }), { a: { b: 1, c: 2, l: [3] } });
});

test('dashboards load', () => {
  assert.equal(T.dashboard('overview').uid, 'tenant-overview');
  assert.equal(T.dashboard('serving').uid, 'tenant-serving');
});
