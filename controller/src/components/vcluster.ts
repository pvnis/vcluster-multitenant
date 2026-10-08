// The tenant's vCluster: a Helm release of the vcluster chart, as
// `vcluster create` makes it, plus a usable kubeconfig.
//
// Adoption is safe by construction: the desired values are the same files
// `vcluster create` merged (test/render.test.ts checks they equal the live
// releases), and a release is only upgraded in Manage when they differ --
// an upgrade restarts the tenant's control plane.

import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { KubernetesObject, V1Secret, V1Service } from '@kubernetes/client-node';
import { parse, stringify } from 'yaml';
import type { Kube } from '../kube.ts';
import { diffPaths } from '../diff.ts';
import type { Templates } from '../templates.ts';
import type { ComponentResult, Drift, Tenant } from '../types.ts';

const run = promisify(execFile);
const HELM = process.env.HELM ?? 'helm';
const CHART_REPO = process.env.VCLUSTER_CHART_REPO ?? 'https://charts.loft.sh';
const CHART_VERSION = process.env.VCLUSTER_CHART_VERSION ?? '0.36.1';
// The address put into tenant kubeconfigs; any node serves the NodePort.
const API_HOST = process.env.API_HOST ?? '10.30.30.226';
const PORT_RANGE: [number, number] = [31000, 32767];
export const KUBECONFIG_NAMESPACE = process.env.CONTROLLER_NAMESPACE ?? 'tenant-system';

async function helm(...args: string[]): Promise<string> {
  const { stdout } = await run(HELM, args, { maxBuffer: 16 << 20 });
  return stdout;
}

async function releaseValues(name: string): Promise<Record<string, unknown> | undefined> {
  try {
    const v = JSON.parse(await helm('get', 'values', name, '-n', name, '-o', 'json')) as Record<string, unknown>;
    // vclusterctl adds its own telemetry block; it is not part of our spec.
    delete v.telemetry;
    return v;
  } catch (e) {
    if (String((e as { stderr?: string }).stderr ?? e).includes('not found')) return undefined;
    throw e;
  }
}

// The API NodePort: the spec's, else the one already recorded, else the live
// release's (adoption), else the lowest free port in PORT_RANGE.
async function apiNodePort(kube: Kube, t: Tenant, live?: Record<string, unknown>): Promise<number> {
  const fromRelease = (live?.controlPlane as any)?.service?.httpsNodePort as number | undefined;
  const chosen = t.spec.controlPlane.apiNodePort ?? t.status?.apiNodePort ?? fromRelease;
  if (chosen) return chosen;
  const used = new Set<number>();
  const svcs = (await kube.objects.list('v1', 'Service')).items as V1Service[];
  for (const s of svcs) for (const p of s.spec?.ports ?? []) if (p.nodePort) used.add(p.nodePort);
  for (let p = PORT_RANGE[0]; p <= PORT_RANGE[1]; p++) if (!used.has(p)) return p;
  throw new Error('no free NodePort');
}

export async function reconcileVCluster(kube: Kube, templates: Templates, t: Tenant): Promise<ComponentResult> {
  const name = t.metadata!.name!;
  const live = await releaseValues(name);
  const port = await apiNodePort(kube, t, live);
  const want = templates.vclusterValues(t, port);
  const drift: Drift[] = [];
  const object = `HelmRelease/${name}/${name}`;
  let action = 'InSync';

  if (!live) drift.push({ component: 'VCluster', object, change: 'create', paths: [] });
  else {
    const paths = diffPaths(live, want);
    if (paths.length) drift.push({ component: 'VCluster', object, change: 'update', paths });
  }

  if (t.spec.management === 'Manage' && drift.length) {
    const dir = mkdtempSync(join(tmpdir(), 'vc-'));
    try {
      const f = join(dir, 'values.yaml');
      writeFileSync(f, stringify(want));
      await helm('upgrade', '--install', name, 'vcluster', '--repo', CHART_REPO, '--version', CHART_VERSION,
        '-n', name, '-f', f, '--wait', '--timeout', '10m');
      action = live ? 'Upgraded' : 'Installed';
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const kubeconfig = await reconcileKubeconfig(kube, t, port);
  if (kubeconfig) drift.push(kubeconfig);
  const managed = t.spec.management === 'Manage';
  const ok = managed || drift.length === 0;
  return {
    drift: managed ? [] : drift,
    status: { apiNodePort: port, apiEndpoint: `https://${API_HOST}:${port}`, kubeconfigSecret: `${KUBECONFIG_NAMESPACE}/${name}-kubeconfig` },
    condition: {
      type: 'VClusterReady',
      status: ok ? 'True' : 'False',
      reason: managed ? action : drift.length ? 'Drift' : 'InSync',
      message: managed ? `release ${action.toLowerCase()}, API on :${port}` : drift.length ? 'release or kubeconfig would change' : `release matches, API on :${port}`,
    },
  };
}

// Copies the vCluster's own admin kubeconfig (Secret vc-<name>, server
// localhost:8443) into tenant-system with the server set to a node address,
// so operators can fetch it with kubectl instead of from files on cp-0.
async function reconcileKubeconfig(kube: Kube, t: Tenant, port: number): Promise<Drift | undefined> {
  const name = t.metadata!.name!;
  const src = await kube.read<V1Secret>({ apiVersion: 'v1', kind: 'Secret', metadata: { name: `vc-${name}`, namespace: name } });
  const target: KubernetesObject = { apiVersion: 'v1', kind: 'Secret', metadata: { name: `${name}-kubeconfig`, namespace: KUBECONFIG_NAMESPACE } };
  if (!src?.data?.config) return undefined; // the release is not up yet
  const cfg = parse(Buffer.from(src.data.config, 'base64').toString()) as any;
  for (const c of cfg.clusters ?? []) c.cluster.server = `https://${API_HOST}:${port}`;
  const want: V1Secret = {
    ...(target as V1Secret),
    metadata: { ...target.metadata, labels: { 'midori.phoenix/tenant': name } },
    type: 'Opaque',
    stringData: { config: stringify(cfg) },
  };
  if (t.spec.management === 'Manage') {
    await kube.apply(want);
    return undefined;
  }
  const live = await kube.read<V1Secret>(target);
  if (!live) return { component: 'VCluster', object: `Secret/${KUBECONFIG_NAMESPACE}/${name}-kubeconfig`, change: 'create', paths: [] };
  return undefined;
}

export async function deleteVCluster(name: string): Promise<void> {
  try {
    await helm('uninstall', name, '-n', name, '--wait', '--timeout', '10m');
  } catch (e) {
    if (!String((e as { stderr?: string }).stderr ?? e).includes('not found')) throw e;
  }
}
