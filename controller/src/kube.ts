// Thin wrapper over @kubernetes/client-node: every write is a server-side
// apply under one field manager, so "what would applying this change?" is the
// same call with dryRun=All.
//
// Reads, applies and deletes go out as RAW JSON, never through the library's
// typed models. Those models rename fields that are reserved words (`from` ->
// `_from`, `default` -> `_default`) and their serializer DROPS the real names:
// a NetworkPolicy applied through KubernetesObjectApi.patch lost its ingress
// `from` -- which would have made it allow every source -- and a LimitRange
// lost its defaults. Observe mode caught it as drift before anything was
// applied.

import {
  ApiException,
  CoreV1Api,
  CustomObjectsApi,
  KubeConfig,
  KubernetesObjectApi,
  PatchStrategy,
  setHeaderOptions,
  type KubernetesObject,
} from '@kubernetes/client-node';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { FIELD_MANAGER, GROUP, PLURAL, VERSION } from './types.ts';

type Action = 'create' | 'delete' | 'patch' | 'read' | 'list' | 'replace';

// The library's URL resolution (API discovery included) is the one thing
// reused from KubernetesObjectApi. It is `protected`, and makeApiClient()
// always constructs the base class, so a subclass cannot reach it; this view
// of the instance can.
type WithPaths = { specUriPath(spec: KubernetesObject, action: Action): Promise<string> };

export class HttpError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

export class Kube {
  readonly kc: KubeConfig;
  readonly objects: KubernetesObjectApi;
  readonly custom: CustomObjectsApi;
  readonly core: CoreV1Api;

  constructor(kc: KubeConfig) {
    this.kc = kc;
    this.objects = KubernetesObjectApi.makeApiClient(kc);

    this.custom = kc.makeApiClient(CustomObjectsApi);
    this.core = kc.makeApiClient(CoreV1Api);
  }

  static load(): Kube {
    const kc = new KubeConfig();
    if (process.env.KUBERNETES_SERVICE_HOST) kc.loadFromCluster();
    else kc.loadFromDefault();
    return new Kube(kc);
  }

  // Server-side apply. force=true takes ownership of fields another manager
  // set (e.g. objects first made by `kubectl apply`), which is what adoption
  // means. dryRun returns what the object WOULD look like, changing nothing.
  //
  // An apply under a field manager declares the COMPLETE set of fields that
  // manager owns in the object: anything it owned before and omits now is
  // removed. Partial applies that must not disturb each other (one tenant's
  // entry in a shared Secret) therefore each need their own manager.
  async apply<T extends KubernetesObject>(obj: T, dryRun = false, manager = FIELD_MANAGER): Promise<T> {
    const q = new URLSearchParams({ fieldManager: manager, force: 'true' });
    if (dryRun) q.set('dryRun', 'All');
    return (await this.raw('PATCH', obj, 'patch', q, JSON.stringify(obj), PatchStrategy.ServerSideApply)) as T;
  }

  // RFC 6902 JSON patch on a namespaced Secret (exact removals).
  async jsonPatchSecret(namespace: string, name: string, ops: object[]): Promise<void> {
    await this.core.patchNamespacedSecret({ name, namespace, body: ops },
      setHeaderOptions('Content-Type', PatchStrategy.JsonPatch));
  }

  async read<T extends KubernetesObject>(obj: KubernetesObject): Promise<T | undefined> {
    try {
      return (await this.raw('GET', header(obj), 'read')) as T;
    } catch (e) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async delete(obj: KubernetesObject): Promise<boolean> {
    try {
      await this.raw('DELETE', header(obj), 'delete', new URLSearchParams({ propagationPolicy: 'Background' }));
      return true;
    } catch (e) {
      if (isNotFound(e)) return false;
      throw e;
    }
  }

  private async raw(method: string, spec: KubernetesObject, action: Action, query?: URLSearchParams,
    body?: string, contentType = 'application/json'): Promise<unknown> {
    const server = this.kc.getCurrentCluster()?.server;
    if (!server) throw new Error('no current cluster in kubeconfig');
    const path = await (this.objects as unknown as WithPaths).specUriPath(spec, action);
    const url = new URL(path.replace(/^https?:\/\/[^/]+/, '') + (query && [...query].length ? `?${query}` : ''), server);
    const opts: RequestOptions = { method, headers: { Accept: 'application/json' } };
    if (body !== undefined) Object.assign(opts.headers!, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(body) });
    await this.kc.applyToHTTPSOptions(opts);
    return new Promise((resolve, reject) => {
      const req = httpsRequest(url, opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString();
          const json = text ? JSON.parse(text) : undefined;
          if ((res.statusCode ?? 0) >= 300) {
            reject(new HttpError(res.statusCode ?? 0, `${method} ${url.pathname}: ${res.statusCode} ${json?.message ?? text.slice(0, 200)}`));
          } else resolve(json);
        });
      });
      req.on('error', reject);
      if (body !== undefined) req.write(body);
      req.end();
    });
  }

  async listTenants(): Promise<KubernetesObject[]> {
    const r = await this.custom.listClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL });
    return (r as { items: KubernetesObject[] }).items;
  }

  async patchTenant(name: string, body: object): Promise<void> {
    await this.custom.patchClusterCustomObject({ group: GROUP, version: VERSION, plural: PLURAL, name, body },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch));
  }

  async patchTenantStatus(name: string, status: object): Promise<void> {
    await this.custom.patchClusterCustomObjectStatus(
      { group: GROUP, version: VERSION, plural: PLURAL, name, body: { status } },
      setHeaderOptions('Content-Type', PatchStrategy.MergePatch));
  }
}

function header(obj: KubernetesObject): KubernetesObject & { metadata: { name: string; namespace?: string } } {
  const name = obj.metadata?.name;
  if (!name) throw new Error(`object without a name: ${obj.kind}`);
  return { apiVersion: obj.apiVersion, kind: obj.kind, metadata: { name, namespace: obj.metadata?.namespace } };
}

export function isNotFound(e: unknown): boolean {
  return (e instanceof ApiException || e instanceof HttpError) && e.code === 404;
}

export function ref(obj: KubernetesObject): string {
  const ns = obj.metadata?.namespace;
  return `${obj.kind}/${ns ? ns + '/' : ''}${obj.metadata?.name}`;
}
