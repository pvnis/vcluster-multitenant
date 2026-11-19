// Zero-trust access to a tenant's k8s API via Teleport (manifests/midori/
// teleport/DESIGN.md), when spec.access.teleport is true. Three parts:
//
//  1. INSIDE the vCluster (a second client, from the <tenant>-kubeconfig Secret
//     the VCluster component mints): the impersonator SA + its token and the
//     least-privilege <tenant>-runner Role the agent impersonates into.
//  2. On the HOST: the agent's kubeconfig Secret, built from that impersonator
//     SA token — so the agent authenticates to the vCluster as impersonate-only.
//  3. On the HOST: the operator-managed Teleport role + join token (kubernetes
//     SA join, no shared secret) and the kube-agent that registers the vCluster
//     as kube_cluster "<tenant>" over an OUTBOUND tunnel. No inbound exposure.
//
// The agent Secret is written before the host objects so the agent pod finds it
// on first start. Each hop is idempotent and resumes on the next reconcile, so a
// not-yet-ready vCluster or SA token just defers to a later pass.

import { KubeConfig, type KubernetesObject, type V1Secret } from '@kubernetes/client-node';
import { stringify } from 'yaml';
import { Kube } from '../kube.ts';
import { reconcileObjects } from './objects.ts';
import { KUBECONFIG_NAMESPACE } from './vcluster.ts';
import type { ComponentResult, Management, Tenant } from '../types.ts';
import type { Templates } from '../templates.ts';

const AGENT_NS = 'teleport';
const kubeconfigSecret = (name: string): KubernetesObject => ({
  apiVersion: 'v1', kind: 'Secret', metadata: { name: `${name}-teleport-kubeconfig`, namespace: AGENT_NS },
});

export async function reconcileTeleport(
  kube: Kube, templates: Templates, t: Tenant,
  presentHost: KubernetesObject[], absentHost: KubernetesObject[], mode: Management,
): Promise<ComponentResult> {
  const name = t.metadata!.name!;
  const enabled = t.spec.access.teleport;

  if (!enabled) {
    // Tear the host objects down; drop the agent kubeconfig Secret. The in-
    // vCluster RBAC is harmless if left and goes with the vCluster on teardown.
    const res = await reconcileObjects(kube, 'Teleport', [], absentHost, mode);
    if (mode === 'Manage') await kube.delete(kubeconfigSecret(name));
    return res;
  }

  // Observe: just dry-run the host objects (the vCluster side needs real writes).
  if (mode !== 'Manage') return reconcileObjects(kube, 'Teleport', presentHost, [], mode);

  const pending = (why: string): ComponentResult => ({
    drift: [],
    condition: { type: 'TeleportReady', status: 'False', reason: 'Pending', message: why },
  });

  // 1. In-vCluster RBAC.
  const vc = await vclusterClient(kube, name);
  if (!vc) return pending('vCluster kubeconfig not ready');
  for (const o of templates.teleportVcluster(t)) await vc.apply(o);

  // 2. Agent kubeconfig from the impersonator SA token (populated async by k8s).
  const agentKubeconfig = await buildAgentKubeconfig(vc, name);
  if (!agentKubeconfig) return pending('impersonator SA token not populated yet');
  await kube.apply(agentKubeconfig);

  // 3. Host objects: operator role + token CRs and the kube-agent.
  const res = await reconcileObjects(kube, 'Teleport', presentHost, [], mode);
  return {
    ...res,
    status: { teleportCluster: name },
    condition: { ...res.condition, message: `kube_cluster ${name}: ${res.condition.message}` },
  };
}

// A Kube client for the tenant's vCluster, from the <tenant>-kubeconfig Secret
// (server already rewritten to a reachable NodePort). Undefined until it exists.
async function vclusterClient(kube: Kube, name: string): Promise<Kube | undefined> {
  const sec = await kube.read<V1Secret>({ apiVersion: 'v1', kind: 'Secret', metadata: { name: `${name}-kubeconfig`, namespace: KUBECONFIG_NAMESPACE } });
  if (!sec?.data?.config) return undefined;
  const kc = new KubeConfig();
  kc.loadFromString(Buffer.from(sec.data.config, 'base64').toString());
  return new Kube(kc);
}

// Builds the agent's kubeconfig Secret: the vCluster server + CA from the admin
// kubeconfig, the token from the impersonator SA's Secret (impersonate-only).
async function buildAgentKubeconfig(vc: Kube, name: string): Promise<KubernetesObject | undefined> {
  const sec = await vc.read<V1Secret>({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'teleport-token', namespace: 'kube-system' } });
  if (!sec?.data?.token) return undefined; // the token controller has not filled it yet
  const token = Buffer.from(sec.data.token, 'base64').toString();
  const cluster = vc.kc.getCurrentCluster();
  // The context name becomes the Teleport kube_cluster name, so name it after
  // the tenant (the agent config omits kube_cluster_name to avoid a conflict).
  const kubeconfig = {
    apiVersion: 'v1', kind: 'Config',
    clusters: [{ name, cluster: { server: cluster?.server, 'certificate-authority-data': sec.data['ca.crt'] } }],
    users: [{ name: 'teleport', user: { token } }],
    contexts: [{ name, context: { cluster: name, user: 'teleport' } }],
    'current-context': name,
  };
  return {
    ...kubeconfigSecret(name),
    type: 'Opaque',
    stringData: { kubeconfig: stringify(kubeconfig) },
  } as KubernetesObject;
}

// Best-effort removal of a tenant's host-side Teleport objects on teardown. The
// in-vCluster RBAC dies with the vCluster.
export async function deleteTeleport(kube: Kube, templates: Templates, t: Tenant): Promise<void> {
  for (const o of templates.teleportHost(t)) await kube.delete(o);
  await kube.delete(kubeconfigSecret(t.metadata!.name!));
}
