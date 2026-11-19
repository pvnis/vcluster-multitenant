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
    gpus: number;          // GPU attachments (sum of nvidia.com/gpu), not cards
    gpuMemoryMiB: number;
    gpuCores?: number;     // optional: sum of nvidia.com/gpucores (100 = one card's time)
    // optional: sum of amd.com/gpu-vram-mib, in MiB (one unit = 512 MiB;
    // floored to units when rendered). Unset = not limited.
    amdGpuVramMiB?: number;
    // Optional; unset keeps the value in manifests/midori/tenant-quota.yaml.
    // Kubernetes quantities ("20", "96Gi").
    cpu?: { requests?: string; limits?: string };
    memory?: { requests?: string; limits?: string };
    pods?: number;
    persistentVolumeClaims?: number;
  };
  network: { internet: boolean };
  // Which GPU node type this tenant schedules onto: its vCluster syncs host
  // nodes labelled gpu.vendor=<this>. One vendor per tenant (TWO-VENDOR-CLUSTER.md
  // keeps tenant-nv-* and tenant-amd-* separate). Default nvidia.
  gpuVendor: 'nvidia' | 'amd';
  controlPlane: { apiNodePort?: number; size: 'small' | 'large' };
  s3: { enabled: boolean };
  gateway: { expose: boolean };
  observability: { dashboards: Array<'overview' | 'serving'> };
  // This tenant's Phoenix Serving Gateway may be offered to other tenants,
  // through a broker (manifests/midori/model-provider.yaml).
  modelProvider: { enabled: boolean };
  // Tenants whose models this one may call (each must have
  // modelProvider.enabled), at http://<provider>.model-providers:8080/v1.
  modelProviders: string[];
  // OpenStack (Octavia) load balancers for this tenant's type: LoadBalancer
  // Services: how many (ResourceQuota services.loadbalancers; 0 = none) and
  // whether they may take a public floating IP
  // (manifests/midori/load-balancer-guard.yaml).
  loadBalancers: { count: number; public: boolean };
  // Zero-trust access to this tenant's k8s API via Teleport (manifests/midori/
  // teleport/DESIGN.md): identity-based, audited, NO public API surface (the
  // agent dials outbound). When true the controller registers the vCluster as a
  // Teleport kube_cluster with a least-privilege role; agents join with Machine
  // ID (tbot). The preferred alternative to `api.expose`'s public VIP.
  access: { teleport: boolean };
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
  // The Teleport kube_cluster this tenant is registered as (spec.access.teleport).
  teleportCluster?: string;
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
      gpuVendor: s.gpuVendor === 'amd' ? 'amd' : 'nvidia',
      controlPlane: { size: s.controlPlane?.size ?? 'small', apiNodePort: s.controlPlane?.apiNodePort },
      s3: { enabled: s.s3?.enabled ?? true },
      gateway: { expose: s.gateway?.expose ?? false },
      observability: { dashboards: s.observability?.dashboards ?? ['overview'] },
      modelProvider: { enabled: s.modelProvider?.enabled ?? false },
      modelProviders: s.modelProviders ?? [],
      loadBalancers: { count: s.loadBalancers?.count ?? 0, public: s.loadBalancers?.public ?? false },
      access: { teleport: s.access?.teleport ?? false },
    },
  };
}
