// Admin dashboard (read-only). Hash routes:
//   #/                 overview: totals + one card per repo
//   #/repos/<id>       one repo: details + its jobs
//   #/jobs             all jobs (filter by repo/status)
//   #/jobs/<id>        job detail with live events over SSE
//
// SECURITY: prompts, logs, tool input/output and results are untrusted text (from repos and the model).
// Everything is rendered with textContent / createElement. Never use innerHTML here.

// Built from origin + path (never the full href): if the page was opened as https://user:pass@host/admin/,
// relative URLs would inherit the credentials and fetch() refuses those.
const API = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}api`;
const POLL_MS = 5000;
const STATUSES = ['queued', 'pulling', 'running', 'succeeded', 'failed', 'timeout'];

const view = document.getElementById('view');
const refreshEl = document.getElementById('refresh');
let pollTimer = null;
let eventSource = null;
let renderToken = 0;

// ---- tiny DOM helper (text only) ----
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'href') el.setAttribute('href', safeHref(v));
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
/** replaceChildren that skips null/false and flattens arrays (replaceChildren(null) would print "null"). */
function render(el, ...nodes) { el.replaceChildren(...nodes.flat().filter((n) => n !== null && n !== undefined && n !== false)); }
function safeHref(v) { const s = String(v); return s.startsWith('#/') ? s : '#/'; }
const enc = encodeURIComponent;

async function getJson(path) {
  const res = await fetch(`${API}${path}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) {
    let msg = `${res.status}`;
    try { msg = (await res.json()).error ?? msg; } catch { /* ignore */ }
    throw new Error(msg);
  }
  return res.json();
}

// ---- formatting ----
function badge(status) { return h('span', { class: `badge b-${status}` }, status.replace('_', ' ')); }
function ago(iso) {
  if (!iso) return '—';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(iso).toLocaleString();
}
function dur(ms) {
  if (ms === null || ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${Math.round(s % 60)}s`;
}
function money(v) { return v === null || v === undefined ? '—' : `$${Number(v).toFixed(4)}`; }
function upt(s) { return s < 3600 ? `${Math.round(s / 60)}m` : `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`; }
function stamp() { refreshEl.textContent = `updated ${new Date().toLocaleTimeString()}`; }
function setNav(name) {
  for (const a of document.querySelectorAll('[data-nav]')) a.classList.toggle('active', a.dataset.nav === name);
}
function showError(err) {
  render(view, h('p', { class: 'err' }, `Could not load: ${err.message}`));
}

// ---- views ----
async function overview(token) {
  setNav('overview');
  const [sum, repos] = await Promise.all([getJson('/summary'), getJson('/repos')]);
  if (token !== renderToken) return;
  const running = sum.running.length;
  render(view, 
    h('h1', null, 'Overview'),
    h('p', { class: 'muted' },
      `Up ${upt(sum.uptime_s)} · ${sum.repos} repo${sum.repos === 1 ? '' : 's'} · job history ${sum.persistence ? 'saved to disk' : 'in memory only (lost on restart)'}`),
    h('div', { class: 'stats' },
      stat('Running', `${running} / ${sum.max_concurrent}`),
      stat('Queued', sum.queued),
      stat('Succeeded (24h)', sum.last_24h.succeeded),
      stat('Failed (24h)', sum.last_24h.failed),
      stat('Timed out (24h)', sum.last_24h.timeout),
    ),
    h('h2', null, 'Repos'),
    h('div', { class: 'cards' }, repos.map(repoCard)),
  );
  stamp();
}
function stat(k, v) { return h('div', { class: 'stat' }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v)); }

function repoCard(r) {
  const ls = r.last_sync;
  return h('div', { class: 'card' },
    h('div', { class: 'head' },
      h('a', { href: `#/repos/${enc(r.id)}` }, r.id),
      h('span', { class: 'muted' }, r.default_branch),
      badge(r.health)),
    h('div', { class: 'muted mono' }, r.url_display),
    h('dl', null,
      h('dt', null, 'Last sync'),
      h('dd', null, ls ? `${ago(ls.at)} · ${ls.branch}${ls.commit ? ` @ ${ls.commit}` : ''} · ${dur(ls.duration_ms)}` : 'never'),
      ls && !ls.ok ? [h('dt', null, 'Sync error'), h('dd', { class: 'err' }, ls.error ?? 'unknown')] : null,
      h('dt', null, 'Workspace'),
      h('dd', null, r.cloned ? 'cloned' : 'not cloned yet'),
      h('dt', null, 'Now'),
      h('dd', null, r.running_job_id
        ? h('a', { href: `#/jobs/${enc(r.running_job_id)}` }, `running ${r.running_job_id.slice(0, 12)}…`)
        : 'idle', r.queued ? ` · ${r.queued} queued` : ''),
      h('dt', null, 'Last job'),
      h('dd', null, r.last_job
        ? [h('a', { href: `#/jobs/${enc(r.last_job.id)}` }, r.last_job.id.slice(0, 12) + '…'), ' ', badge(r.last_job.status), ' ', ago(r.last_job.created_at)]
        : '—'),
    ),
    h('div', { class: 'counts' }, STATUSES.filter((s) => r.counts[s]).map((s) => h('span', { class: `badge b-${s}` }, `${r.counts[s]} ${s}`))),
  );
}

async function repoView(token, id) {
  setNav('');
  const r = await getJson(`/repos/${enc(id)}`);
  if (token !== renderToken) return;
  const tableHost = h('div');
  render(view, 
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Overview'), ' / ', r.id),
    h('h1', null, r.id, ' ', badge(r.health)),
    h('div', { class: 'cards' }, repoCard(r),
      h('div', { class: 'card' }, h('dl', null,
        h('dt', null, 'Workspace dir'), h('dd', { class: 'mono' }, r.workspace_dir),
        h('dt', null, 'Default branch'), h('dd', null, r.default_branch),
        h('dt', null, 'Jobs in memory'), h('dd', null, Object.values(r.counts).reduce((a, b) => a + b, 0)),
      ))),
    h('h2', null, 'Jobs'),
    tableHost,
  );
  await jobTable(tableHost, { repo: id, fixedRepo: true }, token);
  stamp();
}

async function jobsView(token, params) {
  setNav('jobs');
  const host = h('div');
  render(view, h('h1', null, 'Jobs'), host);
  await jobTable(host, { repo: params.get('repo') ?? '', status: params.get('status') ?? '' }, token);
  stamp();
}

/** Filterable, pageable job table. Filters live in the hash so reload/back work. */
async function jobTable(host, opts, token) {
  const repos = opts.fixedRepo ? null : await getJson('/repos');
  if (token !== renderToken) return;
  const status = opts.status ?? '';
  const rows = h('tbody');
  const more = h('button', { onclick: () => load(more.dataset.next) }, 'Load more');
  more.hidden = true;

  const setFilter = (key, value) => {
    const p = new URLSearchParams(location.hash.split('?')[1] ?? '');
    if (value) p.set(key, value); else p.delete(key);
    const base = opts.fixedRepo ? `#/repos/${enc(opts.repo)}` : '#/jobs';
    location.hash = p.toString() ? `${base}?${p}` : base;
  };
  const toolbar = h('div', { class: 'toolbar' },
    repos ? h('select', { onchange: (e) => setFilter('repo', e.target.value), 'aria-label': 'Repo' },
      h('option', { value: '' }, 'All repos'),
      repos.map((r) => { const o = h('option', { value: r.id }, r.id); o.selected = r.id === opts.repo; return o; })) : null,
    h('select', { onchange: (e) => setFilter('status', e.target.value), 'aria-label': 'Status' },
      h('option', { value: '' }, 'Any status'),
      STATUSES.map((s) => { const o = h('option', { value: s }, s); o.selected = s === status; return o; })),
  );
  render(host, toolbar, h('table', null,
    h('thead', null, h('tr', null,
      ['Job', 'Status', opts.fixedRepo ? null : 'Repo', 'Branch', 'Commit', 'Created', 'Queue', 'Sync', 'Run', 'Cost', 'Turns', 'Prompt']
        .filter(Boolean).map((c) => h('th', null, c)))),
    rows), h('div', { class: 'toolbar' }, more));

  async function load(before) {
    const q = new URLSearchParams({ limit: '50' });
    if (opts.repo) q.set('repo', opts.repo);
    if (status) q.set('status', status);
    if (before) q.set('before', before);
    const page = await getJson(`/jobs?${q}`);
    if (!before && page.jobs.length === 0) {
      rows.append(h('tr', null, h('td', { colspan: 12, class: 'empty' }, 'No jobs yet.')));
    }
    for (const j of page.jobs) {
      rows.append(h('tr', null,
        h('td', { class: 'mono' }, h('a', { href: `#/jobs/${enc(j.id)}` }, j.id.slice(0, 12) + '…')),
        h('td', null, badge(j.status)),
        opts.fixedRepo ? null : h('td', null, h('a', { href: `#/repos/${enc(j.repo_id)}` }, j.repo_id)),
        h('td', null, j.branch),
        h('td', { class: 'mono' }, j.commit ?? '—'),
        h('td', { title: j.created_at }, ago(j.created_at)),
        h('td', { class: 'num' }, dur(j.queue_ms)),
        h('td', { class: 'num' }, dur(j.sync_ms)),
        h('td', { class: 'num' }, dur(j.run_ms)),
        h('td', { class: 'num' }, money(j.cost_usd)),
        h('td', { class: 'num' }, j.num_turns ?? '—'),
        h('td', { class: 'prompt', title: j.error_preview ?? j.prompt_preview }, j.prompt_preview),
      ));
    }
    more.hidden = !page.next;
    more.dataset.next = page.next ?? '';
  }
  await load(null);
}

async function jobView(token, id) {
  setNav('');
  const j = await getJson(`/jobs/${enc(id)}`);
  if (token !== renderToken) return;
  const terminal = ['succeeded', 'failed', 'timeout'].includes(j.status);
  const events = h('div', { class: 'events' });
  const liveTag = h('span', { class: 'live' }, terminal ? '' : '● live');

  const timeline = h('div', { class: 'timeline' }, j.history.map((s, i) => {
    const next = j.history[i + 1];
    return h('span', { class: 'step' }, badge(s.status),
      h('span', { class: 'muted', title: s.at }, new Date(s.at).toLocaleTimeString()),
      next ? h('span', { class: 'muted' }, `→ ${dur(Date.parse(next.at) - Date.parse(s.at))}`) : null);
  }));

  render(view, 
    h('div', { class: 'crumbs' }, h('a', { href: '#/' }, 'Overview'), ' / ',
      h('a', { href: `#/repos/${enc(j.repo_id)}` }, j.repo_id), ' / ', j.id),
    h('h1', null, h('span', { class: 'mono' }, j.id), ' ', badge(j.status)),
    h('p', { class: 'muted' }, `${j.repo_id} · ${j.branch}${j.commit ? ` @ ${j.commit}` : ''} · created ${ago(j.created_at)}`,
      j.claude ? ` · ${money(j.claude.total_cost_usd)} · ${j.claude.num_turns ?? '?'} turns` : ''),
    timeline,
    j.error ? [h('h2', null, 'Error'), h('pre', { class: 'box err' }, j.error)] : null,
    h('div', { class: 'grid2' },
      h('div', null, h('h2', null, 'Prompt'), h('pre', { class: 'box' }, j.prompt)),
      h('div', null, h('h2', null, 'Result'), h('pre', { class: 'box' }, j.result ?? (terminal ? '—' : '(not finished)')))),
    h('h2', null, 'Events', liveTag),
    events,
    h('h2', null, `Log (${j.log.length} lines)`),
    h('pre', { class: 'box' }, j.log.join('\n') || '—'),
  );
  stamp();

  // Live events (replays buffered history first, then streams until the result event).
  eventSource = new EventSource(`${API}/jobs/${enc(id)}/events`);
  const add = (type, data, seq) => {
    const atBottom = events.scrollHeight - events.scrollTop - events.clientHeight < 40;
    events.append(h('div', { class: 'event' },
      h('span', { class: 't' }, seq ? `#${seq}` : ''),
      h('span', { class: 'y' }, type),
      h('span', { class: 'd' }, describe(type, data))));
    if (atBottom) events.scrollTop = events.scrollHeight;
  };
  const types = ['status', 'init', 'assistant_text', 'thinking', 'tool_use', 'tool_result', 'log', 'gap', 'result'];
  for (const t of types) {
    eventSource.addEventListener(t, (e) => {
      let data = {};
      try { data = JSON.parse(e.data); } catch { /* ignore */ }
      add(t, data, e.lastEventId);
      if (t === 'result') {
        eventSource?.close();
        eventSource = null;
        liveTag.textContent = '';
        if (!terminal && token === renderToken) setTimeout(() => route(), 300); // refetch final state
      }
    });
  }
  eventSource.onerror = () => { if (terminal) { eventSource?.close(); eventSource = null; } };
}

function describe(type, d) {
  switch (type) {
    case 'status': return `${d.from ?? ''} → ${d.status}`;
    case 'init': return `model ${d.model ?? '?'} · ${Array.isArray(d.tools) ? d.tools.length : 0} tools`;
    case 'assistant_text': return d.text ?? '';
    case 'thinking': return d.redacted ? '(redacted)' : (d.text ?? '');
    case 'tool_use': return `${d.name ?? '?'} ${truncate(JSON.stringify(d.input ?? {}), 600)}`;
    case 'tool_result': return `${d.is_error ? '[error] ' : ''}${truncate(d.text ?? '', 1200)}`;
    case 'log': return d.line ?? '';
    case 'gap': return `${d.dropped} earlier events were dropped from the buffer`;
    case 'result': return `${d.status}${d.error ? `: ${d.error}` : ''}`;
    default: return truncate(JSON.stringify(d), 600);
  }
}
function truncate(s, n) { return s.length > n ? `${s.slice(0, n)}…` : s; }

// ---- router ----
async function route() {
  const token = ++renderToken;
  clearTimeout(pollTimer);
  if (eventSource) { eventSource.close(); eventSource = null; }
  const [pathPart, query] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(query ?? '');
  const parts = pathPart.split('/').filter(Boolean).map(decodeURIComponent);
  try {
    if (parts.length === 0) {
      await overview(token);
      schedule(token);
    } else if (parts[0] === 'repos' && parts[1]) {
      await repoView(token, parts[1]);
      schedule(token);
    } else if (parts[0] === 'jobs' && parts[1]) {
      await jobView(token, parts[1]); // live via SSE, no polling
    } else if (parts[0] === 'jobs') {
      await jobsView(token, params);
      schedule(token);
    } else {
      location.hash = '#/';
    }
  } catch (err) {
    if (token === renderToken) showError(err);
  }
}
function schedule(token) {
  pollTimer = setTimeout(() => {
    if (token !== renderToken) return;
    // don't yank the page while someone is using a dropdown
    if (document.activeElement?.tagName === 'SELECT') { schedule(token); return; }
    const y = window.scrollY;
    route().then(() => window.scrollTo(0, y));
  }, POLL_MS);
}

window.addEventListener('hashchange', route);
route();
