// The Tenant resource (deploy/crd.yaml) and the shapes the reconciler passes
// around.

import type { KubernetesObject } from '@kubernetes/client-node';

export const GROUP = 'midori.phoenix';
export const VERSION = 'v1alpha1';
export const PLURAL = 'tenants';
export const FIELD_MANAGER = 'midori-tenant-controller';
export const FINALIZER = 'midori.phoenix/teardown';
// Deleting a Tenant destroys the tenant's control plane and data; the
// finalizer refuses to tear down unless this annotation is "true".
export const ALLOW_DELETE = 'midori.phoenix/allow-delete';

export type Management = 'Observe' | 'Manage';

export interface TenantSpec {
  management: Management;
  quota: {
    gpus: number;
    gpuMemoryMiB: number;
    // Optional; unset keeps the value in manifests/midori/tenant-quota.yaml.
    // Kubernetes quantities ("20", "96Gi").
    cpu?: { requests?: string; limits?: string };
    memory?: { requests?: string; limits?: string };
    pods?: number;
    persistentVolumeClaims?: number;
  };
  network: { internet: boolean };
  controlPlane: { apiNodePort?: number; size: 'small' | 'large' };
  s3: { enabled: boolean };
  gateway: { expose: boolean };
  observability: { dashboards: Array<'overview' | 'serving'> };
}

export interface Condition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason: string;
  message: string;
  lastTransitionTime?: string;
}

// One object whose live state differs from what the controller would apply.
export interface Drift {
  component: string;
  object: string; // Kind/namespace/name
  change: 'create' | 'update' | 'delete';
  paths: string[]; // JSON paths that would change (update only)
}

export interface TenantStatus {
  observedGeneration?: number;
  phase?: 'Observing' | 'Ready' | 'Degraded' | 'Deleting' | 'Blocked';
  apiEndpoint?: string;
  apiNodePort?: number;
  kubeconfigSecret?: string;
  grafana?: { org?: number; user?: string };
  conditions?: Condition[];
  driftCount?: number;
  drift?: Drift[];
}

export interface Tenant extends KubernetesObject {
  spec: TenantSpec;
  status?: TenantStatus;
}

// What one component contributes on one reconcile.
export interface ComponentResult {
  condition: Condition;
  drift: Drift[];
  status?: Partial<TenantStatus>;
}

// Defaults the API server fills from the CRD schema; repeated here so a
// Tenant read before defaulting (or in tests) behaves the same.
export function withDefaults(t: Tenant): Tenant {
  const s = (t.spec ?? {}) as Partial<TenantSpec>;
  return {
    ...t,
    spec: {
      management: s.management ?? 'Observe',
      quota: { gpus: 0, gpuMemoryMiB: 0, ...(s.quota ?? {}) },
      network: { internet: s.network?.internet ?? false },
      controlPlane: { size: s.controlPlane?.size ?? 'small', apiNodePort: s.controlPlane?.apiNodePort },
      s3: { enabled: s.s3?.enabled ?? true },
      gateway: { expose: s.gateway?.expose ?? false },
      observability: { dashboards: s.observability?.dashboards ?? ['overview'] },
    },
  };
}
