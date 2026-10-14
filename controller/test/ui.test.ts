import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Invalid, capacity, carryOver, newTenant, parseSpec, specPatch, toNumber } from '../src/ui/model.ts';
import { hashPassword, verifyPassword } from '../src/ui/auth.ts';

test('parseSpec: minimal form -> defaults, Manage', () => {
  const s = parseSpec({ quota: { gpus: '2', gpuMemoryMiB: '92136' } });
  assert.equal(s.management, 'Manage');
  assert.deepEqual(s.quota, { gpus: 2, gpuMemoryMiB: 92136 });
  assert.equal(s.network.internet, false);
  assert.deepEqual(s.observability.dashboards, ['overview']);
});

test('parseSpec: optional quota lines kept only when given', () => {
  const s = parseSpec({ quota: { gpus: 4, gpuMemoryMiB: 184272, cpu: { requests: '20', limits: '' }, memory: { limits: '160Gi' } } });
  assert.deepEqual(s.quota.cpu, { requests: '20' });
  assert.deepEqual(s.quota.memory, { limits: '160Gi' });
});

test('parseSpec: refuses bad input with a readable message', () => {
  assert.throws(() => parseSpec({ quota: { gpus: 41, gpuMemoryMiB: 1 } }), /GPU attachments: a whole number from 0 to 40/);
  assert.equal(parseSpec({ quota: { gpus: 12, gpuMemoryMiB: 1 } }).quota.gpus, 12);
  assert.throws(() => parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1, gpuCores: 401 } }), /GPU time/);
  assert.equal(parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1, gpuCores: '150' } }).quota.gpuCores, 150);
  assert.throws(() => parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1, memory: { requests: '96GB' } } }), /Memory requests/);
  assert.throws(() => parseSpec({ quota: { gpus: 1.5, gpuMemoryMiB: 1 } }), Invalid);
  assert.throws(() => parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 999999 } }), /GPU memory/);
});

test('newTenant: name rules', () => {
  const spec = parseSpec({ quota: { gpus: 0, gpuMemoryMiB: 0 } });
  assert.equal(newTenant('tenant-ok-1', spec).metadata?.name, 'tenant-ok-1');
  for (const bad of ['ok', 'tenant-', 'tenant-UP', 'tenant-a_b', 'tenant-' + 'x'.repeat(26), 'tenant-a-']) {
    assert.throws(() => newTenant(bad, spec), Invalid, bad);
  }
});

test('specPatch: cleared optional fields become null (removed)', () => {
  const p = specPatch(parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1 } })) as any;
  assert.equal(p.spec.quota.cpu, null);
  assert.equal(p.spec.quota.gpuCores, null);
  assert.equal(p.spec.quota.memory, null);
  assert.equal(p.spec.quota.pods, null);
  assert.equal(p.spec.controlPlane.apiNodePort, null);
});

test('toNumber: Kubernetes quantities', () => {
  assert.equal(toNumber('500m'), 0.5);
  assert.equal(toNumber('96Gi'), 96 * 1024 ** 3);
  assert.equal(toNumber('20k'), 20000);
  assert.equal(toNumber('65843276Ki'), 65843276 * 1024);
});

test('capacity: physical GPUs from HAMi, overcommit ratio', () => {
  const dev = { devmem: 46068, count: 10 };
  const node = (name: string) => ({
    metadata: { name, labels: { 'gpu.vendor': 'nvidia' }, annotations: { 'hami.io/node-nvidia-register': JSON.stringify([dev, dev]) } },
    status: { allocatable: { cpu: '16', memory: '64Gi', 'nvidia.com/gpu': '20' } },
  });
  const cp = { metadata: { name: 'cp', labels: {} }, status: { allocatable: { cpu: '2', memory: '3Gi' } } };
  const rq = (ns: string, gpu: string, used: string) => ({ metadata: { namespace: ns, name: 'tenant-quota' },
    spec: { hard: { 'requests.nvidia.com/gpu': gpu, 'requests.cpu': '12' } }, status: { used: { 'requests.nvidia.com/gpu': used } } });
  const tenants = [{ metadata: { name: 'tenant-a' } }, { metadata: { name: 'tenant-b' } }] as any;
  const c = capacity([node('a'), node('b'), cp], [rq('tenant-a', '4', '2'), rq('tenant-b', '2', '0'), rq('other', '9', '9')], tenants);
  assert.equal(c.cards, 4);
  assert.deepEqual(c.gpus, { capacity: 40, quota: 6, used: 2, overcommit: 0.15 });
  assert.equal(c.gpuCores.capacity, 400);
  assert.equal(c.gpuMemoryMiB.capacity, 4 * 46068);
  assert.equal(c.cpu.capacity, 32);
  assert.equal(c.cpu.quota, 24);
});

test('passwords: scrypt round trip, wrong password, malformed hash', async () => {
  const h = await hashPassword('correct horse battery'); // the real default cost
  assert.equal(await verifyPassword('correct horse battery', h), true);
  assert.equal(await verifyPassword('wrong', h), false);
  assert.equal(await verifyPassword('x', 'plaintext'), false);
});

test('carryOver: an edit keeps the pinned API NodePort the form does not show', () => {
  const edited = carryOver({ controlPlane: { size: 'small', apiNodePort: 31943 } } as any, parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1 } }));
  assert.equal(edited.controlPlane.apiNodePort, 31943);
  assert.equal((specPatch(edited) as any).spec.controlPlane.apiNodePort, 31943);
  assert.equal(carryOver(undefined, parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1 } })).controlPlane.apiNodePort, undefined);
});


test('GPU memory held: the UI and the admin Grafana panel use the same query', async () => {
  const { HELD_BY_TENANT } = await import('../src/ui/promql.ts');
  const { readFileSync } = await import('node:fs');
  const dash = JSON.parse(readFileSync('../manifests/midori/observability/dashboards/admin-midori.json', 'utf8'));
  const panel = dash.panels.find((p: any) => p.title === 'GPU memory held, by tenant');
  assert.equal(panel.targets[0].expr, HELD_BY_TENANT);
});

test('a UI edit keeps model sharing, which the form does not show', () => {
  const edited = carryOver(
    { modelProvider: { enabled: true }, modelProviders: ['tenant-ps'] } as never,
    parseSpec({ quota: { gpus: 1, gpuMemoryMiB: 1000 } }),
  );
  assert.deepEqual(edited.modelProvider, { enabled: true });
  assert.deepEqual(edited.modelProviders, ['tenant-ps']);
});
