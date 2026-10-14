// What the UI reads and writes. It only ever writes Tenant objects; the
// controller does the rest.

import type { KubernetesObject } from '@kubernetes/client-node';
import { GROUP, VERSION, withDefaults, type Tenant, type TenantSpec } from '../types.ts';

export const NAME_RE = /^tenant-[a-z0-9]([-a-z0-9]{0,23}[a-z0-9])?$/;
const CPU_RE = /^[0-9]+(\.[0-9]+)?m?$/;
const MEM_RE = /^[0-9]+(\.[0-9]+)?(Ki|Mi|Gi|Ti)?$/;
export const GPU_MIB = 46068; // one RTX A6000

export class Invalid extends Error {}

// The form's input -> a TenantSpec. Mirrors the CRD so errors are explained
// here rather than as an API server rejection.
export function parseSpec(input: any): TenantSpec {
  const int = (v: unknown, field: string, min: number, max: number): number => {
    const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !Number.isInteger(n) || n < min || n > max) throw new Invalid(`${field}: a whole number from ${min} to ${max}`);
    return n;
  };
  const opt = (v: unknown, re: RegExp, field: string, example: string): string | undefined => {
    if (v === undefined || v === null || v === '') return undefined;
    const s = String(v).trim();
    if (!re.test(s)) throw new Invalid(`${field}: a quantity such as ${example}`);
    return s;
  };
  const q = input?.quota ?? {};
  const spec: TenantSpec = {
    management: input?.management === 'Observe' ? 'Observe' : 'Manage',
    quota: { gpus: int(q.gpus, 'GPU attachments', 0, 40), gpuMemoryMiB: int(q.gpuMemoryMiB, 'GPU memory (MiB)', 0, 4 * GPU_MIB) },
    network: { internet: !!input?.network?.internet },
    controlPlane: { size: input?.controlPlane?.size === 'large' ? 'large' : 'small' },
    s3: { enabled: input?.s3?.enabled !== false },
    gateway: { expose: !!input?.gateway?.expose },
    observability: { dashboards: ['overview', ...(input?.observability?.dashboards?.includes('serving') ? ['serving' as const] : [])] },
    // Not in the form: kept from the live Tenant on edit (carryOver).
    modelProvider: { enabled: false },
    modelProviders: [],
    loadBalancers: { count: 0, public: false },
  };
  const cpu = { requests: opt(q.cpu?.requests, CPU_RE, 'CPU requests', '"20" or "500m"'), limits: opt(q.cpu?.limits, CPU_RE, 'CPU limits', '"36"') };
  const memory = { requests: opt(q.memory?.requests, MEM_RE, 'Memory requests', '"96Gi"'), limits: opt(q.memory?.limits, MEM_RE, 'Memory limits', '"160Gi"') };
  if (cpu.requests || cpu.limits) spec.quota.cpu = Object.fromEntries(Object.entries(cpu).filter(([, v]) => v));
  if (memory.requests || memory.limits) spec.quota.memory = Object.fromEntries(Object.entries(memory).filter(([, v]) => v));
  if (q.gpuCores !== undefined && q.gpuCores !== '' && q.gpuCores !== null) spec.quota.gpuCores = int(q.gpuCores, 'GPU time', 0, 400);
  if (q.pods !== undefined && q.pods !== '' && q.pods !== null) spec.quota.pods = int(q.pods, 'Pods', 1, 1000);
  if (q.persistentVolumeClaims !== undefined && q.persistentVolumeClaims !== '' && q.persistentVolumeClaims !== null) {
    spec.quota.persistentVolumeClaims = int(q.persistentVolumeClaims, 'PVCs', 0, 1000);
  }
  if (input?.controlPlane?.apiNodePort) spec.controlPlane.apiNodePort = int(input.controlPlane.apiNodePort, 'API NodePort', 30000, 32767);
  return spec;
}

export function newTenant(name: string, spec: TenantSpec): Tenant {
  if (!NAME_RE.test(name)) throw new Invalid('Name: "tenant-" then lowercase letters, digits or "-", at most 32 characters');
  return { apiVersion: `${GROUP}/${VERSION}`, kind: 'Tenant', metadata: { name }, spec };
}

// Spec fields the UI's form does not show must survive an edit. The form has
// no API-port field, and specPatch() sends absent optional fields as null, so
// without this an edit silently unpinned the API NodePort (seen on
// tenant-nv-a; harmless only because the controller kept the port).
export function carryOver(existing: Partial<TenantSpec> | undefined, spec: TenantSpec): TenantSpec {
  if (spec.controlPlane.apiNodePort === undefined && existing?.controlPlane?.apiNodePort !== undefined) {
    spec.controlPlane.apiNodePort = existing.controlPlane.apiNodePort;
  }
  // Not in the form either: model sharing is set with kubectl.
  if (existing?.modelProvider) spec.modelProvider = existing.modelProvider;
  if (existing?.modelProviders) spec.modelProviders = existing.modelProviders;
  if (existing?.loadBalancers) spec.loadBalancers = existing.loadBalancers;
  return spec;
}

// A merge patch that makes the live spec equal `spec`: optional fields the
// form left empty are sent as null, which removes them (back to defaults).
export function specPatch(spec: TenantSpec): object {
  const q = spec.quota;
  return {
    spec: {
      ...spec,
      quota: {
        gpus: q.gpus, gpuMemoryMiB: q.gpuMemoryMiB, gpuCores: q.gpuCores ?? null,
        cpu: q.cpu ?? null, memory: q.memory ?? null,
        pods: q.pods ?? null, persistentVolumeClaims: q.persistentVolumeClaims ?? null,
      },
      controlPlane: { size: spec.controlPlane.size, apiNodePort: spec.controlPlane.apiNodePort ?? null },
    },
  };
}

// --- reading -------------------------------------------------------------

export interface QuotaLine { used: string; hard: string; ratio: number | null }

export function quotaView(rq: any): Record<string, QuotaLine> {
  const out: Record<string, QuotaLine> = {};
  for (const [k, hard] of Object.entries(rq?.status?.hard ?? rq?.spec?.hard ?? {})) {
    const used = rq?.status?.used?.[k] ?? '0';
    const h = toNumber(String(hard)), u = toNumber(String(used));
    out[k] = { used: String(used), hard: String(hard), ratio: h && h > 0 ? u / h : null };
  }
  return out;
}

export function tenantView(t: Tenant, rq: any) {
  const d = withDefaults(t);
  return {
    name: d.metadata!.name!,
    created: d.metadata!.creationTimestamp,
    deleting: !!d.metadata!.deletionTimestamp,
    spec: d.spec,
    status: t.status ?? {},
    quota: quotaView(rq),
  };
}

// Capacity of the GPU nodes (gpu.vendor=nvidia), from HAMi's register
// annotation: each card, its memory and its share count (how many pods may
// attach to it). nvidia.com/gpu counts ATTACHMENTS, so its capacity is the
// sum of share counts (4 cards x 10 = 40), with the cards reported apart.
// CPU and memory from allocatable; GPU time is 100 per card.
export function capacity(nodes: any[], quotas: any[], tenants: Tenant[]) {
  let gpus = 0, cards = 0, gpuMemMiB = 0, cpu = 0, memory = 0;
  for (const n of nodes) {
    if (n.metadata?.labels?.['gpu.vendor'] !== 'nvidia') continue;
    cpu += toNumber(n.status?.allocatable?.cpu ?? '0');
    memory += toNumber(n.status?.allocatable?.memory ?? '0');
    try {
      const devs = JSON.parse(n.metadata?.annotations?.['hami.io/node-nvidia-register'] ?? '[]') as { devmem: number; count?: number }[];
      cards += devs.length;
      gpus += devs.reduce((a, d) => a + (d.count ?? 1), 0);
      gpuMemMiB += devs.reduce((a, d) => a + (d.devmem ?? 0), 0);
    } catch { /* not registered yet */ }
  }
  // What the tenants' quotas add up to, against that capacity.
  const names = new Set(tenants.map((t) => t.metadata!.name!));
  const sum = (k: string) => quotas.filter((q) => names.has(q.metadata?.namespace) && q.metadata?.name === 'tenant-quota')
    .reduce((a, q) => a + toNumber(q.spec?.hard?.[k] ?? '0'), 0);
  const used = (k: string) => quotas.filter((q) => names.has(q.metadata?.namespace) && q.metadata?.name === 'tenant-quota')
    .reduce((a, q) => a + toNumber(q.status?.used?.[k] ?? '0'), 0);
  const line = (k: string, cap: number) => ({ capacity: cap, quota: sum(k), used: used(k), overcommit: cap > 0 ? sum(k) / cap : null });
  return {
    cards,
    gpus: line('requests.nvidia.com/gpu', gpus),
    gpuMemoryMiB: line('requests.midori.phoenix/gpu-memory', gpuMemMiB),
    gpuCores: line('requests.nvidia.com/gpucores', cards * 100),
    cpu: line('requests.cpu', cpu),
    memory: line('requests.memory', memory),
  };
}

// Kubernetes quantity -> number (CPU in cores, memory in bytes).
export function toNumber(q: string): number {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(q.trim());
  if (!m) return 0;
  const v = Number(m[1]);
  const mult: Record<string, number> = {
    '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12,
    Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4,
  };
  return v * (mult[m[2]] ?? 1);
}

export type { KubernetesObject };
