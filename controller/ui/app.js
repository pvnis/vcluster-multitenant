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

// Each tenant keeps one colour: slots of the validated categorical palette
// (--series-1..8) in CREATION order, so a new tenant takes the next colour and
// existing ones never repaint. Past eight, tenants share the neutral slot.
function tenantColour(name) {
  const order = [...data.tenants].sort((a, b) => String(a.created).localeCompare(String(b.created)) || a.name.localeCompare(b.name));
  const i = order.findIndex((t) => t.name === name);
  return i >= 0 && i < 8 ? `var(--series-${i + 1})` : 'var(--series-other)';
}
const swatch = (name) => h('span', { class: 'swatch', style: `background:${tenantColour(name)}` });

// What the page leads with: how much of each resource has been PROMISED to
// tenants (their quotas) against what the GPU nodes have, divided by tenant.
// What pods request right now is shown beneath, secondary.
const RESOURCES = [
  { key: 'requests.nvidia.com/gpu', cap: 'gpus', label: 'GPU attachments', kind: 'count', unit: 'cards',
    capacityOf: (c) => c.cards,
    note: (c) => `Against the ${c.cards} cards: the worst case, every attachment a whole card. Sharing fits up to ${c.cards ? Math.round(c.gpus.capacity / c.cards) : 10} pods on a card.` },
  { key: 'requests.nvidia.com/gpumem', cap: 'gpuMemoryMiB', label: 'GPU memory', kind: 'mib', unit: '', held: true },
  { key: 'requests.nvidia.com/gpucores', cap: 'gpuCores', label: 'GPU time', kind: 'count', unit: '(100 = one card)', optional: true,
    note: () => 'A weight, not a cap: idle time goes to whoever is busy.' },
  { key: 'requests.cpu', cap: 'cpu', label: 'CPU', kind: 'cpu', unit: 'cores' },
  { key: 'requests.memory', cap: 'memory', label: 'Memory (DRAM)', kind: 'memory', unit: '' },
];

const amount = (_kind, raw) => qty(raw);

const pctOf = (v, cap) => `${cap > 0 ? Math.round((v / cap) * 100) : 0}% of capacity`;

function renderCapacity() {
  const c = data.capacity;
  const gm = data.gpuMemory ?? { available: false, heldByTenant: {}, heldMiB: 0, usedMiB: null };
  const rows = RESOURCES.map((r) => {
    const capacity = r.capacityOf ? r.capacityOf(c) : c[r.cap]?.capacity ?? 0;
    const shares = data.tenants.map((t) => ({ t, line: t.quota[r.key] })).filter((x) => x.line);
    const unlimited = r.optional ? data.tenants.filter((t) => !t.quota[r.key]).map((t) => t.name) : [];
    const committed = shares.reduce((a, x) => a + amount(r.kind, x.line.hard), 0);
    const requested = shares.reduce((a, x) => a + amount(r.kind, x.line.used), 0);
    const ratio = capacity > 0 ? committed / capacity : null;
    const over = ratio !== null && ratio > 1;
    const scale = Math.max(capacity, committed) || 1;
    const unitText = r.unit ? ` ${r.unit}` : '';

    const stack = h('div', { class: 'stack', role: 'img', 'aria-label': `${r.label}: ${fmt(r.kind, committed)} committed of ${fmt(r.kind, capacity)}` },
      shares.filter((x) => amount(r.kind, x.line.hard) > 0).map((x) => {
        const v = amount(r.kind, x.line.hard), used = amount(r.kind, x.line.used);
        const seg = h('span', { class: 'seg', tabindex: 0, style: `width:${(v / scale) * 100}%;background:${tenantColour(x.t.name)}` });
        const now = r.held && gm.available ? `holds now ${fmt('mib', gm.heldByTenant[x.t.name] ?? 0)}` : `requested now ${fmt(r.kind, used)}`;
        const tip = [`${x.t.name}`, `quota ${fmt(r.kind, v)}${unitText}`, now, capacity ? `${Math.round((v / capacity) * 100)}% of capacity` : ''];
        seg.addEventListener('mouseenter', (e) => showTip(e, tip));
        seg.addEventListener('mousemove', moveTip);
        seg.addEventListener('mouseleave', hideTip);
        seg.addEventListener('focus', (e) => showTip(e, tip));
        seg.addEventListener('blur', hideTip);
        return seg;
      }),
      capacity > 0 ? h('span', { class: 'cap-mark', style: `left:${(capacity / scale) * 100}%`, title: 'capacity' }) : null);

    if (r.optional && shares.length === 0) {
      return h('div', { class: 'commit-row' },
        h('div', { class: 'commit-head' }, h('h3', { text: r.label }),
          h('div', { class: 'commit-figure muted', text: 'no tenant has a limit' })),
        h('div', { class: 'requested muted' }, `Unlimited for every tenant (${unlimited.join(', ')}). Set quota.gpuCores to bound it.`,
          r.note ? h('span', { text: ` — ${r.note(c)}` }) : null));
    }
    // The capacity label must stay inside the card: right-aligned near the end.
    const capPos = capacity > 0 ? (capacity / scale) * 100 : 0;
    const capLabelStyle = `left:${capPos}%;transform:translateX(${capPos > 90 ? '-100%' : capPos < 10 ? '0' : '-50%'})`;
    return h('div', { class: 'commit-row' },
      h('div', { class: 'commit-head' },
        h('h3', { text: r.label }),
        h('div', { class: 'commit-figure' },
          h('strong', { text: fmt(r.kind, committed) }),
          h('span', { class: 'muted', text: ` committed of ${fmt(r.kind, capacity)}${unitText}` }),
          ratio !== null ? h('span', { class: 'pct', text: ` · ${Math.round(ratio * 100)}%` }) : null,
          over ? h('span', { class: 'chip warn', text: '▲ overcommitted' }) : null)),
      stack,
      h('div', { class: 'stack-scale muted' }, capPos > 10 ? h('span', { text: '0' }) : null, capacity > 0 ? h('span', { class: 'cap-label', style: capLabelStyle, text: 'capacity' }) : null),
      h('div', { class: 'breakdown' },
        shares.map((x) => h('span', { class: 'who' }, swatch(x.t.name), `${x.t.name} `, h('strong', { text: fmt(r.kind, amount(r.kind, x.line.hard)) }),
          r.held && gm.available ? h('span', { class: 'muted', text: ` · holds ${fmt('mib', gm.heldByTenant[x.t.name] ?? 0)}` }) : null)),
        unlimited.length ? h('span', { class: 'who muted', text: `no limit: ${unlimited.join(', ')}` }) : null),
      r.held && gm.available
        ? h('div', { class: 'requested muted' },
            'Held now: ', h('strong', { text: fmt('mib', gm.heldMiB) }), ` (${pctOf(gm.heldMiB, capacity)})`,
            ' — slices at their request, whole-GPU pods at a full card each',
            gm.usedMiB !== null ? [' · in use on the cards: ', h('strong', { text: fmt('mib', gm.usedMiB) }), ` (${pctOf(gm.usedMiB, capacity)}, measured)`] : null)
        : h('div', { class: 'requested muted' },
            `Requested now: ${fmt(r.kind, requested)}${unitText}`,
            capacity > 0 ? ` (${pctOf(requested, capacity)})` : '',
            r.held ? ' — held/used figures unavailable: Prometheus unreachable' : '',
            r.note ? h('span', { text: ` — ${r.note(c)}` }) : null));
  });
  $('#capacity').replaceChildren(
    h('div', { class: 'card commit' },
      h('div', { class: 'section-head' },
        h('div', {}, h('h2', { text: 'Quota commitment' }),
          h('p', { class: 'muted', text: 'What the tenants have been promised (their quotas), against what the GPU nodes have. Requests by running pods are shown beneath each bar.' }))),
      rows));
}

// One tooltip element for every segment.
const tipEl = h('div', { class: 'tip', role: 'tooltip', hidden: true });
document.body.append(tipEl);
function showTip(e, lines) {
  tipEl.replaceChildren(...lines.filter(Boolean).map((l, i) => h('div', { class: i === 0 ? 'tip-title' : '', text: l })));
  tipEl.hidden = false;
  moveTip(e);
}
function moveTip(e) {
  const r = e.target.getBoundingClientRect();
  const x = e.clientX ?? r.left + r.width / 2, y = e.clientY ?? r.top;
  tipEl.style.left = `${Math.min(x + 12, window.innerWidth - tipEl.offsetWidth - 8)}px`;
  tipEl.style.top = `${y + 14}px`;
}
function hideTip() { tipEl.hidden = true; }

function miniQuota(line, kind, unit = '', held) {
  if (!line) return h('span', { class: 'muted', text: '—' });
  // GPU memory: what the tenant HOLDS, whole cards at a full card, including
  // pods admitted before the webhook made whole cards declare their memory.
  const used = held !== undefined ? held : qty(line.used), hard = qty(line.hard);
  const verb = held !== undefined ? 'holds' : 'requested';
  const u = hard === 1 ? unit.replace(/s$/, '') : unit;  // "1 GPU", "2 GPUs"
  return h('div', { class: 'mini' },
    h('div', { class: 'nums' }, h('strong', { text: `${fmt(kind, hard)}${u}` })),
    h('div', { class: 'muted used', text: `${verb} ${fmt(kind, used)}${hard > 0 ? ` · ${Math.round((used / hard) * 100)}%` : ''}` }),
    bar(used, undefined, hard));
}

function renderTenants() {
  const rows = data.tenants.map((t) => h('tr', { onclick: () => openDetail(t.name), tabindex: 0, title: `Open ${t.name}`, 'aria-label': `Open ${t.name}`, onkeydown: (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(t.name); } } },
    h('td', {}, h('div', { class: 'name' }, swatch(t.name), t.name), h('small', { class: 'muted', text: t.spec.controlPlane.size === 'large' ? 'large control plane' : '' })),
    h('td', {}, h('div', { class: 'chips' }, statusChips(t))),
    h('td', {}, miniQuota(t.quota['requests.nvidia.com/gpu'], 'count', ' GPUs')),
    h('td', {}, miniQuota(t.quota['requests.nvidia.com/gpumem'], 'mib', '', data.gpuMemory?.available ? (data.gpuMemory.heldByTenant[t.name] ?? 0) : undefined)),
    h('td', {}, miniQuota(t.quota['requests.cpu'], 'cpu', ' cores')),
    h('td', {}, miniQuota(t.quota['requests.memory'], 'memory')),
    h('td', {}, h('span', { class: `chip ${t.spec.network.internet ? 'info' : ''}`, text: t.spec.network.internet ? 'internet' : 'isolated' })),
    h('td', {}, h('span', { class: 'mono', text: t.status.apiEndpoint || '—' })),
  ));
  $('#tenant-rows').replaceChildren(...rows);
  $('#no-tenants').hidden = data.tenants.length > 0;
}

// ---------- detail -------------------------------------------------------------------

const QUOTA_ORDER = [
  ['requests.nvidia.com/gpu', 'GPU attachments', 'count'], ['requests.nvidia.com/gpumem', 'GPU memory', 'mib'],
  ['requests.nvidia.com/gpucores', 'GPU time (100 = one card)', 'count'],
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
  $('#gpumem-hint').textContent = `GPU memory = ${(mib / A6000_MIB).toFixed(2).replace(/\.00$/, '')} × RTX A6000 (${A6000_MIB} MiB each). A pod with no GPU memory limit takes whole cards and is charged ${A6000_MIB} MiB for each.`;
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
    f.gpus.value = q.gpus; f.gpuMemoryMiB.value = q.gpuMemoryMiB; f.gpuCores.value = q.gpuCores ?? '';
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
  // Until the user sets it: one card's memory per attachment, at most all four cards.
  if (!memTouched) e.target.form.gpuMemoryMiB.value = Math.min(Number(e.target.value || 0), 4) * A6000_MIB;
  gpuHint();
});
$('#editor-form').gpuMemoryMiB.addEventListener('input', () => { memTouched = true; gpuHint(); });

$('#editor-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  const spec = {
    management: f.management.value,
    quota: {
      gpus: f.gpus.value, gpuMemoryMiB: f.gpuMemoryMiB.value, gpuCores: f.gpuCores.value,
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
