// Rendering tests against the repo's real manifests (npm pretest exports them
// to test/.templates) and the live tenants' Helm values (test/fixtures).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Templates } from '../src/templates.ts';
import { withDefaults, type Tenant } from '../src/types.ts';
import { diffPaths, deepMerge } from '../src/diff.ts';
import { lbPoolActions } from '../src/components/loadbalancers.ts';

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
    'CiliumNetworkPolicy/tenant-nv-a/tenant-sandbox',
    'NetworkPolicy/tenant-nv-a/allow-same-tenant',
    'NetworkPolicy/tenant-nv-a/default-deny-ingress',
  ]);
  assert.deepEqual(names(r.absent.Network), [
    'CiliumNetworkPolicy/tenant-nv-a/allow-gateway-ingress',
    'CiliumNetworkPolicy/tenant-nv-a/tenant-internet',
  ]);
  const quota = r.present.Quota.find((o) => o.kind === 'ResourceQuota') as any;
  assert.equal(quota.spec.hard['requests.nvidia.com/gpu'], '4');
  assert.equal(quota.spec.hard['requests.midori.phoenix/gpu-memory'], '4096');
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

test('quota: set lines override the template, unset lines keep it', () => {
  const base = T.render(tenant('tenant-q', { quota: { gpus: 4, gpuMemoryMiB: 184272 } }));
  const hardOf = (r: ReturnType<typeof T.render>) => (r.present.Quota.find((o) => o.kind === 'ResourceQuota') as any).spec.hard;
  const b = hardOf(base);
  const r = T.render(tenant('tenant-q', { quota: { gpus: 4, gpuMemoryMiB: 184272,
    cpu: { requests: '20', limits: '36' }, memory: { requests: '96Gi', limits: '160Gi' } } }));
  const h = hardOf(r);
  assert.deepEqual([h['requests.cpu'], h['limits.cpu'], h['requests.memory'], h['limits.memory']], ['20', '36', '96Gi', '160Gi']);
  // everything else untouched
  for (const k of ['pods', 'persistentvolumeclaims', 'requests.nvidia.com/gpu', 'requests.midori.phoenix/gpu-memory']) assert.equal(h[k], b[k], k);
  assert.deepEqual([b['requests.cpu'], b['limits.cpu'], b['requests.memory'], b['limits.memory']], ['12', '24', '48Gi', '80Gi']);
});

test('quota: gpuCores becomes requests.nvidia.com/gpucores, absent when unset', () => {
  const hardOf = (spec: Record<string, unknown>) => (T.render(tenant('tenant-q', spec)).present.Quota.find((o) => o.kind === 'ResourceQuota') as any).spec.hard;
  assert.equal(hardOf({ quota: { gpus: 10, gpuMemoryMiB: 46068, gpuCores: 150 } })['requests.nvidia.com/gpucores'], '150');
  assert.equal(hardOf({ quota: { gpus: 10, gpuMemoryMiB: 46068, gpuCores: 150 } })['requests.nvidia.com/gpu'], '10');
  assert.ok(!('requests.nvidia.com/gpucores' in hardOf({ quota: { gpus: 1, gpuMemoryMiB: 1 } })));
});

test('quota: amdGpuVramMiB becomes requests.amd.com/gpu-vram-mib in 512-MiB units, absent when unset', () => {
  const hardOf = (spec: Record<string, unknown>) => (T.render(tenant('tenant-q', spec)).present.Quota.find((o) => o.kind === 'ResourceQuota') as any).spec.hard;
  // 2048 MiB / 512 = 4 units
  assert.equal(hardOf({ quota: { gpus: 0, gpuMemoryMiB: 0, amdGpuVramMiB: 2048 } })['requests.amd.com/gpu-vram-mib'], '4');
  // floored to whole units: 1500 MiB -> 2 units
  assert.equal(hardOf({ quota: { gpus: 0, gpuMemoryMiB: 0, amdGpuVramMiB: 1500 } })['requests.amd.com/gpu-vram-mib'], '2');
  assert.ok(!('requests.amd.com/gpu-vram-mib' in hardOf({ quota: { gpus: 1, gpuMemoryMiB: 1 } })));
});


test('model provider: the broker and its Gateway allow; disabled leaves the shared namespace', () => {
  const on = T.render(tenant('tenant-ps', { modelProvider: { enabled: true } }));
  assert.deepEqual(names(on.present.Models), [
    'CiliumNetworkPolicy/model-providers/tenant-ps',
    'CiliumNetworkPolicy/tenant-ps/allow-model-broker',
    'ConfigMap/model-providers/tenant-ps',
    'Deployment/model-providers/tenant-ps',
    'Namespace//model-providers',
    'Service/model-providers/tenant-ps',
    'Service/tenant-ps/model-gateway',
  ]);
  const text = JSON.stringify(on.present.Models);
  assert.ok(!text.includes('PROVIDER') && !text.includes('CONSUMER'), 'placeholder left over');
  assert.ok(text.includes('model-gateway.tenant-ps.svc.cluster.local:8080'));
  const off = T.render(tenant('tenant-ps', {}));
  assert.deepEqual(off.present.Models, []);
  assert.equal(off.absent.Models.length, 6);
  assert.ok(!off.absent.Models.some((o) => o.kind === 'Namespace'), 'must not delete the shared namespace');
});

test('model consumer: its allow and the broker-side allow; dropped providers absent; never itself', () => {
  const r = T.render(tenant('tenant-c', { modelProviders: ['tenant-ps', 'tenant-c'] }), ['tenant-ps', 'tenant-old']);
  assert.deepEqual(names(r.present.Models), [
    'CiliumNetworkPolicy/model-providers/tenant-c--tenant-ps',
    'CiliumNetworkPolicy/tenant-c/model-provider-tenant-ps',
  ]);
  // (Not a provider, so its own broker objects are absent too.)
  const consumerSide = r.absent.Models.filter((o) => o.metadata?.labels?.['midori.phoenix/consumer']);
  assert.deepEqual(names(consumerSide), [
    'CiliumNetworkPolicy/model-providers/tenant-c--tenant-old',
    'CiliumNetworkPolicy/tenant-c/model-provider-tenant-old',
  ]);
  // The broker admits only this consumer's synced workloads.
  const broker = r.present.Models.find((o) => o.metadata?.namespace === 'model-providers') as any;
  assert.deepEqual(broker.spec.ingress[0].fromEndpoints[0].matchLabels, {
    'k8s:io.kubernetes.pod.namespace': 'tenant-c', 'vcluster.loft.sh/managed-by': 'tenant-c',
  });
});

test('model consumer: the broker Service is replicated in beside the S3 gateway', () => {
  const values = T.vclusterValues(tenant('tenant-c', { modelProviders: ['tenant-ps'] }), 31000) as any;
  assert.deepEqual(values.networking.replicateServices.fromHost, [
    { from: 's3-gateway/s3-gateway', to: 's3-gateway/s3-gateway' },
    { from: 'model-providers/tenant-ps', to: 'model-providers/tenant-ps' },
  ]);
  const plain = T.vclusterValues(tenant('tenant-x', {}), 31000) as any;
  assert.deepEqual(plain.networking.replicateServices.fromHost, [{ from: 's3-gateway/s3-gateway', to: 's3-gateway/s3-gateway' }]);
});

test('gpuVendor scopes node sync: nvidia by default, amd when set', () => {
  const nv = T.vclusterValues(tenant('tenant-x', {}), 31000) as any;
  assert.deepEqual(nv.sync.fromHost.nodes, { enabled: true, selector: { labels: { 'gpu.vendor': 'nvidia' } } });
  const amd = T.vclusterValues(tenant('tenant-amd', { gpuVendor: 'amd' }), 31000) as any;
  assert.deepEqual(amd.sync.fromHost.nodes, { enabled: true, selector: { labels: { 'gpu.vendor': 'amd' } } });
});

test('sandboxes: every per-tenant allow excludes them; their own policy is default-deny both ways', () => {
  const r = T.render(tenant('tenant-x', { network: { internet: true }, modelProviders: ['tenant-ps'] }));
  const allows = [...r.present.Network, ...r.present.Models].filter((o: any) =>
    o.kind === 'CiliumNetworkPolicy' && o.metadata.namespace === 'tenant-x' && (o.spec.egress || o.spec.ingress) &&
    o.spec.endpointSelector?.matchLabels?.['vcluster.loft.sh/managed-by'] === 'tenant-x' &&
    !o.spec.endpointSelector?.matchLabels?.['midori.phoenix/network']) as any[];
  // Allows aimed at specific pods by the tenant's own labels (the Gateway's
  // ingress, the Prometheus scrape) are not grants to every pod.
  const grants = allows.filter((o) => o.spec.egress);
  assert.deepEqual(grants.map((o) => o.metadata.name).sort(),
    ['model-provider-tenant-ps', 'tenant-baseline-allow', 'tenant-internet', 'tenant-s3-gateway']);
  for (const o of grants) {
    assert.ok(o.spec.endpointSelector.matchExpressions?.some((e: any) =>
      e.key === 'midori.phoenix/network' && e.operator === 'NotIn' && e.values.includes('sandbox')), o.metadata.name);
  }
  const sameTenant = r.present.Network.find((o) => o.metadata?.name === 'allow-same-tenant') as any;
  assert.deepEqual(sameTenant.spec.podSelector.matchExpressions,
    [{ key: 'midori.phoenix/network', operator: 'NotIn', values: ['sandbox'] }]);
  const sandbox = r.present.Network.find((o) => o.metadata?.name === 'tenant-sandbox') as any;
  assert.deepEqual(sandbox.spec.enableDefaultDeny, { ingress: true, egress: true });
  assert.deepEqual(sandbox.spec.ingress, [{ fromEntities: ['host'] }]);
  assert.equal(sandbox.spec.egress, undefined);
});

test('load balancers: none by default; count becomes the quota, public the namespace label', () => {
  const none = T.render(tenant('tenant-x', {}));
  const hard = (r: any) => (r.present.Quota.find((o: any) => o.kind === 'ResourceQuota') as any).spec.hard;
  const label = (r: any) => (r.present.Namespace[0].metadata as any).labels['midori.phoenix/load-balancers'];
  assert.equal(hard(none)['services.loadbalancers'], '0');
  assert.equal(label(none), 'none');
  const internal = T.render(tenant('tenant-x', { loadBalancers: { count: 2 } }));
  assert.equal(hard(internal)['services.loadbalancers'], '2');
  assert.equal(label(internal), 'internal');
  const pub = T.render(tenant('tenant-x', { loadBalancers: { count: 1, public: true } }));
  assert.equal(label(pub), 'public');
  // public without any count grants nothing
  assert.equal(label(T.render(tenant('tenant-x', { loadBalancers: { count: 0, public: true } }))), 'none');
});

test('lbPoolActions: label LoadBalancer services when granted, clear when not, ignore ClusterIP', () => {
  const svcs = [
    { metadata: { name: 'lb1', labels: {} }, spec: { type: 'LoadBalancer' } },
    { metadata: { name: 'lb2', labels: { 'midori.phoenix/lb-pool': 'public' } }, spec: { type: 'LoadBalancer' } },
    { metadata: { name: 'cip', labels: {} }, spec: { type: 'ClusterIP' } },
  ];
  // granted: label the unlabelled LB (lb1); lb2 already set; cip ignored
  assert.deepEqual(lbPoolActions(svcs, true), { add: ['lb1'], remove: [] });
  // not granted: clear the labelled LB (lb2); lb1 and cip untouched
  assert.deepEqual(lbPoolActions(svcs, false), { add: [], remove: ['lb2'] });
  assert.deepEqual(lbPoolActions([], true), { add: [], remove: [] });
});

test('api.expose: vcluster API becomes an allowlisted LoadBalancer VIP + cert SAN; namespace public, quota +1', () => {
  const spec = { api: { expose: true, vip: '119.15.113.133', sourceRanges: ['96.248.87.234/32'] } };
  const vv = T.vclusterValues(tenant('tenant-x', spec), 31000) as any;
  assert.equal(vv.controlPlane.service.spec.type, 'LoadBalancer');
  assert.equal(vv.controlPlane.service.spec.loadBalancerIP, '119.15.113.133');
  assert.deepEqual(vv.controlPlane.service.spec.loadBalancerSourceRanges, ['96.248.87.234/32']);
  assert.equal(vv.controlPlane.service.labels['midori.phoenix/lb-pool'], 'public');
  assert.ok(vv.controlPlane.proxy.extraSANs.includes('119.15.113.133'), 'VIP in cert SANs');
  assert.ok(vv.controlPlane.proxy.extraSANs.includes('10.30.30.31'), 'node SANs kept');
  const r = T.render(tenant('tenant-x', spec));
  assert.equal((r.present.Namespace[0].metadata as any).labels['midori.phoenix/load-balancers'], 'public');
  assert.equal((r.present.Quota.find((o: any) => o.kind === 'ResourceQuota') as any).spec.hard['services.loadbalancers'], '1');
  // off by default: the API service keeps the base template's NodePort type
  const off = T.vclusterValues(tenant('tenant-x', {}), 31000) as any;
  assert.equal(off.controlPlane?.service?.spec?.type, 'NodePort');
});
