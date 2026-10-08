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

  render(t: Tenant): Rendered {
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
    return {
      present: {
        Namespace: [namespace],
        Quota: this.objects('tenant-quota.yaml', v),
        Network: network,
        Metrics: this.objects('tenant-prom-proxy.yaml', v),
      },
      absent: { Network: absent },
    };
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
    return deepMerge(
      parse(this.raw('vcluster-tenant.yaml')),
      parse(this.raw('vcluster-nv-tenant.yaml')),
      parse(this.raw('vcluster-midori-tenant.yaml')),
      overlay,
    );
  }

  dashboard(name: 'overview' | 'serving'): Record<string, unknown> {
    return JSON.parse(this.raw(`dashboard-tenant-${name}.json`));
  }
}
