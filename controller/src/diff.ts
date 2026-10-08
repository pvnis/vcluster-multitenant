// "Would applying this change the live object?" -- compare the live object
// with the server's dry-run apply result, ignoring bookkeeping the apply
// itself rewrites (managedFields, resourceVersion, ...).

import type { KubernetesObject } from '@kubernetes/client-node';

const IGNORED_METADATA = ['managedFields', 'resourceVersion', 'generation', 'uid', 'creationTimestamp'];
const IGNORED_ANNOTATIONS = ['kubectl.kubernetes.io/last-applied-configuration'];

export function normalise(obj: KubernetesObject | undefined): unknown {
  if (!obj) return undefined;
  const o = structuredClone(obj) as Record<string, any>;
  delete o.status;
  if (o.metadata) {
    for (const k of IGNORED_METADATA) delete o.metadata[k];
    if (o.metadata.annotations) {
      for (const k of IGNORED_ANNOTATIONS) delete o.metadata.annotations[k];
      if (Object.keys(o.metadata.annotations).length === 0) delete o.metadata.annotations;
    }
  }
  return o;
}

// JSON paths at which a and b differ, at most `limit` of them.
export function diffPaths(a: unknown, b: unknown, limit = 20): string[] {
  const out: string[] = [];
  walk(a, b, '', out, limit);
  return out;
}

function walk(a: unknown, b: unknown, path: string, out: string[], limit: number): void {
  if (out.length >= limit) return;
  if (Object.is(a, b)) return;
  const ta = kind(a), tb = kind(b);
  if (ta !== tb || (ta !== 'object' && ta !== 'array')) {
    out.push(path || '.');
    return;
  }
  if (ta === 'array') {
    const aa = a as unknown[], bb = b as unknown[];
    if (aa.length !== bb.length) {
      out.push(`${path}[] (length ${aa.length} -> ${bb.length})`);
      return;
    }
    aa.forEach((v, i) => walk(v, bb[i], `${path}[${i}]`, out, limit));
    return;
  }
  const ao = a as Record<string, unknown>, bo = b as Record<string, unknown>;
  for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
    walk(ao[k], bo[k], `${path}.${k}`, out, limit);
  }
}

function kind(v: unknown): string {
  if (Array.isArray(v)) return 'array';
  if (v === null) return 'null';
  return typeof v;
}

// Helm-style deep merge, as `vcluster create --values a --values b` does:
// maps merge recursively, everything else (lists included) is replaced.
export function deepMerge(...layers: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const layer of layers) mergeInto(out, layer as Record<string, unknown>);
  return out;
}

function mergeInto(dst: Record<string, unknown>, src: Record<string, unknown> | undefined): void {
  if (!src) return;
  for (const [k, v] of Object.entries(src)) {
    if (kind(v) === 'object' && kind(dst[k]) === 'object') {
      mergeInto(dst[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else {
      dst[k] = structuredClone(v);
    }
  }
}
