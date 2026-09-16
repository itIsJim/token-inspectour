// Standalone flow-graph page (graph.html): a d3 drawing of one session (turns → tool calls →
// results, see flow.ts) or a Sankey of one request's context composition (sources → areas →
// request). Opened from the inspector's "graph" button; ?session=…&request=… select what to draw.
// Compiled to dist/ui/graph.js and served under /<agent>/graph.js.
import type { GraphData, GraphNodeData, RequestSummary, SessionSummary, PublicSource } from '../src/types.js';
import { $, $$, BASE, NAME, api, basename, cssVar, esc, fmt, KINDS, kindColor, kindLabel, renderSourcePanel, short } from './common.js';
import { flowGraph } from './flow.js';
import type { FlowHandle } from './flow.js';
import { sankeyChart } from './charts.js';
import type { SLink, SNode } from './charts.js';

type GMode = 'flow' | 'context';

interface State {
  projectDir: string;
  kinds: Record<string, { label: string; color: string }>;
  sessions: SessionSummary[];
  inventory: { sources: PublicSource[] };
}

const params = new URLSearchParams(location.search);

const G = {
  flow: null as FlowHandle | null,
  mode: (params.get('mode') === 'context' ? 'context' : 'flow') as GMode,
  dir: 'LR' as 'LR' | 'TB',
  key: '', // what the current drawing represents (session/request + mode + direction)
  refreshT: 0,
  sessions: [] as SessionSummary[],
  sources: [] as PublicSource[],
  session: params.get('session'),
  request: params.get('request'),
};

// ---------------------------------------------------------------------------- data + chrome

async function load(): Promise<void> {
  const st = await api<State>('/api/state');
  KINDS.kinds = st.kinds;
  G.sessions = st.sessions;
  G.sources = st.inventory.sources;
  document.title = `${NAME} · flow-graph · token-inspectour :${location.port}`;
  $('#h-name').textContent = NAME;
  $('#h-project').textContent = short(st.projectDir);
  reconcileSelection();
  renderSelects();
  syncUrl();
}

// Keep the selection valid: default to the newest session and its last request.
function reconcileSelection(): void {
  if (G.request && !G.session) G.session = G.sessions.find((s) => s.requests.some((r) => r.id === G.request))?.id || null;
  if (!G.session || !G.sessions.some((s) => s.id === G.session)) G.session = G.sessions[0]?.id || null;
  const sess = G.sessions.find((s) => s.id === G.session);
  if (!sess) {
    G.request = null;
    return;
  }
  if (!G.request || !sess.requests.some((r) => r.id === G.request)) G.request = sess.requests[sess.requests.length - 1]?.id || null;
}

const sessionTitle = (s: SessionSummary): string => `${s.agent || basename(s.projectDir) || s.id.slice(0, 8)} · ${new Date(s.startedAt).toLocaleString()} · ${s.requests.length} calls`;
const requestTitle = (r: RequestSummary): string => `#${r.seq} ${r.kind || ''}${r.userPreview ? ' · ' + r.userPreview.slice(0, 60) : ''}`;

function renderSelects(): void {
  const ss = $<HTMLSelectElement>('#sel-session');
  ss.innerHTML = G.sessions.length
    ? G.sessions.map((s) => `<option value="${s.id}" ${s.id === G.session ? 'selected' : ''}>${esc(sessionTitle(s))}</option>`).join('')
    : '<option value="">no sessions yet</option>';
  const sess = G.sessions.find((s) => s.id === G.session);
  const rs = $<HTMLSelectElement>('#sel-request');
  rs.innerHTML = sess ? sess.requests.map((r) => `<option value="${r.id}" ${r.id === G.request ? 'selected' : ''}>${esc(requestTitle(r))}</option>`).join('') : '<option value="">no requests</option>';
  rs.hidden = G.mode !== 'context';
  $$('[data-gmode]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-gmode') === G.mode));
  $$('[data-gdir]').forEach((x) => x.classList.toggle('on', x.getAttribute('data-gdir') === G.dir));
  $<HTMLAnchorElement>('#b-inspect').href = inspectorUrl(G.mode === 'context' ? G.request : null);
}

const inspectorUrl = (requestId: string | null | undefined): string => `${BASE}/` + (requestId ? `?request=${encodeURIComponent(requestId)}` : '');

function syncUrl(): void {
  const q = new URLSearchParams();
  if (G.session) q.set('session', G.session);
  if (G.request) q.set('request', G.request);
  if (G.mode !== 'flow') q.set('mode', G.mode);
  history.replaceState(null, '', `${location.pathname}?${q}`);
}

// ---------------------------------------------------------------------------- drawing

function renderLegend(data: GraphData): void {
  const kinds = new Set<string>();
  for (const n of data.nodes) if (n.data.kind !== 'group' && n.data.ref?.type !== 'request') kinds.add(n.data.kind);
  const sw = (bg: string, border = bg): string => `<span class="k" style="background:color-mix(in srgb, ${bg} 16%, var(--card));box-shadow:inset 0 0 0 1.5px ${border}"></span>`;
  $('#glegend').innerHTML = `<span>${sw('var(--hl)')}agent turn</span><span>${sw(kindColor('agent'))}subagent turn</span><span>${sw('var(--muted-foreground)')}side call</span>` +
    [...kinds].map((k) => `<span>${sw(kindColor(k))}${esc(kindLabel(k))}</span>`).join('') +
    '<span><span class="k line hl"></span>next turn (+tokens added)</span><span><span class="k line"></span>call / result (width = tokens)</span><span><span class="k line dash"></span>side call</span>';
}

async function draw(force = false): Promise<void> {
  let url: string | null = null;
  if (G.mode === 'flow' && G.session) url = `/api/sessions/${G.session}/graph`;
  if (G.mode === 'context' && G.request) url = `/api/requests/${G.request}/graph`;
  const empty = $('#gempty');
  if (!url) {
    empty.hidden = false;
    empty.textContent = G.sessions.length ? 'Pick a session above to draw its flow.' : 'No sessions captured yet. Run Claude Code through the proxy, then come back.';
    $('#flow').innerHTML = '';
    G.flow = null;
    $('#glegend').innerHTML = '';
    $('#gstats').textContent = '';
    return;
  }
  const data = await api<GraphData>(url);
  $('#flow').hidden = data.mode === 'context';
  $('#sankey').hidden = data.mode !== 'context';
  $$('[data-gdir],[data-gact]').forEach((b) => ((b as HTMLButtonElement).disabled = data.mode === 'context'));
  if (data.mode === 'context') {
    empty.hidden = true;
    drawContextSankey(data);
    G.key = '';
    G.flow = null;
    return;
  }
  const key = `${url}:${G.dir}`;
  empty.hidden = data.nodes.length > 0;
  if (!data.nodes.length) empty.textContent = 'Nothing to draw yet: no completed calls in this selection.';
  // live refreshes of the same drawing keep the current pan and zoom
  const keep = !force && key === G.key && G.flow ? G.flow.transform() : null;
  G.key = key;
  G.flow = flowGraph($('#flow'), data, {
    dir: G.dir, selected: G.request, keep,
    onClick: (d) => {
      if (d.ref?.type === 'request') {
        G.request = d.ref.id;
        G.flow?.select(G.request);
        renderSelects();
        syncUrl();
      }
      void showDetail(d);
    },
  });
  renderLegend(data);
  const st = data.stats;
  $('#gstats').textContent = `${st.turns} turns · ${st.calls} tool calls · ${st.sideCalls} side calls · ${fmt(st.promptTokens)} prompt tokens · ${fmt(st.outputTokens)} output`;
}

// Turn context as a Sankey: sources (or built-in kinds) → request areas → the request.
function drawContextSankey(data: GraphData): void {
  const byId = new Map(data.nodes.map((n) => [n.data.id, n.data]));
  const col = (d: GraphNodeData): number => (d.kind === 'request' ? 2 : d.kind === 'area' ? 1 : 0);
  const color = (d: GraphNodeData): string => (d.kind === 'request' ? cssVar('--hl') : d.kind === 'area' ? ({ system: '#3f3f46', tools: '#52525b', messages: '#71717a' } as Record<string, string>)[d.ref?.id || ''] || '#52525b' : kindColor(d.kind));
  const nodes: SNode[] = data.nodes.filter((n) => n.data.kind !== 'group').map((n) => ({
    id: n.data.id, label: n.data.label, color: color(n.data), column: col(n.data),
    tip: `<b>${esc(n.data.label)}</b>${n.data.sub ? `<div class="muted small">${esc(n.data.sub)}</div>` : ''}<div class="row"><span>tokens</span><span>${fmt(n.data.tokens)}</span></div><div class="muted small">click for details</div>`,
  }));
  const links: SLink[] = data.edges.filter((e) => e.data.kind === 'feeds').map((e) => ({ source: e.data.source, target: e.data.target, value: e.data.tokens || 0 }));
  sankeyChart($('#sankey'), nodes, links, { rowH: 24, minHeight: 420, empty: 'Nothing to draw yet: this request has no analysis.', onClick: (n) => { const d = byId.get(n.id); if (d) void showDetail(d); } });
  $('#glegend').innerHTML = '<span>link width = tokens</span><span>left: sources and built-in kinds · middle: request areas · right: the request</span>';
  $('#gstats').textContent = `${data.stats.sources} sources · ${fmt(data.stats.tokens)} prompt tokens`;
}

async function showDetail(d: GraphNodeData): Promise<void> {
  if (d.ref?.type === 'source') return renderSourcePanel(d.ref.id, G.sources.find((s) => s.id === d.ref!.id));
  const side = $('#side');
  $('#main').classList.add('with-side');
  const det = d.detail || {};
  const kv = (rows: Array<[string, unknown]>): string => `<div class="kv">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span class="muted">${esc(k)}</span><b>${esc(typeof v === 'number' ? v.toLocaleString() : String(v))}</b>`).join('')}</div>`;
  const requestId = d.ref?.type === 'request' ? d.ref.id : d.ref?.requestId;
  const openLink = requestId ? `<p><a class="btn" href="${esc(inspectorUrl(requestId))}">open in inspector</a></p>` : '';
  let body = '';
  if (d.ref?.type === 'request' || d.kind === 'turn' || d.kind === 'side' || d.kind === 'request') {
    const byKind = (det.byKind || {}) as Record<string, number>;
    body = kv([['step', det.seq], ['model', det.model], ['status', det.status], ['stop', det.stopReason], ['duration', det.durationMs != null ? `${det.durationMs} ms` : null], ['prompt tokens', d.tokens], ['output tokens', d.tokensOut], ['cache read', det.cacheRead], ['cache write', det.cacheWrite], ['uncached', det.uncached]]);
    const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    if (kinds.length) body += `<h4>prompt by source kind</h4>${kv(kinds.map(([k, v]) => [kindLabel(k), v]))}`;
    if (det.userPreview) body += `<h4>user</h4><pre>${esc(det.userPreview)}</pre>`;
    if (det.assistantPreview) body += `<h4>assistant</h4><pre>${esc(det.assistantPreview)}</pre>`;
    body += openLink;
  } else if (d.ref?.type === 'call') {
    body = kv([['tool', det.tool], ['turn', det.turn], ['input tokens (≈)', d.tokens], ['result tokens', det.resultTokens], ['error', det.isError ? 'yes' : null]]);
    body += `<h4>input</h4><pre>${esc(JSON.stringify(det.input ?? {}, null, 2))}</pre>`;
    if (det.resultPreview) body += `<h4>result (first 400 chars)</h4><pre>${esc(String(det.resultPreview))}</pre>`;
  } else if (d.ref?.type === 'area') {
    body = kv([['area', d.label], ['tokens', d.tokens]]) + '<p class="muted small">Open the request in the inspector to see every part of this area.</p>' + openLink;
  } else {
    body = kv([['kind', kindLabel(d.kind)], ['tokens', d.tokens]]);
  }
  side.innerHTML = `<div class="hd"><span class="k" style="background:${d.kind === 'turn' || d.kind === 'request' ? cssVar('--accent') : kindColor(d.kind)}"></span><span class="t">${esc(d.label)}</span><button data-act="close">✕</button></div><div id="gdetail">${body}</div>`;
  $<HTMLButtonElement>('[data-act=close]', side).onclick = () => $('#main').classList.remove('with-side');
}

// ---------------------------------------------------------------------------- live + controls

function scheduleRefresh(): void {
  window.clearTimeout(G.refreshT);
  G.refreshT = window.setTimeout(() => void draw(false), 400);
}

function live(): void {
  const es = new EventSource(BASE + '/events');
  const refresh = async (): Promise<void> => {
    G.sessions = await api<SessionSummary[]>('/api/sessions');
    const hadNothing = !G.session;
    reconcileSelection();
    renderSelects();
    syncUrl();
    if (hadNothing && G.session) void draw(true);
    else scheduleRefresh();
  };
  for (const ev of ['request', 'response', 'analysis']) es.addEventListener(ev, () => void refresh());
  es.addEventListener('cleared', () => location.reload());
}

$<HTMLSelectElement>('#sel-session').onchange = (e) => {
  G.session = (e.target as HTMLSelectElement).value || null;
  G.request = null;
  reconcileSelection();
  renderSelects();
  syncUrl();
  $('#main').classList.remove('with-side');
  void draw(true);
};
$<HTMLSelectElement>('#sel-request').onchange = (e) => {
  G.request = (e.target as HTMLSelectElement).value || null;
  renderSelects();
  syncUrl();
  $('#main').classList.remove('with-side');
  void draw(true);
};
$$<HTMLButtonElement>('[data-gmode]').forEach((b) => {
  b.onclick = () => {
    G.mode = b.dataset.gmode as GMode;
    renderSelects();
    syncUrl();
    void draw(true);
  };
});
$$<HTMLButtonElement>('[data-gdir]').forEach((b) => {
  b.onclick = () => {
    G.dir = b.dataset.gdir as 'LR' | 'TB';
    renderSelects();
    void draw(true);
  };
});
$<HTMLButtonElement>('[data-gact=fit]').onclick = () => G.flow?.fit();
$<HTMLButtonElement>('[data-gact=focus]').onclick = () => G.flow?.focus(G.request);

void load().then(() => draw(true)).then(live);
