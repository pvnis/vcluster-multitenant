// The tenant's Grafana org, user, datasources and dashboards (the logic of
// manifests/midori/observability/grafana-tenants.py), plus the admin org's
// Loki datasource, whose tenant list spans every Tenant.
//
// A tenant org's Prometheus is its prom-label-proxy and its Loki sends only
// its own X-Scope-OrgID. Its user is an org Editor and a member of nothing
// else: an org Admin could edit datasources and aim them anywhere.

import type { V1Secret } from '@kubernetes/client-node';
import { stringify } from 'yaml';
import type { Kube } from '../kube.ts';
import type { Templates } from '../templates.ts';
import type { ComponentResult, Drift, Tenant } from '../types.ts';
import { ensureCredentials, readCredentials } from './credentials.ts';

const GRAFANA_URL = process.env.GRAFANA_URL ?? 'http://grafana.observability.svc.cluster.local';
const ADMIN_SECRET = { apiVersion: 'v1', kind: 'Secret', metadata: { name: 'grafana-admin', namespace: 'observability' } };

class Grafana {
  private readonly auth: string;
  constructor(auth: string) {
    this.auth = auth;
  }

  static async connect(kube: Kube): Promise<Grafana> {
    const s = await kube.read<V1Secret>(ADMIN_SECRET);
    const d = (k: string) => Buffer.from(s?.data?.[k] ?? '', 'base64').toString();
    return new Grafana('Basic ' + Buffer.from(`${d('admin-user')}:${d('admin-password')}`).toString('base64'));
  }

  async call(method: string, path: string, body?: unknown, org?: number): Promise<{ status: number; json: any }> {
    const headers: Record<string, string> = { Authorization: this.auth, 'Content-Type': 'application/json' };
    if (org !== undefined) headers['X-Grafana-Org-Id'] = String(org);
    const r = await fetch(GRAFANA_URL + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const text = await r.text();
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    return { status: r.status, json };
  }

  async ok(method: string, path: string, body?: unknown, org?: number): Promise<any> {
    const r = await this.call(method, path, body, org);
    if (r.status >= 300) throw new Error(`grafana ${method} ${path}: ${r.status} ${JSON.stringify(r.json).slice(0, 200)}`);
    return r.json;
  }
}

const datasources = (tenant: string) => [
  { name: 'Prometheus', uid: 'prom', type: 'prometheus', access: 'proxy', isDefault: true,
    url: `http://prom-proxy-${tenant}.observability.svc:8080` },
  { name: 'Loki', uid: 'loki', type: 'loki', access: 'proxy', url: 'http://loki.observability.svc:3100',
    jsonData: { httpHeaderName1: 'X-Scope-OrgID' } },
];

export async function reconcileGrafana(kube: Kube, templates: Templates, t: Tenant): Promise<ComponentResult> {
  const name = t.metadata!.name!;
  const g = await Grafana.connect(kube);
  const drift: Drift[] = [];
  const d = (object: string, change: Drift['change'], paths: string[] = []) => drift.push({ component: 'Grafana', object, change, paths });
  const boards = t.spec.observability.dashboards;

  const orgR = await g.call('GET', `/api/orgs/name/${encodeURIComponent(name)}`);
  let org: number | undefined = orgR.status === 200 ? orgR.json.id : undefined;

  if (t.spec.management === 'Observe') {
    if (!org) {
      d(`GrafanaOrg/${name}`, 'create');
      return result(drift, 'Observe');
    }
    for (const ds of datasources(name)) {
      const r = await g.call('GET', `/api/datasources/uid/${ds.uid}`, undefined, org);
      if (r.status !== 200) d(`GrafanaDatasource/${name}/${ds.uid}`, 'create');
      else if (r.json.url !== ds.url || r.json.type !== ds.type) d(`GrafanaDatasource/${name}/${ds.uid}`, 'update', ['url']);
    }
    const u = await g.call('GET', `/api/users/lookup?loginOrEmail=${encodeURIComponent(name)}`);
    if (u.status !== 200) d(`GrafanaUser/${name}`, 'create');
    else {
      const orgs = (await g.ok('GET', `/api/users/${u.json.id}/orgs`)) as { orgId: number; role: string }[];
      if (orgs.length !== 1 || orgs[0].orgId !== org || orgs[0].role !== 'Editor') d(`GrafanaUser/${name}`, 'update', ['memberships']);
    }
    for (const b of boards) {
      const r = await g.call('GET', `/api/dashboards/uid/tenant-${b}`, undefined, org);
      if (r.status !== 200) d(`GrafanaDashboard/${name}/tenant-${b}`, 'create');
    }
    if (!(await readCredentials(kube, name))?.grafanaPassword) d(`Secret/tenant-system/${name}-credentials`, 'create');
    return result(drift, 'Observe', { grafana: { org, user: name } });
  }

  // Manage.
  const creds = await ensureCredentials(kube, name);
  if (!org) org = (await g.ok('POST', '/api/orgs', { name })).orgId as number;
  for (const ds of datasources(name)) {
    const body = ds.uid === 'loki' ? { ...ds, secureJsonData: { httpHeaderValue1: name } } : ds;
    const r = await g.call('GET', `/api/datasources/uid/${ds.uid}`, undefined, org);
    if (r.status === 404) await g.ok('POST', '/api/datasources', body, org);
    else await g.ok('PUT', `/api/datasources/uid/${ds.uid}`, body, org);
  }
  const u = await g.call('GET', `/api/users/lookup?loginOrEmail=${encodeURIComponent(name)}`);
  let uid: number;
  if (u.status === 404) {
    uid = (await g.ok('POST', '/api/admin/users', { name, login: name, email: `${name}@midori.local`, password: creds.grafanaPassword, OrgId: org })).id;
  } else {
    uid = u.json.id;
    await g.ok('PUT', `/api/admin/users/${uid}/password`, { password: creds.grafanaPassword });
  }
  // Grafana 12 ignores OrgId above (auto_assign_org=false) and gives the
  // user a personal org as its Admin; add the real membership, switch to it,
  // and delete the personal org (its last Admin cannot be removed from it).
  const members = (await g.ok('GET', `/api/orgs/${org}/users`)) as { userId: number }[];
  if (members.some((m) => m.userId === uid)) await g.ok('PATCH', `/api/orgs/${org}/users/${uid}`, { role: 'Editor' });
  else await g.ok('POST', `/api/orgs/${org}/users`, { loginOrEmail: name, role: 'Editor' });
  await g.ok('POST', `/api/users/${uid}/using/${org}`);
  for (const m of (await g.ok('GET', `/api/users/${uid}/orgs`)) as { orgId: number; name: string }[]) {
    if (m.orgId === org) continue;
    if (m.name === `${name}@midori.local`) await g.ok('DELETE', `/api/orgs/${m.orgId}`);
    else await g.ok('DELETE', `/api/orgs/${m.orgId}/users/${uid}`);
  }
  const final = (await g.ok('GET', `/api/users/${uid}/orgs`)) as { orgId: number; role: string }[];
  if (final.length !== 1 || final[0].orgId !== org || final[0].role !== 'Editor') {
    throw new Error(`grafana user ${name} has unexpected memberships ${JSON.stringify(final)}`);
  }
  for (const b of boards) {
    await g.ok('POST', '/api/dashboards/db', { dashboard: templates.dashboard(b), overwrite: true }, org);
  }
  return result([], 'Manage', { grafana: { org, user: name } });
}

function result(drift: Drift[], mode: 'Observe' | 'Manage', status?: ComponentResult['status']): ComponentResult {
  return {
    drift,
    status,
    condition: {
      type: 'GrafanaReady',
      status: mode === 'Manage' || drift.length === 0 ? 'True' : 'False',
      reason: mode === 'Manage' ? 'Applied' : drift.length ? 'Drift' : 'InSync',
      message: mode === 'Manage' ? 'org, user (Editor, sole membership), datasources, dashboards' : drift.length ? `${drift.length} item(s) would change` : 'org, user, datasources and dashboards match',
    },
  };
}

export async function deleteGrafana(kube: Kube, name: string): Promise<void> {
  const g = await Grafana.connect(kube);
  const u = await g.call('GET', `/api/users/lookup?loginOrEmail=${encodeURIComponent(name)}`);
  if (u.status === 200) await g.ok('DELETE', `/api/admin/users/${u.json.id}`);
  const o = await g.call('GET', `/api/orgs/name/${encodeURIComponent(name)}`);
  if (o.status === 200) await g.ok('DELETE', `/api/orgs/${o.json.id}`);
}

// The admin org's "Loki (all tenants)" datasource sends
// X-Scope-OrgID: platform|<every tenant>. It is provisioned through Grafana's
// datasource sidecar from this Secret (label grafana_datasource), so adding a
// Tenant needs no edit to grafana-values.yaml. Covers every Tenant, Observe
// ones too: their logs already exist in Loki.
export async function reconcileAdminLoki(kube: Kube, tenants: string[]): Promise<void> {
  const header = ['platform', ...[...tenants].sort()].join('|');
  const provisioning = {
    apiVersion: 1,
    datasources: [{
      name: 'Loki (all tenants)', uid: 'loki', type: 'loki', orgId: 1, url: 'http://loki.observability.svc:3100',
      jsonData: { httpHeaderName1: 'X-Scope-OrgID' }, secureJsonData: { httpHeaderValue1: header },
    }],
  };
  await kube.apply({
    apiVersion: 'v1', kind: 'Secret',
    metadata: { name: 'grafana-datasource-loki-admin', namespace: 'observability', labels: { grafana_datasource: '1' } },
    type: 'Opaque',
    stringData: { 'loki-admin.yaml': stringify(provisioning) },
  } as V1Secret);
}
