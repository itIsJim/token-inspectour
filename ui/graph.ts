// Standalone flow-graph page (graph.html): an interactive Cytoscape view of one session
// (turns → tool calls → results) or of one request's context composition (sources → areas →
// request). Opened from the inspector's "graph" button; ?session=…&request=… select what to draw.
// Compiled to dist/ui/graph.js and served under /<agent>/graph.js.
import type * as CyNS from 'cytoscape';
import type { GraphData, GraphNodeData, RequestSummary, SessionSummary, PublicSource } from '../src/types.js';
import { $, $$, BASE, NAME, api, basename, cssVar, esc, fmt, fmtKk, isDark, KINDS, kindColor, kindLabel, renderSourcePanel, short } from './common.js';

type GMode = 'flow' | 'context';

interface State {
  projectDir: string;
  kinds: Record<string, { label: string; color: string }>;
  sessions: SessionSummary[];
  inventory: { sources: PublicSource[] };
}

const params = new URLSearchParams(location.search);

const G = {
  cy: null as CyNS.Core | null,
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

// ---------------------------------------------------------------------------- cytoscape

// Theme-aware stylesheet. Kind colours come from the server palette so the graph matches
// the inspector's legend; fills are soft tints, borders carry the hue.
function graphStyle(): CyNS.Stylesheet[] {
  const ink = cssVar('--ink') || '#1a1a1a';
  const muted = cssVar('--muted') || '#6b7280';
  const panel = cssVar('--panel') || '#fff';
  const line = isDark() ? '#3b4252' : '#c7cdd6';
  const accent = cssVar('--accent') || '#2563eb';
  const tint = isDark() ? '33' : '22';
  const fill = (k: string) => kindColor(k) + tint;
  const font = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Inter, Roboto, sans-serif";
  const st: Array<{ selector: string; style: Record<string, unknown> }> = [
    { selector: 'core', style: { 'active-bg-opacity': 0, 'selection-box-color': accent, 'selection-box-opacity': 0.08 } },
    { selector: 'node', style: {
      shape: 'round-rectangle', width: 'label', height: 'label', padding: '9px',
      'background-color': panel, 'background-opacity': 1, 'border-width': 1.5, 'border-color': line,
      label: 'data(label)', color: ink, 'font-family': font, 'font-size': 11, 'text-wrap': 'wrap', 'text-max-width': '190px',
      'text-valign': 'center', 'text-halign': 'center', 'line-height': 1.25,
      'transition-property': 'opacity, border-width, border-color', 'transition-duration': 150, 'min-zoomed-font-size': 6,
    } },
    { selector: 'node[kind = "turn"]', style: { 'font-size': 12, 'font-weight': 600, 'background-color': isDark() ? '#1e2a44' : '#e8effd', 'border-color': accent, 'border-width': 2, padding: '12px', 'text-max-width': '220px' } },
    { selector: 'node[kind = "request"]', style: { 'font-size': 12, 'font-weight': 600, 'background-color': isDark() ? '#1e2a44' : '#e8effd', 'border-color': accent, 'border-width': 2, padding: '14px' } },
    { selector: 'node[kind = "area"]', style: { 'font-weight': 600, 'background-color': fill('harness'), 'border-color': kindColor('harness'), padding: '11px', shape: 'round-rectangle' } },
    { selector: 'node[kind = "side"]', style: { 'font-size': 10, color: muted, 'border-style': 'dashed', 'border-color': line, 'background-color': panel, padding: '6px' } },
    { selector: 'node[kind = "group"]', style: {
      shape: 'round-rectangle', 'background-color': isDark() ? '#ffffff' : '#000000', 'background-opacity': 0.035, 'border-width': 1, 'border-style': 'dashed', 'border-color': line,
      label: 'data(label)', color: muted, 'font-size': 10, 'font-weight': 600, 'text-transform': 'uppercase', 'text-valign': 'top', 'text-halign': 'center', 'text-margin-y': -4, padding: '14px',
    } },
    { selector: 'node[sub]', style: { label: (n: CyNS.NodeSingular) => `${n.data('label')}\n${n.data('sub')}` } },
    { selector: 'node[tokens]', style: { label: (n: CyNS.NodeSingular) => {
      const k = n.data('kind') as string;
      const t = n.data('tokens') as number | undefined;
      const o = n.data('tokensOut') as number | undefined;
      const sub = n.data('sub') as string | undefined;
      const tok = t == null ? '' : k === 'turn' || k === 'request' || k === 'side' ? `${fmtKk(t)} in${o != null ? ` · ${fmtKk(o)} out` : ''}` : k === 'area' ? `${fmtKk(t)} tokens` : '';
      return [n.data('label'), sub, tok].filter(Boolean).join('\n');
    } } },
    { selector: 'edge', style: {
      width: 'mapData(tokens, 0, 8000, 1.2, 5)', 'line-color': line, 'target-arrow-color': line, 'target-arrow-shape': 'triangle', 'arrow-scale': 0.85,
      'curve-style': 'bezier', 'control-point-step-size': 40, 'line-cap': 'round',
      label: 'data(label)', 'font-size': 9.5, 'font-family': font, color: muted,
      'text-background-color': panel, 'text-background-opacity': 1, 'text-background-padding': '2px', 'text-background-shape': 'roundrectangle',
      'text-rotation': 'autorotate', 'transition-property': 'opacity, line-color, width', 'transition-duration': 150,
    } },
    { selector: 'edge[kind = "next"]', style: { 'line-color': accent, 'target-arrow-color': accent, width: 2.5, 'curve-style': 'straight' } },
    { selector: 'edge[kind = "side"]', style: { 'line-style': 'dashed', 'target-arrow-shape': 'none', width: 1 } },
    { selector: 'edge[kind = "result"]', style: { 'line-style': 'dotted', 'line-dash-pattern': [2, 4] } },
    { selector: 'edge[kind = "spawn"]', style: { 'line-color': kindColor('agent'), 'target-arrow-color': kindColor('agent'), width: 2 } },
    { selector: 'edge[kind = "feeds"]', style: { 'curve-style': 'unbundled-bezier', 'control-point-distances': [0], 'control-point-weights': [0.5], 'line-color': line, 'target-arrow-shape': 'none', 'line-opacity': 0.75 } },
    { selector: 'node:selected', style: { 'border-color': accent, 'border-width': 3, 'overlay-opacity': 0 } },
    { selector: '.dim', style: { opacity: 0.18 } },
    { selector: 'node.hl', style: { 'border-width': 2.5 } },
    { selector: 'edge.hl', style: { 'line-color': accent, 'target-arrow-color': accent, opacity: 1 } },
  ];
  // one rule per kind colour: tinted fill + coloured border, so the graph reads like the anatomy bar
  for (const k of Object.keys(KINDS.kinds)) {
    st.push({ selector: `node[kind = "${k}"]`, style: { 'background-color': fill(k), 'border-color': kindColor(k) } });
  }
  return st as unknown as CyNS.Stylesheet[];
}

function layoutOptions(animate: boolean): CyNS.LayoutOptions {
  return {
    name: 'dagre', rankDir: G.dir, nodeSep: 22, rankSep: G.mode === 'context' ? 110 : 70, edgeSep: 10, ranker: 'network-simplex',
    animate, animationDuration: 380, animationEasing: 'ease-in-out-cubic', fit: true, padding: 36, spacingFactor: 1,
  } as unknown as CyNS.LayoutOptions;
}

// A fresh drawing is placed instantly (animations need requestAnimationFrame, which a
// background tab never gets, so an animated first layout would sit at the origin until the
// tab is shown); re-layouts on a visible page animate. Fit again once the layout settles.
function relayout(cy: CyNS.Core, animate: boolean): void {
  cy.resize();
  const l = cy.layout(layoutOptions(animate));
  l.one('layoutstop', () => cy.fit(undefined, 36));
  l.run();
}

function ensureCy(): CyNS.Core {
  if (G.cy) return G.cy;
  const cy = cytoscape({
    container: $('#cy') as HTMLElement, style: graphStyle(), elements: [], minZoom: 0.15, maxZoom: 3, wheelSensitivity: 0.25,
    boxSelectionEnabled: false, autoungrabify: false, pixelRatio: 'auto',
  });
  const tip = $('#tip');
  cy.on('mouseover', 'node', (ev) => {
    const n = ev.target as CyNS.NodeSingular;
    if (n.data('kind') === 'group') return;
    const hood = n.closedNeighborhood();
    cy.elements().not(hood).addClass('dim');
    hood.addClass('hl');
    const d = n.data() as GraphNodeData;
    const bits = [`<b>${esc(d.label)}</b>`];
    if (d.sub) bits.push(esc(d.sub));
    if (d.tokens != null) bits.push(`${fmt(d.tokens)} tokens${d.tokensOut != null ? ` in · ${fmt(d.tokensOut)} out` : ''}`);
    if (d.detail && typeof d.detail.resultTokens === 'number') bits.push(`result: ${fmt(d.detail.resultTokens as number)} tokens`);
    bits.push('<span style="opacity:.7">click for details</span>');
    tip.innerHTML = bits.join('<br>');
    tip.style.display = 'block';
  });
  cy.on('mousemove', (ev) => {
    const oe = ev.originalEvent as MouseEvent | undefined;
    if (oe && tip.style.display === 'block') {
      tip.style.left = Math.min(window.innerWidth - 440, oe.clientX + 14) + 'px';
      tip.style.top = oe.clientY + 14 + 'px';
    }
  });
  cy.on('mouseout', 'node', () => {
    cy.elements().removeClass('dim hl');
    tip.style.display = 'none';
  });
  cy.on('tap', 'node', (ev) => {
    const n = ev.target as CyNS.NodeSingular;
    if (n.data('kind') !== 'group') void showDetail(n.data() as GraphNodeData);
  });
  cy.on('tap', (ev) => {
    if (ev.target === cy) $('#main').classList.remove('with-side');
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => cy.style(graphStyle()));
  new ResizeObserver(() => cy.resize()).observe($('#cy')); // details panel opening/closing changes the canvas width
  G.cy = cy;
  return cy;
}

function renderLegend(data: GraphData): void {
  const kinds = new Set<string>();
  for (const n of data.nodes) if (n.data.kind !== 'group') kinds.add(n.data.kind);
  const label = (k: string): string => ({ turn: 'agent turn', side: 'side call', request: 'request', area: 'request area' } as Record<string, string>)[k] || kindLabel(k);
  const color = (k: string): string => ({ turn: cssVar('--accent'), request: cssVar('--accent'), side: cssVar('--muted'), area: kindColor('harness') } as Record<string, string>)[k] || kindColor(k);
  $('#glegend').innerHTML = [...kinds].map((k) => `<span><span class="k" style="background:${color(k)}"></span>${esc(label(k))}</span>`).join('') +
    (data.mode === 'flow' ? `<span><span class="k" style="background:${cssVar('--accent')};height:2px;vertical-align:middle"></span>next turn (+tokens added)</span><span><span class="k" style="border-bottom:2px dotted ${cssVar('--muted')};background:none;height:0"></span>result back</span>` : '<span>edge width = tokens</span>');
}

async function draw(force = false): Promise<void> {
  let url: string | null = null;
  if (G.mode === 'flow' && G.session) url = `/api/sessions/${G.session}/graph`;
  if (G.mode === 'context' && G.request) url = `/api/requests/${G.request}/graph`;
  const empty = $('#gempty');
  if (!url) {
    empty.hidden = false;
    empty.textContent = G.sessions.length ? 'Pick a session above to draw its flow.' : 'No sessions captured yet. Run Claude Code through the proxy, then come back.';
    G.cy?.elements().remove();
    $('#glegend').innerHTML = '';
    $('#gstats').textContent = '';
    return;
  }
  const data = await api<GraphData>(url);
  const cy = ensureCy();
  const key = `${G.mode}:${url}:${G.dir}`;
  const elements = [...data.nodes.map((n) => ({ group: 'nodes' as const, data: n.data as unknown as Record<string, unknown> })), ...data.edges.map((e) => ({ group: 'edges' as const, data: e.data as unknown as Record<string, unknown> }))];
  empty.hidden = data.nodes.length > 0;
  if (!data.nodes.length) empty.textContent = 'Nothing to draw yet: no completed calls in this selection.';
  const prevIds = new Set(cy.nodes().map((n) => n.id()));
  const sameShape = !force && key === G.key && data.nodes.length === prevIds.size && data.nodes.every((n) => prevIds.has(n.data.id));
  G.key = key;
  if (sameShape) {
    // update weights/labels in place, keep positions
    for (const n of data.nodes) cy.getElementById(n.data.id).data(n.data as unknown as Record<string, unknown>);
    for (const e of data.edges) {
      const el = cy.getElementById(e.data.id);
      if (el.length) el.data(e.data as unknown as Record<string, unknown>);
      else cy.add({ group: 'edges', data: e.data as unknown as Record<string, unknown> });
    }
  } else {
    cy.elements().remove();
    cy.add(elements);
    relayout(cy, false);
  }
  renderLegend(data);
  const st = data.stats;
  $('#gstats').textContent = data.mode === 'flow'
    ? `${st.turns} turns · ${st.calls} tool calls · ${st.sideCalls} side calls · ${fmt(st.promptTokens)} prompt tokens · ${fmt(st.outputTokens)} output`
    : `${st.sources} sources · ${fmt(st.tokens)} prompt tokens`;
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
    if (G.cy) relayout(G.cy, true);
    G.key = '';
  };
});
$<HTMLButtonElement>('[data-gact=fit]').onclick = () => G.cy?.animate({ fit: { eles: G.cy.elements(), padding: 36 }, duration: 250 });
$<HTMLButtonElement>('[data-gact=relayout]').onclick = () => { if (G.cy) relayout(G.cy, true); };

void load().then(() => draw(true)).then(live);
