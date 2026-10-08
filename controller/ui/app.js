// midori tenant UI. Plain ES module, no build step, no dependencies.
// Every server value goes into the page as text (textContent), never as
// HTML, so a tenant name or message cannot inject markup.

const $ = (sel) => document.querySelector(sel);
const A6000_MIB = 46068;
const REFRESH_MS = 5000;

// ---------- helpers ----------------------------------------------------------

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    // Through the CSSOM: the page's CSP (style-src 'self') blocks style
    // ATTRIBUTES, so setAttribute('style', ...) would silently do nothing.
    else if (k === 'style') el.style.cssText = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === undefined || c === null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

class ApiError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

async function api(method, path, body) {
  const headers = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-Tenant-UI'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin' });
  const data = await r.json().catch(() => ({}));
  if (r.status === 401 && path !== '/api/login') { showLogin(); throw new ApiError(401, 'not logged in'); }
  if (!r.ok) throw new ApiError(r.status, data.error || `HTTP ${r.status}`);
  return data;
}

// Kubernetes quantity -> number (cores / bytes).
function qty(q) {
  const m = /^([0-9.]+)([a-zA-Z]*)$/.exec(String(q ?? '0').trim());
  if (!m) return 0;
  const mult = { '': 1, m: 1e-3, k: 1e3, M: 1e6, G: 1e9, T: 1e12, Ki: 1024, Mi: 1024 ** 2, Gi: 1024 ** 3, Ti: 1024 ** 4 };
  return Number(m[1]) * (mult[m[2]] ?? 1);
}
const gib = (bytes) => `${(bytes / 1024 ** 3).toFixed(bytes >= 10 * 1024 ** 3 ? 0 : 1)} GiB`;
const cores = (n) => (n >= 10 || Number.isInteger(n) ? String(Math.round(n * 10) / 10) : n.toFixed(1));
const fmt = (kind, v) => kind === 'memory' ? gib(v) : kind === 'mib' ? gib(v * 1024 ** 2) : kind === 'cpu' ? cores(v) : String(Math.round(v));

function bar(used, quota, cap) {
  const b = h('div', { class: 'bar' });
  if (cap > 0 && quota !== undefined) b.append(h('span', { class: 'q', style: `width:${Math.min(quota / cap, 1) * 100}%` }));
  const ratio = cap > 0 ? used / cap : 0;
  if (ratio >= 1) b.classList.add('over'); else if (ratio >= 0.85) b.classList.add('hot');
  b.append(h('span', { class: 'u', style: `width:${Math.min(ratio, 1) * 100}%` }));
  return b;
}

const PHASE = { Ready: 'ok', Observing: 'info', Degraded: 'bad', Blocked: 'warn', Deleting: 'warn' };
function statusChips(t) {
  const phase = t.deleting ? (t.status.phase || 'Deleting') : (t.status.phase || 'Pending');
  const chips = [
    h('span', { class: `chip ${PHASE[phase] || ''}`, text: phase }),
    h('span', { class: `chip ${t.spec.management === 'Manage' ? '' : 'info'}`, text: t.spec.management }),
  ];
  const drift = t.status.driftCount || 0;
  if (drift) chips.push(h('span', { class: 'chip warn', text: `${drift} drift` }));
  return chips;
}

// ---------- state --------------------------------------------------------------

let data = { tenants: [], capacity: {} };
let openTenant = null;      // name shown in the detail drawer
let revealed = null;        // credentials fetched for openTenant
let timer = null;

// ---------- login ----------------------------------------------------------------

function showLogin() {
  clearInterval(timer);
  $('#app-view').hidden = true;
  $('#who').hidden = true;
  $('#login-view').hidden = false;
  for (const d of document.querySelectorAll('dialog[open]')) d.close();
  $('#login-form [name=user]').focus();
}

async function showApp(user) {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#who').hidden = false;
  $('#who-name').textContent = user;
  await refresh();
  clearInterval(timer);
  timer = setInterval(() => refresh().catch(() => {}), REFRESH_MS);
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const r = await api('POST', '/api/login', { user: f.get('user'), password: f.get('password') });
    e.target.reset();
    await showApp(r.user);
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});

$('#logout').addEventListener('click', async () => {
  await api('POST', '/api/logout').catch(() => {});
  showLogin();
});

// ---------- overview ---------------------------------------------------------------

async function refresh() {
  data = await api('GET', '/api/overview');
  renderCapacity();
  renderTenants();
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()} · refreshes every ${REFRESH_MS / 1000} s`;
  if (openTenant && $('#detail').open) {
    const t = data.tenants.find((x) => x.name === openTenant);
    if (t) renderDetail(t); else $('#detail').close();
  }
}

function renderCapacity() {
  const c = data.capacity;
  // "Requested" is quota accounting (what pods asked for), not measured
  // use -- measured use is Grafana's job.
  const cards = [
    ['GPUs', c.gpus, 'count', 'cards', null],
    ['GPU memory', c.gpuMemoryMiB, 'mib', '', 'Pods that take whole cards request no GPU memory and are not counted here.'],
    ['CPU requests', c.cpu, 'cpu', 'cores', null],
    ['Memory requests (DRAM)', c.memory, 'memory', '', null],
  ].filter(([, line]) => line);
  $('#capacity').replaceChildren(...cards.map(([title, l, kind, unit, note]) => {
    const over = l.overcommit !== null && l.overcommit > 1;
    return h('div', { class: 'card cap' },
      h('h3', { text: title }),
      h('div', { class: 'big' }, `${fmt(kind, l.used)} `, h('span', { class: 'muted', text: `/ ${fmt(kind, l.capacity)} ${unit}`.trim() })),
      h('div', { class: 'sub' }, 'requested · quotas total ', h('strong', { text: fmt(kind, l.quota) }),
        l.overcommit !== null ? ` (${Math.round(l.overcommit * 100)}% of capacity)` : '',
        over ? h('span', { class: 'chip warn', style: 'margin-left:.4rem', text: 'overcommitted' }) : null),
      bar(l.used, l.quota, l.capacity),
      note ? h('p', { class: 'muted note-small', text: note }) : null);
  }));
}

function miniQuota(line, kind) {
  if (!line) return h('span', { class: 'muted', text: '—' });
  const used = kind === 'count' ? Number(line.used) : qty(line.used);
  const hard = kind === 'count' ? Number(line.hard) : qty(line.hard);
  return h('div', { class: 'mini' },
    h('div', { class: 'nums' }, fmt(kind, used), h('span', { class: 'muted', text: ` / ${fmt(kind, hard)}` })),
    bar(used, undefined, hard));
}

function renderTenants() {
  const rows = data.tenants.map((t) => h('tr', { onclick: () => openDetail(t.name), tabindex: 0, onkeydown: (e) => { if (e.key === 'Enter') openDetail(t.name); } },
    h('td', {}, h('div', { class: 'name', text: t.name }), h('small', { class: 'muted', text: t.spec.controlPlane.size === 'large' ? 'large control plane' : '' })),
    h('td', {}, h('div', { class: 'chips' }, statusChips(t))),
    h('td', {}, miniQuota(t.quota['requests.nvidia.com/gpu'], 'count')),
    h('td', {}, miniQuota(t.quota['requests.cpu'], 'cpu')),
    h('td', {}, miniQuota(t.quota['requests.memory'], 'memory')),
    h('td', {}, h('span', { class: `chip ${t.spec.network.internet ? 'info' : ''}`, text: t.spec.network.internet ? 'internet' : 'isolated' })),
    h('td', {}, h('span', { class: 'mono', text: t.status.apiEndpoint || '—' })),
    h('td', {}, h('button', { class: 'link', type: 'button', text: 'Open ›', onclick: (e) => { e.stopPropagation(); openDetail(t.name); } })),
  ));
  $('#tenant-rows').replaceChildren(...rows);
  $('#no-tenants').hidden = data.tenants.length > 0;
}

// ---------- detail -------------------------------------------------------------------

const QUOTA_ORDER = [
  ['requests.nvidia.com/gpu', 'GPUs', 'count'], ['requests.nvidia.com/gpumem', 'GPU memory', 'mib'],
  ['requests.cpu', 'CPU requests', 'cpu'], ['limits.cpu', 'CPU limits', 'cpu'],
  ['requests.memory', 'Memory requests', 'memory'], ['limits.memory', 'Memory limits', 'memory'],
  ['pods', 'Pods', 'count'], ['persistentvolumeclaims', 'PVCs', 'count'],
];

function openDetail(name) {
  if (openTenant !== name) revealed = null;
  openTenant = name;
  const t = data.tenants.find((x) => x.name === name);
  if (!t) return;
  renderDetail(t);
  if (!$('#detail').open) $('#detail').showModal();
}

function renderDetail(t) {
  $('#detail-title').textContent = t.name;
  $('#detail-chips').replaceChildren(...statusChips(t));
  const s = t.spec;
  const kv = (pairs) => h('dl', { class: 'kv' }, pairs.flatMap(([k, v]) => [h('dt', { text: k }), h('dd', {}, v)]));
  const quota = QUOTA_ORDER.filter(([k]) => t.quota[k]).map(([k, label, kind]) => {
    const l = t.quota[k];
    const used = kind === 'count' || kind === 'mib' ? Number(l.used) : qty(l.used);
    const hard = kind === 'count' || kind === 'mib' ? Number(qty(l.hard)) : qty(l.hard);
    return h('div', { class: 'qline' },
      h('div', { class: 'label' }, h('span', { text: label }), h('span', { class: 'mono', text: `${fmt(kind, used)} / ${fmt(kind, hard)}` })),
      bar(used, undefined, hard));
  });
  const conds = (t.status.conditions || []).map((c) => h('li', {},
    h('span', { class: `chip ${c.status === 'True' ? 'ok' : c.reason === 'Error' ? 'bad' : 'warn'}`, text: c.type.replace(/Ready$/, '') }),
    h('span', { class: 'msg', text: `${c.reason}: ${c.message}` })));
  const drift = (t.status.drift || []).map((d) => h('li', { class: 'drift' },
    h('span', { class: 'chip warn', text: d.change }), ' ', h('span', { class: 'mono', text: d.object }),
    d.paths && d.paths.length ? h('div', { class: 'muted mono', text: d.paths.join('  ') }) : null));

  const body = [
    t.deleting ? h('p', { class: 'note', text: 'This tenant is being deleted.' }) : null,
    kv([
      ['API', h('span', { class: 'mono', text: t.status.apiEndpoint || 'not yet' })],
      ['Mode', s.management === 'Manage' ? 'Manage — the controller applies this spec' : 'Observe — drift is reported, nothing is changed'],
      ['Network', s.network.internet ? 'public internet (private ranges blocked)' : 'isolated (no internet)'],
      ['Control plane', s.controlPlane.size === 'large' ? 'large (4 CPU / 4 GiB)' : 'small (1 CPU / 1 GiB)'],
      ['Gateway', s.gateway.expose ? 'exposed outside the cluster' : 'not exposed'],
      ['Grafana', `org ${t.status.grafana?.org ?? '—'}, dashboards: ${s.observability.dashboards.join(', ')}`],
      ['S3 gateway', s.s3.enabled ? 'key issued' : 'disabled'],
      ['Created', t.created ? new Date(t.created).toLocaleString() : '—'],
    ]),
    h('h3', { text: 'Quota' }),
    h('p', { class: 'muted', text: 'CPU and memory are cores and DRAM on the GPU nodes; GPU memory is separate.' }),
    h('div', { class: 'qlist' }, quota),
    h('h3', { text: 'Conditions' }),
    conds.length ? h('ul', { class: 'conds' }, conds) : h('p', { class: 'muted', text: 'Not reconciled yet.' }),
    drift.length ? [h('h3', { text: 'Drift' }), h('p', { class: 'muted', text: s.management === 'Observe' ? 'What applying the spec would change.' : 'Changed behind the controller; restored on its next pass.' }), h('ul', { class: 'conds' }, drift)] : null,
    h('h3', { text: 'Hand over' }),
    handover(t),
    h('div', { class: 'toolbar' },
      h('button', { class: 'primary', type: 'button', text: 'Edit', disabled: t.deleting, onclick: () => openEditor(t) }),
      h('button', { class: 'ghost', type: 'button', disabled: t.deleting, text: s.management === 'Manage' ? 'Switch to Observe' : 'Switch to Manage', onclick: () => switchMode(t) })),
    h('div', { class: 'danger-zone' },
      h('div', {}, h('strong', { text: 'Delete tenant' }), h('div', { class: 'muted', text: s.management === 'Manage' ? 'Destroys its control plane and all its data.' : 'In Observe: stops managing it and leaves the tenant as it is.' })),
      h('button', { class: 'danger', type: 'button', text: 'Delete…', disabled: t.deleting, onclick: () => openDeleter(t) })),
  ];
  $('#detail-body').replaceChildren(...body.flat().filter(Boolean));
}

function copyField(label, value) {
  const input = h('input', { value: value ?? '', readonly: true, 'aria-label': label });
  const btn = h('button', { class: 'ghost', type: 'button', text: 'Copy', onclick: async () => {
    // navigator.clipboard needs a secure context (HTTPS or localhost); fall
    // back to selecting the text for this plain-HTTP page.
    try { await navigator.clipboard.writeText(input.value); btn.textContent = 'Copied'; }
    catch { input.select(); const ok = document.execCommand && document.execCommand('copy'); btn.textContent = ok ? 'Copied' : 'Select + ⌘C'; }
    setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
  } });
  return [h('dt', { text: label }), h('dd', {}, h('div', { class: 'secret' }, input, btn))];
}

function handover(t) {
  const box = h('div', {});
  const download = h('a', { href: `/api/tenants/${encodeURIComponent(t.name)}/kubeconfig`, download: `${t.name}.kubeconfig` }, 'Download kubeconfig');
  if (!revealed) {
    box.append(h('p', { class: 'muted', text: 'The tenant’s kubeconfig, Grafana login and S3 key. Viewing them is recorded in the audit log.' }),
      h('div', { class: 'toolbar' }, h('button', { class: 'ghost', type: 'button', text: 'Show credentials', onclick: async () => {
        try { revealed = await api('GET', `/api/tenants/${encodeURIComponent(t.name)}/credentials`); renderDetail(t); }
        catch (e) { box.append(h('p', { class: 'error', text: e.message })); }
      } }), download));
    return box;
  }
  box.append(h('dl', { class: 'kv' },
    copyField('Grafana URL', revealed.grafana.url), copyField('Grafana user', revealed.grafana.user), copyField('Grafana password', revealed.grafana.password),
    copyField('S3 endpoint', revealed.s3.endpoint), copyField('S3 access key', revealed.s3.accessKey), copyField('S3 secret key', revealed.s3.secretKey)),
  h('div', { class: 'toolbar' }, download, h('button', { class: 'link', type: 'button', text: 'Hide', onclick: () => { revealed = null; renderDetail(t); } })));
  return box;
}

async function switchMode(t) {
  const spec = structuredClone(t.spec);
  spec.management = spec.management === 'Manage' ? 'Observe' : 'Manage';
  try { await api('PUT', `/api/tenants/${encodeURIComponent(t.name)}`, { spec }); await refresh(); }
  catch (e) { alert(e.message); }
}

// ---------- editor ----------------------------------------------------------------------

let editing = null;      // tenant name being edited, or null for create
let memTouched = false;  // has the user typed a GPU memory value themselves

function gpuHint() {
  const f = $('#editor-form');
  const mib = Number(f.gpuMemoryMiB.value || 0);
  $('#gpumem-hint').textContent = `= ${(mib / A6000_MIB).toFixed(2).replace(/\.00$/, '')} × RTX A6000 (${A6000_MIB} MiB each). Pods without a GPU memory limit take whole cards.`;
}

function openEditor(t) {
  const f = $('#editor-form');
  f.reset();
  editing = t ? t.name : null;
  memTouched = !!t;
  $('#editor-error').textContent = '';
  $('#editor-title').textContent = t ? `Edit ${t.name}` : 'New tenant';
  $('#editor-submit').textContent = t ? 'Save changes' : 'Create tenant';
  f.name.disabled = !!t;
  $('#name-field').hidden = !!t;
  if (t) {
    const s = t.spec, q = s.quota;
    f.gpus.value = q.gpus; f.gpuMemoryMiB.value = q.gpuMemoryMiB;
    f.cpuRequests.value = q.cpu?.requests ?? ''; f.cpuLimits.value = q.cpu?.limits ?? '';
    f.memRequests.value = q.memory?.requests ?? ''; f.memLimits.value = q.memory?.limits ?? '';
    f.pods.value = q.pods ?? ''; f.pvcs.value = q.persistentVolumeClaims ?? '';
    f.internet.checked = s.network.internet; f.large.checked = s.controlPlane.size === 'large';
    f.gateway.checked = s.gateway.expose; f.serving.checked = s.observability.dashboards.includes('serving');
    f.s3.checked = s.s3.enabled; f.management.value = s.management;
  }
  gpuHint();
  $('#editor').showModal();
  (t ? f.gpus : f.name).focus();
}

$('#new-tenant').addEventListener('click', () => openEditor(null));
$('#editor-form').gpus.addEventListener('input', (e) => {
  if (!memTouched) e.target.form.gpuMemoryMiB.value = Number(e.target.value || 0) * A6000_MIB;
  gpuHint();
});
$('#editor-form').gpuMemoryMiB.addEventListener('input', () => { memTouched = true; gpuHint(); });

$('#editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const spec = {
    management: f.management.value,
    quota: {
      gpus: f.gpus.value, gpuMemoryMiB: f.gpuMemoryMiB.value,
      cpu: { requests: f.cpuRequests.value, limits: f.cpuLimits.value },
      memory: { requests: f.memRequests.value, limits: f.memLimits.value },
      pods: f.pods.value, persistentVolumeClaims: f.pvcs.value,
    },
    network: { internet: f.internet.checked },
    controlPlane: { size: f.large.checked ? 'large' : 'small' },
    s3: { enabled: f.s3.checked },
    gateway: { expose: f.gateway.checked },
    observability: { dashboards: f.serving.checked ? ['overview', 'serving'] : ['overview'] },
  };
  const btn = $('#editor-submit');
  btn.disabled = true;
  $('#editor-error').textContent = '';
  try {
    if (editing) await api('PUT', `/api/tenants/${encodeURIComponent(editing)}`, { spec });
    else await api('POST', '/api/tenants', { name: f.name.value.trim(), spec });
    const name = editing ?? f.name.value.trim();
    $('#editor').close();
    await refresh();
    openDetail(name);
  } catch (err) {
    $('#editor-error').textContent = err.message;
  } finally {
    btn.disabled = false;
  }
});

// ---------- delete -------------------------------------------------------------------------

let deleting = null;

function openDeleter(t) {
  deleting = t.name;
  const f = $('#deleter-form');
  f.reset();
  $('#deleter-error').textContent = '';
  $('#deleter-name').textContent = t.name;
  $('#deleter-submit').disabled = true;
  $('#deleter-text').textContent = t.spec.management === 'Manage'
    ? `This destroys ${t.name}'s vCluster, its namespace and volumes, its Grafana org and user, and its S3 key. It cannot be undone.`
    : `${t.name} is in Observe: only the Tenant object is removed and the tenant itself is left exactly as it is.`;
  $('#deleter').showModal();
  f.confirm.focus();
}

$('#deleter-form').confirm.addEventListener('input', (e) => { $('#deleter-submit').disabled = e.target.value !== deleting; });
$('#deleter-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('DELETE', `/api/tenants/${encodeURIComponent(deleting)}`, { confirm: e.target.confirm.value });
    $('#deleter').close();
    await refresh();
  } catch (err) {
    $('#deleter-error').textContent = err.message;
  }
});

// ---------- dialogs ------------------------------------------------------------------------

for (const btn of document.querySelectorAll('[data-close]')) btn.addEventListener('click', () => btn.closest('dialog').close());
$('#detail').addEventListener('close', () => { openTenant = null; revealed = null; });

// ---------- start ----------------------------------------------------------------------------

api('GET', '/api/me').then((r) => showApp(r.user)).catch(() => showLogin());
