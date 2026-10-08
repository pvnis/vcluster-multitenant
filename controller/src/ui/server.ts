// The tenant UI: static files and a JSON API over Tenant objects.
//
//   GET    /api/me                       who is logged in
//   POST   /api/login  {user, password}  -> session cookie
//   POST   /api/logout
//   GET    /api/overview                 tenants (with quota use) + capacity
//   GET    /api/tenants/:name            one tenant
//   POST   /api/tenants      {name, spec}  create
//   PUT    /api/tenants/:name {spec}       replace the spec
//   DELETE /api/tenants/:name {confirm}    annotate allow-delete, then delete
//   GET    /api/tenants/:name/credentials  Grafana login + S3 key (audited)
//   GET    /api/tenants/:name/kubeconfig   download (audited)
//
// It can only write Tenants (see deploy/ui.yaml for its RBAC); the controller
// does everything else. Every request except /api/login and the static files
// needs a session. Writes also need the X-Tenant-UI header and a same-origin
// Origin, which with the SameSite=Strict cookie stops cross-site requests.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { V1Secret } from '@kubernetes/client-node';
import { Kube, isNotFound } from '../kube.ts';
import { ALLOW_DELETE, GROUP, VERSION, type Tenant } from '../types.ts';
import { Auth } from './auth.ts';
import { Invalid, NAME_RE, capacity, carryOver, newTenant, parseSpec, specPatch, tenantView } from './model.ts';

const PORT = Number(process.env.UI_PORT ?? 8080);
const STATIC = process.env.UI_DIR ?? join(import.meta.dirname, '../../ui');
const SYSTEM_NS = process.env.CONTROLLER_NAMESPACE ?? 'tenant-system';
const COOKIE = 'tenant_ui';
const MANAGER = 'tenant-ui';

const kube = Kube.load();
const auth = new Auth(kube);
const audit = (user: string, action: string, tenant?: string, extra: object = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), audit: true, user, action, tenant, ...extra }));

const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Frame-Options': 'DENY',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cache-Control': 'no-store',
};

class HttpErr extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(text);
}

function cookie(req: IncomingMessage): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE) return v.join('=');
  }
  return undefined;
}

async function body(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 64 * 1024) throw new HttpErr(413, 'request too large');
    chunks.push(c as Buffer);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw new HttpErr(400, 'invalid JSON');
  }
}

const tenantRef = (name: string) => ({ apiVersion: `${GROUP}/${VERSION}`, kind: 'Tenant', metadata: { name } });

async function getTenant(name: string): Promise<Tenant> {
  if (!NAME_RE.test(name)) throw new HttpErr(404, 'no such tenant');
  const t = await kube.read<Tenant>(tenantRef(name));
  if (!t) throw new HttpErr(404, 'no such tenant');
  return t;
}

async function secretData(name: string): Promise<Record<string, string>> {
  const s = await kube.read<V1Secret>({ apiVersion: 'v1', kind: 'Secret', metadata: { name, namespace: SYSTEM_NS } });
  return Object.fromEntries(Object.entries(s?.data ?? {}).map(([k, v]) => [k, Buffer.from(v, 'base64').toString()]));
}

async function overview() {
  const [tenants, quotas, nodes] = await Promise.all([
    kube.listTenants() as Promise<Tenant[]>,
    kube.getPath<{ items: any[] }>('/api/v1/resourcequotas').then((r) => r.items),
    kube.getPath<{ items: any[] }>('/api/v1/nodes').then((r) => r.items),
  ]);
  const rq = (ns: string) => quotas.find((q) => q.metadata?.namespace === ns && q.metadata?.name === 'tenant-quota');
  return {
    tenants: tenants.map((t) => tenantView(t, rq(t.metadata!.name!))).sort((a, b) => a.name.localeCompare(b.name)),
    capacity: capacity(nodes, quotas, tenants),
  };
}

async function api(req: IncomingMessage, res: ServerResponse, path: string): Promise<void> {
  const method = req.method ?? 'GET';
  const token = cookie(req);

  if (path === '/api/login' && method === 'POST') {
    const b = await body(req);
    const client = req.socket.remoteAddress ?? '?';
    const r = await auth.login(String(b.user ?? ''), String(b.password ?? ''), client);
    if (typeof r === 'string') {
      audit(String(b.user), 'login', undefined, { client });
      return send(res, 200, { user: b.user }, {
        'Set-Cookie': `${COOKIE}=${r}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${12 * 3600}`,
      });
    }
    audit(String(b.user), 'login-failed', undefined, { client });
    if (r && 'retryAfter' in r) return send(res, 429, { error: `too many failed logins; try again in ${r.retryAfter} s` }, { 'Retry-After': String(r.retryAfter) });
    return send(res, 401, { error: 'wrong user or password' });
  }

  const user = auth.user(token);
  if (!user) throw new HttpErr(401, 'not logged in');

  if (method !== 'GET') {
    // CSRF: a custom header cannot be sent cross-site without a CORS
    // preflight, which this server never grants; Origin, when present, must
    // be this host.
    if (req.headers['x-tenant-ui'] !== '1') throw new HttpErr(403, 'missing X-Tenant-UI header');
    const origin = req.headers.origin;
    if (origin && origin !== `http://${req.headers.host}` && origin !== `https://${req.headers.host}`) throw new HttpErr(403, 'cross-origin request refused');
  }

  if (path === '/api/me') return send(res, 200, { user });
  if (path === '/api/logout' && method === 'POST') {
    auth.logout(token);
    return send(res, 200, {}, { 'Set-Cookie': `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0` });
  }
  if (path === '/api/overview' && method === 'GET') return send(res, 200, await overview());

  if (path === '/api/tenants' && method === 'POST') {
    const b = await body(req);
    const t = newTenant(String(b.name ?? ''), parseSpec(b.spec));
    if (await kube.read(tenantRef(t.metadata!.name!))) throw new HttpErr(409, `${t.metadata!.name} already exists`);
    await kube.apply(t, false, MANAGER);
    audit(user, 'create', t.metadata!.name, { spec: t.spec });
    return send(res, 201, { name: t.metadata!.name });
  }

  const m = /^\/api\/tenants\/([^/]+)(?:\/(credentials|kubeconfig))?$/.exec(path);
  if (!m) throw new HttpErr(404, 'not found');
  const name = decodeURIComponent(m[1]);
  const sub = m[2];

  if (!sub && method === 'GET') {
    const t = await getTenant(name);
    const quotas = await kube.getPath<{ items: any[] }>(`/api/v1/namespaces/${name}/resourcequotas`).catch(() => ({ items: [] }));
    return send(res, 200, tenantView(t, quotas.items.find((q) => q.metadata?.name === 'tenant-quota')));
  }
  if (!sub && method === 'PUT') {
    const existing = await getTenant(name);
    const spec = carryOver(existing.spec, parseSpec((await body(req)).spec));
    await kube.patchTenant(name, specPatch(spec));
    audit(user, 'update', name, { spec });
    return send(res, 200, { name });
  }
  if (!sub && method === 'DELETE') {
    const t = await getTenant(name);
    const b = await body(req);
    if (b.confirm !== name) throw new HttpErr(400, 'type the tenant name to confirm deletion');
    // In Manage the controller tears the tenant down only with this
    // annotation; in Observe deleting just stops management.
    if (t.spec?.management === 'Manage') await kube.patchTenant(name, { metadata: { annotations: { [ALLOW_DELETE]: 'true' } } });
    await kube.delete(tenantRef(name));
    audit(user, 'delete', name, { management: t.spec?.management });
    return send(res, 202, { name });
  }
  if (sub === 'credentials' && method === 'GET') {
    await getTenant(name);
    const c = await secretData(`${name}-credentials`);
    audit(user, 'view-credentials', name);
    return send(res, 200, {
      grafana: { url: process.env.GRAFANA_PUBLIC_URL ?? 'http://10.30.30.204:30300', user: c['grafana-user'], password: c['grafana-password'] },
      s3: { endpoint: c['s3-endpoint'], accessKey: c['s3-access-key'], secretKey: c['s3-secret-key'] },
    });
  }
  if (sub === 'kubeconfig' && method === 'GET') {
    await getTenant(name);
    const k = await secretData(`${name}-kubeconfig`);
    if (!k.config) throw new HttpErr(404, 'kubeconfig not published yet');
    audit(user, 'download-kubeconfig', name);
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': 'application/yaml', 'Content-Disposition': `attachment; filename="${name}.kubeconfig"` });
    return void res.end(k.config);
  }
  throw new HttpErr(405, 'method not allowed');
}

async function staticFile(res: ServerResponse, path: string): Promise<void> {
  const rel = path === '/' ? 'index.html' : normalize(path).replace(/^(\.\.(\/|\\|$))+/, '').replace(/^\/+/, '');
  if (!/^[a-z0-9-]+\.(html|js|css|svg)$/.test(rel)) return send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  try {
    const data = await readFile(join(STATIC, rel));
    res.writeHead(200, { ...SECURITY_HEADERS, 'Content-Type': TYPES[extname(rel)] ?? 'application/octet-stream' });
    res.end(data);
  } catch {
    send(res, 404, 'not found', { 'Content-Type': 'text/plain' });
  }
}

const server = createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname;
  try {
    if (path === '/healthz') return send(res, 200, { ok: true });
    if (path.startsWith('/api/')) return await api(req, res, path);
    if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
    return await staticFile(res, path);
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.status, { error: e.message });
    if (e instanceof Invalid) return send(res, 400, { error: e.message });
    if (isNotFound(e)) return send(res, 404, { error: 'not found' });
    console.error(JSON.stringify({ ts: new Date().toISOString(), error: e instanceof Error ? e.message : String(e), path }));
    return send(res, 500, { error: 'internal error' });
  }
});

server.listen(PORT, () => console.log(JSON.stringify({ ts: new Date().toISOString(), msg: 'tenant UI listening', port: PORT, static: STATIC })));
