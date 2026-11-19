// Renders a Tenant from the SAME manifests the runbook uses. They are mounted
// from a ConfigMap built from the repo (deploy/templates.sh), so the
// controller and the runbook cannot drift apart. Placeholders are substituted
// exactly as the runbook's `sed` did: TENANT, NAMESPACE, GPUS, GPUMEM.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { KubernetesObject } from '@kubernetes/client-node';
import { parseAllDocuments, parse } from 'yaml';
import { deepMerge } from './diff.ts';
import type { Tenant } from './types.ts';

// The Teleport Proxy the per-tenant agents dial. Env-overridable like API_HOST;
// PROXY_IP is the Proxy's in-cluster ClusterIP (a hostAlias makes the agent reach
// the self-signed cert's name). Option A (real DNS) drops the need for PROXY_IP.
const PROXY_HOST = process.env.TELEPORT_PROXY_HOST ?? 'teleport.midori.phoenix.tyo';
const PROXY_IP = process.env.TELEPORT_PROXY_IP ?? '10.43.252.198';

export interface Rendered {
  // Objects that must exist, by component.
  present: Record<string, KubernetesObject[]>;
  // Objects that must NOT exist (e.g. the internet allow when internet is
  // off), by component. Deleted in Manage, reported in Observe.
  absent: Record<string, KubernetesObject[]>;
}

export class Templates {
  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  raw(file: string): string {
    return readFileSync(join(this.dir, file), 'utf8');
  }

  objects(file: string, vars: Record<string, string>): KubernetesObject[] {
    let text = this.raw(file);
    for (const [k, v] of Object.entries(vars)) text = text.split(k).join(v);
    return parseAllDocuments(text)
      .map((d) => d.toJS() as KubernetesObject | null)
      .filter((o): o is KubernetesObject => !!o && typeof o === 'object' && 'kind' in o);
  }

  // `others`: every other Tenant's name, so links to tenants this one no
  // longer lists in modelProviders are rendered absent and removed.
  render(t: Tenant, others: string[] = []): Rendered {
    const name = t.metadata!.name!;
    const s = t.spec;
    const v = { NAMESPACE: name, TENANT: name, GPUMEM: String(s.quota.gpuMemoryMiB), GPUS: String(s.quota.gpus) };
    const namespace: KubernetesObject = {
      apiVersion: 'v1',
      kind: 'Namespace',
      metadata: {
        name,
        labels: {
          // gvisor: the quota webhook's selector. tenant: the Cilium floor's,
          // the platform guard's and the observability rules' key.
          gvisor: '',
          tenant: name,
          'pod-security.kubernetes.io/enforce': 'baseline',
          // Read by manifests/midori/load-balancer-guard.yaml.
          'midori.phoenix/load-balancers': s.loadBalancers.count > 0 ? (s.loadBalancers.public ? 'public' : 'internal') : 'none',
        },
      },
    };
    const floor = s.network.internet ? 'tenant-internet.yaml' : 'tenant-floor.yaml';
    const network = [
      ...this.objects('tenant-netpol.yaml', v),
      ...this.objects(floor, v),
      ...this.objects('tenant-allow.yaml', v),
      ...this.objects('tenant-scrape-allow.yaml', v),
    ];
    const absent: KubernetesObject[] = [];
    // tenant-internet.yaml carries one namespaced allow besides the two floor
    // policies, which the standard floor shares by name.
    const internetOnly = this.objects('tenant-internet.yaml', v).filter((o) => o.kind === 'CiliumNetworkPolicy');
    if (!s.network.internet) absent.push(...internetOnly);
    const s3allow = this.objects('tenant-s3-allow.yaml', v);
    if (s.s3.enabled) network.push(...s3allow); else absent.push(...s3allow);
    const gateway = this.objects('gateway-ingress.yaml', v);
    if (s.gateway.expose) network.push(...gateway); else absent.push(...gateway);
    // Quota lines the Tenant sets override the template's; the rest keep the
    // template's values, so a Tenant that sets none renders exactly the
    // runbook's quota.
    const quota = this.objects('tenant-quota.yaml', v);
    const rq = quota.find((o) => o.kind === 'ResourceQuota') as { spec: { hard: Record<string, string> } } | undefined;
    if (rq) {
      const q = s.quota;
      const set = (k: string, val: string | number | undefined) => { if (val !== undefined) rq.spec.hard[k] = String(val); };
      set('requests.cpu', q.cpu?.requests);
      set('limits.cpu', q.cpu?.limits);
      set('requests.memory', q.memory?.requests);
      set('limits.memory', q.memory?.limits);
      set('pods', q.pods);
      set('persistentvolumeclaims', q.persistentVolumeClaims);
      // GPU time is unlimited unless the Tenant sets it (no template default).
      set('requests.nvidia.com/gpucores', q.gpuCores);
      // AMD GPU VRAM: one unit of amd.com/gpu-vram-mib is 512 MiB, so the MiB
      // figure is floored to whole units. The AMD device plugin advertises
      // this extended resource, so ResourceQuota counts requests natively (no
      // webhook total-resource needed, unlike NVIDIA). Unset = not limited.
      if (q.amdGpuVramMiB !== undefined) rq.spec.hard['requests.amd.com/gpu-vram-mib'] = String(Math.floor(q.amdGpuVramMiB / 512));
      // Bounds how many type: LoadBalancer Services the tenant may have. A
      // public one now draws a VIP from the fabric /26 (Cilium LB-IPAM + BGP),
      // not an Octavia amphora. None unless the Tenant asks.
      rq.spec.hard['services.loadbalancers'] = String(s.loadBalancers.count);
    }
    // Models: the broker in front of this tenant's Gateway, if it offers it,
    // and this tenant's side of each provider it may call.
    const models: KubernetesObject[] = [];
    const modelsAbsent: KubernetesObject[] = [];
    const provider = this.objects('model-provider.yaml', { PROVIDER: name });
    if (s.modelProvider.enabled) models.push(...provider);
    // The shared namespace stays: other providers' brokers live in it.
    else modelsAbsent.push(...provider.filter((o) => o.kind !== 'Namespace'));
    const consumer = (p: string) => this.objects('model-consumer.yaml', { CONSUMER: name, PROVIDER: p });
    const providers = s.modelProviders.filter((p) => p !== name);
    for (const p of providers) models.push(...consumer(p));
    for (const p of others) if (p !== name && !providers.includes(p)) modelsAbsent.push(...consumer(p));
    // Teleport host objects (operator CRs + the kube-agent) exist only when the
    // tenant opts in; otherwise they are rendered absent so Manage removes them.
    // The in-vCluster RBAC is applied by the Teleport component (a second client),
    // not here, since render's present/absent target the host cluster.
    const teleportHost = this.teleportHost(t);
    return {
      present: {
        Namespace: [namespace],
        Quota: quota,
        Network: network,
        Models: models,
        Metrics: this.objects('tenant-prom-proxy.yaml', v),
        Teleport: s.access.teleport ? teleportHost : [],
      },
      absent: { Network: absent, Models: modelsAbsent, Teleport: s.access.teleport ? [] : teleportHost },
    };
  }

  // Host-side Teleport objects for a tenant: the operator-managed role + join
  // token and the kube-agent (ConfigMap + Deployment + its SA).
  teleportHost(t: Tenant): KubernetesObject[] {
    return this.objects('teleport-host.yaml', { TENANT: t.metadata!.name!, PROXY_HOST, PROXY_IP });
  }

  // RBAC applied INSIDE the tenant's vCluster: the impersonator SA + its token
  // and the least-privilege <tenant>-runner Role the agent impersonates into.
  teleportVcluster(t: Tenant): KubernetesObject[] {
    return this.objects('teleport-vcluster.yaml', { TENANT: t.metadata!.name! });
  }

  // The vCluster's Helm values, merged as `vcluster create --values ...` did.
  vclusterValues(t: Tenant, apiNodePort: number): Record<string, unknown> {
    const overlay: Record<string, unknown> = { controlPlane: { service: { httpsNodePort: apiNodePort } } };
    if (t.spec.controlPlane.size === 'large') {
      // As values/tenant-phoenix-serving.yaml: Phoenix Serving's CRD install
      // crashed a 1 CPU / 1Gi control plane.
      (overlay.controlPlane as Record<string, unknown>).statefulSet = {
        resources: { requests: { cpu: '1', memory: '1Gi' }, limits: { cpu: '4', memory: '4Gi' } },
      };
    }
    const values = deepMerge(
      parse(this.raw('vcluster-tenant.yaml')),
      parse(this.raw('vcluster-nv-tenant.yaml')),
      parse(this.raw('vcluster-midori-tenant.yaml')),
      overlay,
    ) as {
      networking?: { replicateServices?: { fromHost?: Array<{ from: string; to: string }> } };
      sync?: { fromHost?: { nodes?: unknown } };
    };
    // Node sync scoped to this tenant's GPU vendor: its scheduler sees only
    // host nodes labelled gpu.vendor=<vendor> (and nothing about other tenants
    // or control-plane nodes). Overrides vcluster-nv-tenant.yaml's nvidia default.
    ((values.sync ??= {}).fromHost ??= {}).nodes = {
      enabled: true,
      selector: { labels: { 'gpu.vendor': t.spec.gpuVendor } },
    };
    // Each model provider's broker, under the same name inside the vCluster
    // (model-consumer.yaml). Appended: a merge would replace the S3 entry.
    const providers = t.spec.modelProviders.filter((p) => p !== t.metadata!.name);
    if (providers.length) {
      const rs = ((values.networking ??= {}).replicateServices ??= {});
      rs.fromHost = [...(rs.fromHost ?? []), ...providers.map((p) => ({ from: `model-providers/${p}`, to: `model-providers/${p}` }))];
    }
    return values;
  }

  dashboard(name: 'overview' | 'serving'): Record<string, unknown> {
    return JSON.parse(this.raw(`dashboard-tenant-${name}.json`));
  }
}
