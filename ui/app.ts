// token-inspectour inspector UI. Compiled by `tsc -p tsconfig.ui.json` to dist/ui/app.js and
// served under /<agent>/app.js. Shared helpers live in common.ts, the JSON viewer in json.ts and
// the d3 charts in charts.ts. The flow-graph is its own page (graph.html / graph.ts), reached
// through the "graph" link in the header.
import type { Analysis, DiffEntry, Part, PublicSource, RequestSummary, SessionSummary, SourceUsage, Span, AdhocSource, AssembledResponse, SlimAnalysis, SourceKind } from '../src/types.js';
import { $, $$, BASE, NAME, api, basename, esc, fmt, fmtKk, hideTip, KINDS, kindColor, kindLabel, pct, renderSourcePanel, short, showTip } from './common.js';
import type { Kinds } from './common.js';
import { atPath, expandAll, jsonView } from './json.js';
import { donut, forceGraph, icicle, stackBar, stepColumns } from './charts.js';
import type { GLink, GNode, IcicleHandle, MapNode, Slice } from './charts.js';

type UiSource = PublicSource | AdhocSource;

interface State {
  name: string;
  base: string;
  projectDir: string;
  proxyUrl: string;
  upstream: string;
  counter: { ready: boolean; enabled: boolean; stats: { calls: number; hits: number; errors: number; lastError: string | null }; cacheSize: number; queue: number };
  inventory: { scannedAt: number; sources: PublicSource[] };
  projects: string[];
  kinds: Kinds;
  sessions: SessionSummary[];
  version?: string;
}

interface FullRequest {
  id: string;
  seq?: number;
  sessionId: string;
  agent: string | null;
  projectDir?: string;
  kind?: string;
  model: string | null;
  status: number | null;
  durationMs?: number;
  ttfbMs?: number | null;
  ttftMs?: number;
  response: AssembledResponse | null;
  analysis: Analysis | null;
  adhocSources: AdhocSource[];
  inventory?: { projectDir: string; scannedAt: number; sources: PublicSource[] };
}

interface RawRequest {
  request: unknown;
  response: unknown;
  headers: unknown;
  responseHeaders: unknown;
}

type Tab = 'anatomy' | 'sources' | 'diff' | 'response' | 'raw';

const S = {
  state: null as State | null,
  sessions: [] as SessionSummary[],
  kinds: {} as Kinds,
  sources: [] as PublicSource[],
  sel: null as string | null,
  selSession: null as string | null,
  rec: null as FullRequest | null,
  tab: 'anatomy' as Tab,
  hiddenKinds: new Set<string>(),
  sessionAnalyses: new Map<string, SlimAnalysis>(),
  raw: null as { id: string; data: Promise<RawRequest> } | null,
  selPart: null as string | null,
  acc: new Map<string, boolean>(), // accordion open state, kept across re-renders
  showUnused: true,
  sourceFilter: '',
  icicle: null as IcicleHandle | null,
};

const recSources = (): PublicSource[] => S.rec?.inventory?.sources || S.sources;
const ROLE_COLOR: Record<string, string> = { user: '#2563eb', assistant: '#16a34a', system: '#64748b' };
const AREA_COLOR: Record<string, string> = { system: '#3f3f46', tools: '#52525b', messages: '#71717a', envelope: '#a1a1aa' };
const sumT = (ps: Array<{ tokens?: number }>): number => ps.reduce((x, p) => x + (p.tokens || 0), 0);

function rawFor(id: string): Promise<RawRequest> {
  if (!S.raw || S.raw.id !== id) S.raw = { id, data: api<RawRequest>(`/api/requests/${id}/raw`) };
  return S.raw.data;
}

// ---------------------------------------------------------------------------- part helpers

/** JSON path of a part inside the request body (null for synthetic parts such as the tool framing). */
function partPath(p: Pick<Part, 'area' | 'index' | 'sub' | 'blockType'>): string | null {
  if (p.blockType === 'framing') return null;
  if (p.area === 'system') return `system[${p.index}]`;
  if (p.area === 'tools') return `tools[${p.index}]`;
  return `messages[${p.index}].content[${p.sub}]`;
}

/** The block a path points at; a string message content is addressed as content[0]. */
function blockAt(body: unknown, path: string): unknown {
  const v = atPath(body, path);
  if (v !== undefined) return v;
  const m = /^(messages\[\d+\]\.content)\[0\]$/.exec(path);
  if (m) return atPath(body, m[1]);
  if (path === 'system[0]') return atPath(body, 'system');
  return undefined;
}

function dominantKind(p: Pick<Part, 'spans' | 'kind'>): string {
  if (p.kind) return p.kind;
  const by = new Map<string, number>();
  for (const s of p.spans) by.set(s.kind, (by.get(s.kind) || 0) + (s.tokens || s.end - s.start));
  let best = 'harness';
  let n = -1;
  for (const [k, v] of by) if (v > n) { best = k; n = v; }
  return best;
}

function toolGroup(p: Part): string {
  if (p.blockType === 'framing') return 'Tool-use framing';
  if (p.kind === 'harness-tool') return 'Built-in tools';
  return `MCP · ${(p.name || '').split('__')[1] || 'server'}`;
}

const blockBadge = (p: Part): string => {
  const t = p.blockType === 'tool' ? 'tool' : p.blockType === 'framing' ? 'framing' : p.blockType;
  return `<span class="badge outline mono">${esc(t)}</span>`;
};

// ---------------------------------------------------------------------------- state + left column

async function loadState(): Promise<void> {
  S.state = await api<State>('/api/state');
  S.kinds = S.state.kinds;
  KINDS.kinds = S.kinds;
  S.sources = S.state.inventory.sources;
  S.sessions = S.state.sessions;
  document.title = `${NAME} · token-inspectour :${location.port}`;
  $('#h-name').textContent = NAME;
  $('#h-project').textContent = short(S.state.projectDir) + (S.state.projects.length > 1 ? ` (+${S.state.projects.length - 1} detected)` : '');
  $('#h-project').title = "default project; each session's project is detected from its requests:\n" + S.state.projects.map(short).join('\n');
  const cmd = `ANTHROPIC_BASE_URL=${S.state.proxyUrl}/${NAME} claude`;
  $('#h-cmd').textContent = cmd;
  $('#l-cmd').textContent = cmd;
  renderHeaderPills();
  renderLeft();
  renderGraphLink();
  const wanted = new URLSearchParams(location.search).get('request');
  if (wanted && S.sessions.some((x) => x.requests.some((r) => r.id === wanted))) {
    history.replaceState(null, '', location.pathname);
    return select(wanted);
  }
  const first = S.sessions[0];
  if (!S.sel && first && first.requests.length) {
    S.selSession = first.id;
    void select(first.requests[first.requests.length - 1].id);
  }
}

// The header's "graph" link opens the standalone flow-graph page on the current selection.
function renderGraphLink(): void {
  const q = new URLSearchParams();
  const sess = S.selSession || S.rec?.sessionId || S.sessions[0]?.id;
  if (sess) q.set('session', sess);
  if (S.sel) q.set('request', S.sel);
  $<HTMLAnchorElement>('#b-graph').href = `${BASE}/graph${q.size ? '?' + q : ''}`;
}

function renderHeaderPills(): void {
  if (!S.state) return;
  const c = S.state.counter;
  const el = $('#h-counter');
  el.className = 'pill ' + (c.ready ? 'ok' : c.enabled ? 'warn' : '');
  el.textContent = !c.enabled ? 'tokens: estimates only' : c.ready ? `tokens: exact (${c.stats.calls} calls, ${c.cacheSize} cached${c.queue ? `, ${c.queue} queued` : ''})` : 'tokens: exact after first request';
  el.title = c.stats.lastError ? 'last error: ' + c.stats.lastError : 'exact counts come from /v1/messages/count_tokens using the captured session auth';
  $('#h-inv').textContent = `${S.sources.length} sources`;
  $('#h-inv').title = 'CLAUDE.md, rules, skills, commands, agents, settings, MCP, memory, plugins found for this project';
}

function renderLeft(): void {
  const left = $('#left');
  if (!S.sessions.length) return;
  const scroll = left.scrollTop;
  left.innerHTML = S.sessions
    .map((s) => {
      const open = s.id === S.selSession;
      const main = s.requests.filter((r) => r.kind === 'main');
      const last = main[main.length - 1];
      const tot = last && last.usage ? (last.usage.input || 0) + (last.usage.cacheRead || 0) + (last.usage.cacheWrite || 0) : null;
      const proj = basename(s.projectDir);
      const title = s.agent || proj || s.id.slice(0, 8);
      return `<div class="sess ${open ? 'sel' : ''}" data-id="${s.id}">
      <div class="hd" data-sess="${s.id}" title="${esc(s.projectDir || '')}"><span class="chev">▶</span><span class="t">${esc(title)}</span><span class="small mono muted">${s.requests.length} calls</span>
        <span class="meta"><span>${new Date(s.startedAt).toLocaleString()}</span>${s.agent && proj && s.agent !== proj ? `<span>${esc(proj)}</span>` : ''}${tot ? `<span class="mono">ctx ${fmtKk(tot)}</span>` : ''}</span></div>
      ${open ? `<div style="padding:2px 0 6px">${s.requests.map((r) => reqRow(r)).join('')}</div>` : ''}
    </div>`;
    })
    .join('');
  left.scrollTop = scroll;
  $$('[data-sess]', left).forEach((h) => {
    h.onclick = () => {
      const id = h.dataset.sess!;
      S.selSession = S.selSession === id ? null : id;
      renderLeft();
      renderGraphLink();
      if (S.selSession) renderSessionOverview();
    };
  });
  $$('.req', left).forEach((r) => {
    r.onclick = () => void select(r.dataset.id!);
  });
}

function reqRow(r: RequestSummary): string {
  const u = r.usage;
  const tot = u.input != null ? (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) : null;
  const kind = r.kind || '';
  const side = kind !== 'main' && !kind.startsWith('main:');
  const st = r.status == null ? '<span class="pill warn">…</span>' : r.status >= 400 ? `<span class="pill bad">${r.status}</span>` : '';
  const head = side ? `<span class="badge">${esc(kind.replace('side:', ''))}</span>` : kind.startsWith('main:') ? `<b>${esc(kind.slice(5))}</b>` : '<b>turn</b>';
  return `<div class="req ${side ? 'side' : ''} ${r.id === S.sel ? 'sel' : ''}" data-id="${r.id}">
    <span class="seq">#${r.seq}</span>
    <span>${head} <span class="muted small">${esc((r.model || '').replace('claude-', ''))}</span> ${st}</span>
    <span class="tok" title="prompt tokens from usage: uncached + cache read + cache write | output">${tot != null ? fmtKk(tot) : '…'}${u.output != null ? ` <span class="muted">→${fmtKk(u.output)}</span>` : ''}</span>
    <span class="prev">${esc(r.userPreview || '')}${r.assistantPreview ? ` ⇢ ${esc(r.assistantPreview)}` : ''}</span>
  </div>`;
}

async function select(id: string): Promise<void> {
  const same = S.sel === id;
  S.sel = id;
  const rec = await api<FullRequest>(`/api/requests/${id}?full=1`);
  if (S.sel !== id) return;
  if (!same) {
    S.selPart = null;
    $('#main').classList.remove('with-side');
  }
  S.rec = rec;
  S.selSession = rec.sessionId;
  renderLeft();
  renderCenter(same);
  renderGraphLink();
  $('.req.sel')?.scrollIntoView({ block: 'nearest' });
}

// ---------------------------------------------------------------------------- center

function renderCenter(keepScroll = false): void {
  const rec = S.rec;
  if (!rec) return;
  const c = $('#center');
  const scroll = keepScroll ? c.scrollTop : 0;
  const tabs: Tab[] = ['anatomy', 'sources', 'diff', 'response', 'raw'];
  c.innerHTML = `<div class="tabs"><div class="tablist" role="tablist">${tabs.map((t) => `<button role="tab" class="${S.tab === t ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}</div>
    <span class="grow"></span><span class="meta">#${rec.seq} · ${esc(rec.kind)} · ${esc(rec.model || '')} · ${rec.durationMs ? fmt(rec.durationMs) + ' ms' : 'in flight'}${rec.ttftMs ? ` · first token ${fmt(rec.ttftMs)} ms` : ''}</span>
    <button data-act="recount" title="Re-run exact token counting for this request">recount</button></div><div class="view" id="view"></div>`;
  $$<HTMLButtonElement>('[data-tab]', c).forEach((b) => {
    b.onclick = () => {
      S.tab = b.dataset.tab as Tab;
      renderCenter();
    };
  });
  $<HTMLButtonElement>('[data-act=recount]', c).onclick = async () => {
    await api(`/api/requests/${rec.id}/recount`, { method: 'POST' });
    void select(rec.id);
  };
  const v = $('#view');
  if (!rec.analysis) {
    v.innerHTML = '<div class="empty">Analyzing…</div>';
    return;
  }
  const a = rec.analysis;
  switch (S.tab) {
    case 'anatomy': renderAnatomy(v, rec, a); break;
    case 'sources': renderSources(v, rec, a); break;
    case 'diff': renderDiff(v, rec, a); break;
    case 'response': renderResponse(v, rec); break;
    case 'raw': void renderRaw(v, rec); break;
  }
  c.scrollTop = scroll;
}

// Accordion markup whose open state survives re-renders.
function acc(key: string, title: string, sum: string, body: string, openByDefault = false, inner = false): string {
  const open = S.acc.has(key) ? S.acc.get(key) : openByDefault;
  return `<details class="acc ${inner ? 'inner' : ''}" data-acc="${esc(key)}" ${open ? 'open' : ''}><summary>${title}<span class="sum">${sum}</span></summary><div class="acc-bd">${body}</div></details>`;
}
function wireAcc(v: HTMLElement, onOpen: Record<string, (el: HTMLElement) => void> = {}): void {
  $$<HTMLDetailsElement>('details[data-acc]', v).forEach((d) => {
    const key = d.dataset.acc!;
    const run = (): void => {
      if (d.open && onOpen[key] && !d.dataset.done) {
        d.dataset.done = '1';
        onOpen[key]($('.acc-bd', d));
      }
    };
    d.addEventListener('toggle', () => {
      S.acc.set(key, d.open);
      run();
    });
    run();
  });
}

function stat(label: string, value: string, sub = '', cls = '', title = ''): string {
  return `<div class="stat" ${title ? `title="${esc(title)}"` : ''}><div class="l">${esc(label)}</div><div class="v ${cls}">${value}</div>${sub ? `<div class="s">${sub}</div>` : ''}</div>`;
}

function statTiles(a: Analysis): string {
  const t = a.totals;
  const u = a.cache;
  const delta = a.promptTotalFromUsage != null ? a.promptTotalFromUsage - t.tokens : null;
  const exact = a.exactTotal ? `<span class="pill ok">exact ${a.counted}/${a.partCount}</span>` : a.counted ? `<span class="pill warn">partly exact ${a.counted}/${a.partCount}</span>` : '<span class="pill">estimated ≈</span>';
  return `<div class="stats">
    ${stat('Prompt tokens (server)', fmt(a.promptTotalFromUsage), 'uncached + cache read + write')}
    ${stat('Sum of parts', fmt(t.tokens), exact)}
    ${delta != null ? stat('Unattributed Δ', `${delta >= 0 ? '+' : ''}${fmt(delta)}`, `${pct(Math.abs(delta), a.promptTotalFromUsage || undefined)} · request-level fields, drift`, Math.abs(delta) > 0.03 * (a.promptTotalFromUsage || 1) ? 'chg' : '', 'server usage total minus the sum of attributed parts') : ''}
    ${u ? stat('Cache read', fmt(u.read), pct(u.read, a.promptTotalFromUsage || undefined)) : ''}
    ${u ? stat('Cache write', fmt(u.write), pct(u.write, a.promptTotalFromUsage || undefined)) : ''}
    ${u ? stat('Uncached', fmt(u.uncached)) : ''}
  </div>`;
}

function kindSlices(a: Pick<Analysis, 'totals'>): Slice[] {
  return Object.entries(a.totals.byKind)
    .map(([k, v]) => ({ key: k, label: kindLabel(k), value: v!.tokens, color: kindColor(k) }))
    .sort((x, y) => y.value - x.value);
}

function legendHtml(slices: Slice[], total: number): string {
  return `<div class="legend">${slices.map((s) => `<span class="item ${S.hiddenKinds.has(s.key) ? 'off' : ''}" data-kind="${s.key}" title="click to dim this kind in text views"><span class="k" style="background:${s.color}"></span>${esc(s.label)}<b>${fmtKk(s.value)}</b><span class="muted small">&nbsp;${pct(s.value, total)}</span></span>`).join('')}</div>`;
}

function wireLegend(v: HTMLElement): void {
  $$('.legend .item', v).forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.kind!;
      if (S.hiddenKinds.has(k)) S.hiddenKinds.delete(k);
      else S.hiddenKinds.add(k);
      el.classList.toggle('off', S.hiddenKinds.has(k));
      $$('.txt span.sp').forEach((s) => s.classList.toggle('dim', S.hiddenKinds.has(s.dataset.kind || '')));
    };
  });
}

function compositionCard(a: Analysis): string {
  return `<div class="card"><div class="card-hd"><h3>Composition</h3><span class="desc">tokens by request area and by the kind of source that produced them</span></div>
    <div class="card-bd"><div class="overview"><div id="c-donut" class="chart"></div><div><div id="c-kindbar" class="chart"></div>${legendHtml(kindSlices(a), a.totals.tokens)}</div></div></div></div>`;
}

function drawComposition(v: HTMLElement, a: Analysis): void {
  const areas: Slice[] = (['system', 'tools', 'messages'] as const)
    .filter((k) => a.totals.byArea[k])
    .map((k) => ({ key: k, label: { system: 'System prompt', tools: 'Tools', messages: 'Messages' }[k], value: a.totals.byArea[k]!.tokens, color: AREA_COLOR[k], sub: `${a.totals.byArea[k]!.parts} parts` }));
  const delta = a.promptTotalFromUsage != null ? a.promptTotalFromUsage - a.totals.tokens : 0;
  if (delta > 0) areas.push({ key: 'envelope', label: 'Unattributed / request fields', value: delta, color: '#d4d4d8' });
  const total = a.promptTotalFromUsage ?? a.totals.tokens;
  const d = $('#c-donut', v);
  if (d) donut(d, areas, { value: fmtKk(total), label: 'prompt tokens' }, (s) => S.icicle?.focus(`area:${s.key}`));
  const kb = $('#c-kindbar', v);
  if (kb) stackBar(kb, kindSlices(a));
}

// ---------------------------------------------------------------------------- anatomy

function buildMap(rec: FullRequest, a: Analysis): MapNode {
  const leaf = (p: Part): MapNode => ({ id: `p:${p.id}`, name: shortLabel(p), path: partPath(p) || undefined, color: kindColor(dominantKind(p)), value: p.tokens || 0, exact: p.exact, sub: p.label });
  const sys = a.parts.filter((p) => p.area === 'system');
  const tools = a.parts.filter((p) => p.area === 'tools');
  const msgs = a.parts.filter((p) => p.area === 'messages');
  const children: MapNode[] = [];
  if (sys.length) children.push({ id: 'area:system', name: 'system', path: 'system', color: AREA_COLOR.system, children: sys.map(leaf) });
  if (tools.length) {
    const groups = new Map<string, Part[]>();
    for (const p of tools) groups.set(toolGroup(p), [...(groups.get(toolGroup(p)) || []), p]);
    children.push({
      id: 'area:tools', name: 'tools', path: 'tools', color: AREA_COLOR.tools,
      children: [...groups.entries()].map(([g, ps]) => (ps.length === 1 && ps[0].blockType === 'framing' ? leaf(ps[0]) : { id: `tg:${g}`, name: g, color: kindColor(ps[0].kind || 'harness-tool'), children: ps.map(leaf) })),
    });
  }
  if (msgs.length) {
    const byMsg = new Map<number, Part[]>();
    for (const p of msgs) byMsg.set(p.index, [...(byMsg.get(p.index) || []), p]);
    children.push({
      id: 'area:messages', name: 'messages', path: 'messages', color: AREA_COLOR.messages,
      children: [...byMsg.entries()].map(([i, ps]) => ({ id: `m:${i}`, name: `[${i}] ${ps[0].role}`, path: `messages[${i}]`, color: ROLE_COLOR[ps[0].role] || '#64748b', children: ps.map(leaf) })),
    });
  }
  const delta = a.promptTotalFromUsage != null ? a.promptTotalFromUsage - a.totals.tokens : 0;
  if (delta > 0) children.push({ id: 'area:envelope', name: 'unattributed', color: '#d4d4d8', value: delta, sub: 'request-level fields (thinking, output_config, …) and counting drift' });
  return { id: 'root', name: `request #${rec.seq}`, color: '#18181b', children };
}

function shortLabel(p: Part): string {
  if (p.area === 'tools') return p.name || p.label;
  if (p.blockType === 'tool_use') return `call ${p.name || ''}`;
  if (p.blockType === 'tool_result') return `result ${p.name || ''}`;
  if (p.blockType === 'thinking') return 'thinking';
  return p.label.replace(/^model /, '');
}

function renderAnatomy(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const parts = a.parts;
  const sys = parts.filter((p) => p.area === 'system');
  const tools = parts.filter((p) => p.area === 'tools');
  const msgs = parts.filter((p) => p.area === 'messages');

  let html = statTiles(a) + compositionCard(a);
  html += `<div class="card"><div class="card-hd"><h3>Request map</h3><span class="desc">every field of the request body, sized by tokens · click a cell to zoom in and inspect it</span><span class="grow"></span><div class="crumbs" id="crumbs"></div></div><div class="card-bd"><div id="c-map" class="chart"></div></div></div>`;

  // request envelope: the scalar fields around system/tools/messages
  html += acc('envelope', 'Request envelope', 'model · max_tokens · thinking · context_management · metadata …', '<div id="envelope"><div class="muted small">loading…</div></div>');

  html += acc('system', 'System prompt', `${sys.length} blocks · ${fmt(sumT(sys))} tokens${a.systemTotal != null ? ` · ${fmt(a.systemTotal)} counted together` : ''}`, sys.map((p) => partRow(p, a)).join(''), true);

  const groups = new Map<string, Part[]>();
  for (const p of tools) groups.set(toolGroup(p), [...(groups.get(toolGroup(p)) || []), p]);
  const toolBody = [...groups.entries()]
    .map(([g, gp]) => acc(`tools:${g}`, `<span class="k" style="background:${kindColor(gp[0].kind || 'harness')}"></span>${esc(g)}`, `${gp.length} · ${fmt(sumT(gp))} tokens`, gp.slice().sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).map((p) => partRow(p, a)).join(''), false, true))
    .join('');
  html += acc('tools', 'Tools', `${tools.length - (tools.some((p) => p.blockType === 'framing') ? 1 : 0)} definitions · ${fmt(sumT(tools))} tokens${a.toolsTotal != null ? ` · ${fmt(a.toolsTotal)} incl. framing` : ''}`, toolBody);

  const byMsg = new Map<number, Part[]>();
  for (const p of msgs) byMsg.set(p.index, [...(byMsg.get(p.index) || []), p]);
  const called = new Set(msgs.filter((p) => p.blockType === 'tool_use').map((p) => p.name));
  const relation = acc('rel', 'Relation map · messages ↔ tools', `${byMsg.size} messages · ${called.size} of ${tools.length} tools used`, '<div id="c-rel" class="chart graph"></div>', false, true);
  const msgList = [...byMsg.entries()].map(([i, ps]) => messageRow(i, ps, a)).join('');
  html += acc('messages', 'Messages', `${byMsg.size} messages · ${msgs.length} blocks · ${fmt(sumT(msgs))} tokens`, relation + `<div id="msglist">${msgList}</div>`, true);

  v.innerHTML = html;
  drawComposition(v, a);
  S.icicle = icicle($('#c-map', v), buildMap(rec, a), { onSelect: (n, trail) => onMapSelect(n, trail, a) });
  renderCrumbs([{ id: 'root', name: `request #${rec.seq}` } as MapNode]);
  wireLegend(v);
  wireParts(v, a);
  wireAcc(v, {
    envelope: (el) => void renderEnvelope(el, rec),
    rel: (el) => drawRelation($('#c-rel', el), a),
  });
  $$<HTMLDetailsElement>('details.msg', v).forEach((d) => {
    const fill = (): void => {
      if (!d.open || d.dataset.done) return;
      d.dataset.done = '1';
      const i = Number(d.dataset.msg);
      $('.blocks', d).innerHTML = (byMsg.get(i) || []).map((p) => partRow(p, a)).join('');
      wireParts(d, a);
    };
    d.addEventListener('toggle', () => { S.acc.set(`msg:${d.dataset.msg}`, d.open); fill(); });
    fill();
  });
  if (S.selPart) markSelected(S.selPart);
}

function renderCrumbs(trail: MapNode[]): void {
  const el = document.getElementById('crumbs');
  if (!el) return;
  el.innerHTML = trail.map((n, i) => `${i ? '<span class="sep">/</span>' : ''}<span class="c" data-id="${esc(n.id)}">${esc(n.name)}</span>`).join('');
  $$('.c', el).forEach((c) => {
    c.onclick = () => {
      S.icicle?.focus(c.dataset.id!);
      renderCrumbs(trail.slice(0, trail.findIndex((n) => n.id === c.dataset.id) + 1));
    };
  });
}

function onMapSelect(n: MapNode, trail: MapNode[], a: Analysis): void {
  renderCrumbs(trail);
  if (n.id.startsWith('p:')) {
    const p = a.parts.find((x) => x.id === n.id.slice(2));
    if (p) openPart(p, a);
  } else if (n.id.startsWith('m:')) {
    openMessage(Number(n.id.slice(2)), a);
  } else if (n.id.startsWith('area:') || n.id.startsWith('tg:') || n.id === 'root') {
    openGroup(n, a);
  }
}

function messageRow(i: number, ps: Part[], a: Analysis): string {
  const role = ps[0].role;
  const tokens = sumT(ps);
  const text = ps.find((p) => p.blockType === 'text' && p.text && !/^<system-reminder>/.test(p.text.trim()))?.text || ps[0].label;
  const types = [...new Set(ps.map((p) => p.blockType))].join(' + ');
  const mini = ps.map((p) => `<div style="width:${(100 * (p.tokens || 0)) / Math.max(1, tokens)}%;background:${kindColor(dominantKind(p))}"></div>`).join('');
  const open = S.acc.get(`msg:${i}`);
  return `<details class="msg" data-msg="${i}" ${open ? 'open' : ''}><summary>
    <span class="idx">messages[${i}]</span><span class="role ${esc(role)}">${esc(role)}</span>
    <span class="prev"><span class="badge outline mono">${esc(types)}</span> ${esc(text.replace(/\s+/g, ' ').slice(0, 160))}</span>
    <span class="mini" title="blocks by token share">${mini}</span><span class="n">${fmt(tokens)} <span class="muted">${pct(tokens, a.totals.tokens)}</span></span>
  </summary><div class="blocks"></div></details>`;
}

function partRow(p: Part, a: Analysis): string {
  const total = p.tokens || 0;
  const mini = p.spans.length
    ? p.spans.map((s) => `<div style="width:${(100 * (s.end - s.start)) / Math.max(1, p.chars)}%;background:${kindColor(s.kind)}"></div>`).join('')
    : `<div style="width:100%;background:${kindColor(dominantKind(p))}"></div>`;
  const srcCount = new Set(p.spans.filter((s) => s.sourceId).map((s) => s.sourceId)).size;
  const path = partPath(p);
  const size = p.signatureChars ? `signature ${fmt(p.signatureChars)} chars` : p.blockType === 'thinking' && !p.chars ? 'encrypted · recount to measure' : `${fmt(p.chars)} chars`;
  return `<div class="part ${S.selPart === p.id ? 'sel' : ''}" data-part="${p.id}"><div class="hd">
    <span class="k" style="background:${kindColor(dominantKind(p))}"></span>
    <span class="lab">${blockBadge(p)}<span class="t">${esc(p.label)}</span><span class="sub">${p.cache ? '<span class="badge" title="cache_control breakpoint">cache ⏸</span> ' : ''}${srcCount ? `${srcCount} source${srcCount > 1 ? 's' : ''} · ` : ''}${size}</span>${path ? `<span class="path">${esc(path)}</span>` : ''}</span>
    <span class="mini" title="span composition">${mini}</span>
    <span class="n ${p.exact ? '' : 'est'}" title="${p.exact ? 'exact (count_tokens)' : 'estimate'}">${p.exact ? '' : '≈'}${fmt(total)}</span>
    <span class="n muted">${pct(total, a.totals.tokens)}</span>
  </div></div>`;
}

function wireParts(v: HTMLElement, a: Analysis): void {
  $$('.part', v).forEach((el) => {
    if (el.dataset.wired) return;
    el.dataset.wired = '1';
    const p = a.parts.find((x) => x.id === el.dataset.part);
    if (p) $('.hd', el).onclick = () => openPart(p, a);
  });
}

function markSelected(id: string | null): void {
  $$('.part.sel').forEach((x) => x.classList.remove('sel'));
  if (id) $$(`.part[data-part="${id}"]`).forEach((x) => x.classList.add('sel'));
}

async function renderEnvelope(el: HTMLElement, rec: FullRequest): Promise<void> {
  const raw = await rawFor(rec.id);
  const body = raw.request as Record<string, unknown> | string;
  if (!body || typeof body !== 'object') {
    el.innerHTML = '<div class="muted small">request body was not JSON</div>';
    return;
  }
  const env: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === 'system') env[k] = Array.isArray(v) ? `[${v.length} blocks → see System prompt]` : '(string → see System prompt)';
    else if (k === 'tools') env[k] = `[${(v as unknown[]).length} definitions → see Tools]`;
    else if (k === 'messages') env[k] = `[${(v as unknown[]).length} messages → see Messages]`;
    else env[k] = k === 'metadata' && v && typeof (v as { user_id?: unknown }).user_id === 'string' ? { ...(v as object), user_id: tryParse((v as { user_id: string }).user_id) } : v;
  }
  el.innerHTML = '<div class="muted small" style="margin:2px 2px 8px">Fields outside system / tools / messages. They are not attributed to a part, so their cost shows up in "unattributed Δ".</div>';
  el.appendChild(jsonView(env, { expand: 3 }));
}

const tryParse = (s: string): unknown => { try { return JSON.parse(s); } catch { return s; } };

// ---------------------------------------------------------------------------- side panel: part / message / group

function sidePanel(title: string, head: string, body: string): HTMLElement {
  const side = $('#side');
  $('#main').classList.add('with-side');
  side.innerHTML = `<div class="hd">${head}<span class="t" title="${esc(title)}">${esc(title)}</span><button class="ghost icon" data-act="close" title="close (Esc)">✕</button></div>${body}`;
  $<HTMLButtonElement>('[data-act=close]', side).onclick = closeSide;
  side.scrollTop = 0;
  return side;
}
function closeSide(): void {
  $('#main').classList.remove('with-side');
  S.selPart = null;
  markSelected(null);
}

function kvgrid(rows: Array<[string, string | null | undefined]>): string {
  return `<div class="kvgrid">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span>${esc(k)}</span><span>${v}</span>`).join('')}</div>`;
}

function openPart(p: Part, a: Analysis, contentTab?: 'text' | 'json'): void {
  const rec = S.rec;
  if (!rec) return;
  S.selPart = p.id;
  markSelected(p.id);
  const path = partPath(p);
  const partner = p.toolUseId ? a.parts.find((x) => x !== p && x.toolUseId === p.toolUseId && x.area === 'messages') : undefined;
  const toolDef = p.blockType === 'tool_use' ? a.parts.find((x) => x.area === 'tools' && x.name === p.name) : undefined;
  const calls = p.area === 'tools' ? a.parts.filter((x) => x.blockType === 'tool_use' && x.name === p.name) : [];
  const results = p.area === 'tools' ? a.parts.filter((x) => x.blockType === 'tool_result' && calls.some((c) => c.toolUseId === x.toolUseId)) : [];
  const linkTo = (x: Part, label: string): string => `<span class="link" data-goto="${x.id}">${esc(label)} ${esc(partPath(x) || x.id)} · ${fmtKk(x.tokens || 0)}</span>`;
  const rows: Array<[string, string | null | undefined]> = [
    ['JSON path', path ? `<span class="mono">${esc(path)}</span>` : '<span class="muted">synthetic (not a body field)</span>'],
    ['area · role', `${esc(p.area)} · ${esc(p.role)}`],
    ['block type', esc(p.blockType)],
    ['tokens', `${p.exact ? '' : '≈'}${fmt(p.tokens)} <span class="muted">${p.exact ? 'exact' : 'estimate'} · ${pct(p.tokens || 0, a.totals.tokens)} of request</span>`],
    ['chars', fmt(p.chars)],
    ['signature', p.signatureChars ? `${fmt(p.signatureChars)} chars <span class="muted">(encrypted thinking; text not sent)</span>` : null],
    ['cache breakpoint', p.cache ? 'yes (cache_control)' : null],
    ['tool', p.name ? esc(p.name) : null],
    ['tool_use_id', p.toolUseId ? `<span class="mono">${esc(p.toolUseId)}</span>` : null],
    ['error', p.isError ? '<span class="pill bad">is_error</span>' : null],
    [p.blockType === 'tool_use' ? 'result' : 'call', partner ? linkTo(partner, p.blockType === 'tool_use' ? '→' : '←') : null],
    ['definition', toolDef ? linkTo(toolDef, '⇢') : null],
    ['used in this request', p.area === 'tools' ? (calls.length ? `${calls.length} call${calls.length > 1 ? 's' : ''} · ${fmtKk(sumT(calls))} in · ${fmtKk(sumT(results))} results` : '<span class="muted">not called</span>') : null],
  ];
  const chips = p.spans.filter((s) => s.end > s.start || s.tokens).map((s, i) => `<span class="sp" data-i="${p.spans.indexOf(s)}" style="border-color:${kindColor(s.kind)};background:${kindColor(s.kind)}1f">${esc(s.label || kindLabel(s.kind))} · ${s.exact ? '' : '≈'}${fmtKk(s.tokens || 0)}${s.sourceId ? ' ↗' : ''}</span>`).join('');
  const hasText = !!p.text;
  const tab = contentTab || (hasText && (p.blockType === 'text' || p.blockType === 'tool_result' || p.area === 'system') ? 'text' : 'json');
  const callList = calls.length ? `<div class="sec"><h4>calls in this request</h4>${calls.map((c) => `<div>${linkTo(c, '•')}</div>`).join('')}</div>` : '';
  const side = sidePanel(p.label, `<span class="k" style="background:${kindColor(dominantKind(p))}"></span>${blockBadge(p)}`,
    `<div class="sec">${kvgrid(rows)}</div>
     ${chips ? `<div class="sec"><h4>attribution · ${p.spans.length} span${p.spans.length > 1 ? 's' : ''}</h4><div class="spans">${chips}</div></div>` : ''}
     ${callList}
     <div class="sec" style="padding-bottom:6px"><h4>content <span class="grow"></span><span class="tablist"><button data-ct="text" class="${tab === 'text' ? 'on' : ''}" ${hasText ? '' : 'disabled'}>verbatim</button><button data-ct="json" class="${tab === 'json' ? 'on' : ''}" ${path ? '' : 'disabled'}>json</button></span></h4></div>
     <div id="pcontent"></div>`);
  $$<HTMLElement>('[data-goto]', side).forEach((l) => {
    l.onclick = () => {
      const x = a.parts.find((q) => q.id === l.dataset.goto);
      if (x) openPart(x, a);
    };
  });
  $$<HTMLButtonElement>('[data-ct]', side).forEach((b) => {
    b.onclick = () => openPart(p, a, b.dataset.ct as 'text' | 'json');
  });
  const back = (): void => openPart(p, a, tab);
  $$<HTMLElement>('.spans .sp', side).forEach((el) => {
    const sp = p.spans[Number(el.dataset.i)];
    el.onclick = () => { if (sp.sourceId) void openSource(sp.sourceId, p.text.slice(sp.start, sp.end), back); };
  });
  const content = $('#pcontent', side);
  if (tab === 'text') {
    content.innerHTML = spanText(p);
    wireSpans(content, p, back);
  } else if (path) {
    content.innerHTML = '<div class="muted small" style="padding:10px 14px">loading…</div>';
    void rawFor(rec.id).then((raw) => {
      if (S.selPart !== p.id) return;
      content.innerHTML = '';
      const v = blockAt(raw.request, path);
      content.appendChild(jsonView(v, { expand: 2, path, maxString: 1200 }));
    });
  }
}

function openMessage(i: number, a: Analysis): void {
  const rec = S.rec;
  if (!rec) return;
  const ps = a.parts.filter((p) => p.area === 'messages' && p.index === i);
  if (!ps.length) return;
  const path = `messages[${i}]`;
  const side = sidePanel(path, `<span class="role ${esc(ps[0].role)}">${esc(ps[0].role)}</span>`,
    `<div class="sec">${kvgrid([['JSON path', `<span class="mono">${path}</span>`], ['blocks', String(ps.length)], ['tokens', `${fmt(sumT(ps))} <span class="muted">${pct(sumT(ps), a.totals.tokens)} of request</span>`]])}</div>
     <div class="sec"><h4>content blocks</h4>${ps.map((p) => `<div class="part" data-part="${p.id}"><div class="hd" style="grid-template-columns:12px minmax(0,1fr) 64px"><span class="k" style="background:${kindColor(dominantKind(p))}"></span><span class="lab">${blockBadge(p)}<span class="t">${esc(p.label)}</span></span><span class="n">${p.exact ? '' : '≈'}${fmt(p.tokens)}</span></div></div>`).join('')}</div>
     <div class="sec"><h4>json</h4></div><div id="pcontent"><div class="muted small" style="padding:10px 14px">loading…</div></div>`);
  $$('.part', side).forEach((el) => {
    const p = ps.find((x) => x.id === el.dataset.part);
    if (p) $('.hd', el).onclick = () => openPart(p, a);
  });
  void rawFor(rec.id).then((raw) => {
    const c = document.getElementById('pcontent');
    if (!c) return;
    c.innerHTML = '';
    c.appendChild(jsonView(atPath(raw.request, path), { expand: 2, path }));
  });
}

function openGroup(n: MapNode, a: Analysis): void {
  const leaves: Part[] = [];
  const walk = (m: MapNode): void => {
    if (m.id.startsWith('p:')) {
      const p = a.parts.find((x) => x.id === m.id.slice(2));
      if (p) leaves.push(p);
    }
    m.children?.forEach(walk);
  };
  walk(n);
  if (!leaves.length) {
    sidePanel(n.name, '', `<div class="sec">${kvgrid([['tokens', fmt(n.value)], ['what', esc(n.sub || '')]])}<p class="muted small">This slice is the server's reported prompt total minus the sum of every attributed part: request-level fields such as thinking settings or structured-output schemas, plus counting drift.</p></div>`);
    return;
  }
  const top = leaves.slice().sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).slice(0, 40);
  const side = sidePanel(n.name, `<span class="k" style="background:${n.color}"></span>`,
    `<div class="sec">${kvgrid([['JSON path', n.path ? `<span class="mono">${esc(n.path)}</span>` : null], ['parts', fmt(leaves.length)], ['tokens', `${fmt(sumT(leaves))} <span class="muted">${pct(sumT(leaves), a.totals.tokens)} of request</span>`]])}</div>
     <div class="sec"><h4>largest parts</h4>${top.map((p) => `<div class="part" data-part="${p.id}"><div class="hd" style="grid-template-columns:12px minmax(0,1fr) 64px"><span class="k" style="background:${kindColor(dominantKind(p))}"></span><span class="lab">${blockBadge(p)}<span class="t">${esc(p.label)}</span><span class="path">${esc(partPath(p) || '')}</span></span><span class="n">${fmtKk(p.tokens || 0)}</span></div></div>`).join('')}</div>`);
  $$('.part', side).forEach((el) => {
    const p = top.find((x) => x.id === el.dataset.part);
    if (p) $('.hd', el).onclick = () => openPart(p, a);
  });
}

const MAXTXT = 80000;
function spanText(p: Part): string {
  const text = p.text || '';
  const trunc = text.length > MAXTXT;
  let html = '';
  for (let i = 0; i < p.spans.length; i++) {
    const s = p.spans[i];
    if (s.start >= MAXTXT) break;
    const seg = text.slice(s.start, Math.min(s.end, MAXTXT));
    html += `<span class="sp ${S.hiddenKinds.has(s.kind) ? 'dim' : ''}" data-i="${i}" data-kind="${s.kind}" style="background:${kindColor(s.kind)}24;box-shadow:inset 0 -2px 0 ${kindColor(s.kind)}66">${esc(seg)}</span>`;
  }
  if (trunc) html += `\n<span class="muted">… ${fmt(text.length - MAXTXT)} more chars (see the json view or the raw tab)</span>`;
  return `<pre class="txt">${html || '<span class="muted">(empty)</span>'}</pre>`;
}

function wireSpans(el: HTMLElement, p: Part, back: () => void): void {
  $$('.txt .sp', el).forEach((s) => {
    const i = Number(s.dataset.i);
    const sp: Span = p.spans[i];
    s.onmouseenter = (ev) => {
      showTip(`<b>${esc(sp.label || kindLabel(sp.kind))}</b><div class="row"><span>tokens</span><span>${sp.exact ? '' : '≈'}${fmt(sp.tokens)}</span></div><div class="row"><span>chars</span><span>${fmt(sp.end - sp.start)}</span></div>${sp.match ? `<div class="row"><span>match</span><span>${esc(sp.match)}</span></div>` : ''}${sp.sourceId ? '<div class="muted">click to open the source</div>' : ''}`, ev);
      s.classList.add('hl');
    };
    s.onmousemove = (ev) => showTip(null, ev);
    s.onmouseleave = () => {
      hideTip();
      s.classList.remove('hl');
    };
    s.onclick = () => {
      if (sp.sourceId) void openSource(sp.sourceId, p.text.slice(sp.start, sp.end), back);
    };
  });
}

// ---------------------------------------------------------------------------- relation map (messages ↔ tools)

function drawRelation(el: HTMLElement, a: Analysis): void {
  const msgs = a.parts.filter((p) => p.area === 'messages');
  const byMsg = new Map<number, Part[]>();
  for (const p of msgs) byMsg.set(p.index, [...(byMsg.get(p.index) || []), p]);
  const idx = [...byMsg.keys()].sort((x, y) => x - y);
  const n = idx.length;
  const maxMsg = Math.max(1, ...idx.map((i) => sumT(byMsg.get(i)!)));
  const r = (t: number, max: number, lo: number, hi: number): number => lo + (hi - lo) * Math.sqrt(t / Math.max(1, max));
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const toolDefs = new Map(a.parts.filter((p) => p.area === 'tools' && p.name).map((p) => [p.name!, p]));

  // messages sit on a fixed timeline (assistant row above, user/system row below); tool hubs float above
  const xAt = (k: number): number => (n > 1 ? 0.04 + (0.92 * k) / (n - 1) : 0.5);
  idx.forEach((i, k) => {
    const ps = byMsg.get(i)!;
    const role = ps[0].role;
    const t = sumT(ps);
    const types = [...new Set(ps.map((p) => p.blockType))].join(' + ');
    nodes.push({
      id: `m:${i}`, label: `[${i}]`, color: ROLE_COLOR[role] || '#64748b', r: r(t, maxMsg, 3.5, 14),
      ax: xAt(k), ay: role === 'assistant' ? 0.58 : 0.8, fixed: true,
      labelAlways: n <= 40,
      tip: `<b>messages[${i}] · ${esc(role)}</b><div class="muted small">${esc(types)}</div><div class="row"><span>tokens</span><span>${fmt(t)}</span></div><div class="row"><span>blocks</span><span>${ps.length}</span></div><div class="muted small">click to inspect</div>`,
    });
    if (k > 0) links.push({ source: `m:${idx[k - 1]}`, target: `m:${i}`, value: 0, width: 1, tree: true, color: 'var(--border)' });
  });

  // aggregate calls (assistant message → tool) and results (tool → user message)
  const toolStats = new Map<string, { calls: number; inTok: number; outTok: number; firstK: number; msgs: number[] }>();
  const agg = new Map<string, GLink & { count: number }>();
  const add = (source: string, target: string, value: number, color: string, kind: string): void => {
    const key = `${source}>${target}`;
    const cur = agg.get(key) || { source, target, value: 0, color, count: 0, tip: kind };
    cur.value += value;
    cur.count++;
    agg.set(key, cur);
  };
  const callById = new Map<string, Part>();
  for (const p of msgs) if (p.blockType === 'tool_use' && p.toolUseId) callById.set(p.toolUseId, p);
  for (const p of msgs) {
    const k = idx.indexOf(p.index);
    if (p.blockType === 'tool_use' && p.name) {
      const st = toolStats.get(p.name) || { calls: 0, inTok: 0, outTok: 0, firstK: k, msgs: [] };
      st.calls++;
      st.inTok += p.tokens || 0;
      st.msgs.push(k);
      toolStats.set(p.name, st);
      add(`m:${p.index}`, `t:${p.name}`, p.tokens || 0, kindColor('model'), 'call');
    } else if (p.blockType === 'tool_result' && p.toolUseId) {
      const call = callById.get(p.toolUseId);
      if (!call?.name) continue;
      const st = toolStats.get(call.name);
      if (st) { st.outTok += p.tokens || 0; st.msgs.push(k); }
      add(`t:${call.name}`, `m:${p.index}`, p.tokens || 0, p.isError ? '#dc2626' : kindColor('tool-result'), 'result');
    }
  }
  const maxTool = Math.max(1, ...[...toolStats.values()].map((s) => s.inTok + s.outTok));
  for (const [name, st] of toolStats) {
    const def = toolDefs.get(name);
    const kind = def?.kind || (name.startsWith('mcp__') ? 'mcp-remote' : 'harness-tool');
    const mean = st.msgs.reduce((x, y) => x + y, 0) / st.msgs.length;
    nodes.push({
      id: `t:${name}`, label: name.replace(/^mcp__/, '').replace(/__/g, ' · '), color: kindColor(kind), r: r(st.inTok + st.outTok, maxTool, 6, 22), ring: true, labelAlways: true,
      ax: xAt(mean), ay: 0.2,
      tip: `<b>${esc(name)}</b><div class="muted small">${esc(kindLabel(kind))}</div><div class="row"><span>calls</span><span>${st.calls}</span></div><div class="row"><span>call input tokens</span><span>${fmt(st.inTok)}</span></div><div class="row"><span>result tokens</span><span>${fmt(st.outTok)}</span></div><div class="row"><span>definition tokens</span><span>${def ? fmt(def.tokens) : '–'}</span></div><div class="muted small">click to inspect the definition</div>`,
    });
  }
  for (const l of agg.values()) {
    l.tip = `<b>${l.tip === 'call' ? 'tool call' : 'tool result'}</b> ×${l.count}<div class="row"><span>tokens</span><span>${fmt(l.value)}</span></div>`;
    links.push(l);
  }
  const defined = a.parts.filter((p) => p.area === 'tools' && p.blockType !== 'framing');
  const unusedTok = sumT(defined.filter((p) => !toolStats.has(p.name || '')));
  const legend = `<span><span class="k" style="background:${ROLE_COLOR.user}"></span>user</span><span><span class="k" style="background:${ROLE_COLOR.assistant}"></span>assistant</span><span><span class="k" style="border:2px solid var(--muted-foreground);background:none"></span>tool (size = call + result tokens)</span><span><span class="k" style="background:${kindColor('model')};height:3px"></span>call</span><span><span class="k" style="background:${kindColor('tool-result')};height:3px"></span>result (width = tokens)</span><span class="muted">${defined.length - toolStats.size} defined tools unused · ${fmtKk(unusedTok)} tokens</span>`;
  if (!toolStats.size) {
    el.classList.remove('graph');
    el.innerHTML = '<div class="empty">No tool calls in this request\'s messages.</div>';
    return;
  }
  forceGraph(el, nodes, links, {
    legend, charge: -90, anchorStrength: 0.12, maxWidth: 10,
    linkDistance: () => 140,
    onClick: (g) => {
      if (g.id.startsWith('m:')) openMessage(Number(g.id.slice(2)), a);
      else {
        const def = toolDefs.get(g.id.slice(2));
        if (def) openPart(def, a);
      }
    },
  });
}

// ---------------------------------------------------------------------------- sources

function renderSources(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const usage = a.totals.sourceUsage;
  const all: UiSource[] = [...recSources(), ...(a.adhocSources || [])];
  const empty: SourceUsage = { used: false, tokens: 0, chars: 0, spans: 0, parts: [], matches: {}, coverage: 0 };
  const rows = all
    .map((s) => ({ s, u: usage[s.id] || empty }))
    .sort((x, y) => y.u.tokens - x.u.tokens || x.s.kind.localeCompare(y.s.kind) || x.s.name.localeCompare(y.s.name));
  const used = rows.filter((r) => r.u.used);
  const usedTok = used.reduce((x, r) => x + r.u.tokens, 0);
  v.innerHTML = `<div class="stats">
      ${stat('Sources in request', `${used.length}<span class="muted" style="font-size:13px"> / ${all.length}</span>`, 'inventory files that reach the model')}
      ${stat('Tokens from sources', fmt(usedTok), pct(usedTok, a.totals.tokens) + ' of the request')}
      ${stat('Built-in / conversation', fmt(a.totals.tokens - usedTok), 'harness, tools, user, model, results')}
      ${stat('Project', esc(basename(rec.projectDir) || '–'), esc(short(rec.projectDir)))}
    </div>
    <div class="card"><div class="card-hd"><h3>Source structure &amp; usage flow</h3><span class="desc">project → scope → kind → file, and where each file's tokens land in the request · size = tokens · drag, zoom, hover</span><span class="grow"></span>
      <label class="small muted" style="display:flex;gap:6px;align-items:center"><input type="checkbox" id="s-unused" ${S.showUnused ? 'checked' : ''}> show unused</label></div>
      <div class="card-bd"><div id="c-srctree" class="chart graph tall"></div></div></div>
    <div class="card"><div class="card-hd"><h3>Inventory</h3><span class="desc">"coverage" = how much of the file is present verbatim · "steps" = calls in this session that include it</span><span class="grow"></span><input class="search" id="s-filter" placeholder="Filter sources…" value="${esc(S.sourceFilter)}"></div>
      <div class="card-bd"><div class="table-wrap"><table><thead><tr><th></th><th>source</th><th>scope</th><th class="num">file size</th><th class="num">tokens here</th><th class="num">share</th><th class="num">coverage</th><th>match</th><th>where</th><th>steps</th></tr></thead><tbody id="s-rows"></tbody></table></div></div></div>`;
  const tbody = $('#s-rows', v);
  const stepsFor = sessionStepsBySource();
  const drawRows = (): void => {
    const f = S.sourceFilter.toLowerCase();
    tbody.innerHTML = rows
      .filter(({ s }) => !f || `${s.name} ${s.path} ${s.kind} ${s.scope}`.toLowerCase().includes(f))
      .map(({ s, u }) => {
        const full = s as PublicSource;
        return `<tr class="click ${u.used ? '' : 'unused'}" data-src="${s.id}">
    <td><span class="k" style="background:${kindColor(s.kind)}"></span></td>
    <td><b>${esc(s.name)}</b> <span class="muted small">${esc(kindLabel(s.kind))}${(s as AdhocSource).adhoc ? ' (outside inventory)' : ''}</span><div class="muted small mono">${esc(short(s.path))}</div>${s.description ? `<div class="small muted">${esc(s.description.slice(0, 160))}</div>` : ''}${full.hooks && full.hooks.length ? `<div class="small">hooks: ${full.hooks.map((h) => `<span class="badge">${esc(h.event)}${h.matcher ? ' ' + esc(h.matcher) : ''}</span>`).join(' ')}</div>` : ''}${full.servers ? `<div class="small">servers: ${full.servers.map((x) => `<span class="badge">${esc(x.name)}</span>`).join(' ')}</div>` : ''}</td>
    <td>${esc(s.scope)}</td><td class="num">${fmt(s.size)}</td><td class="num">${u.used ? fmt(u.tokens) : '<span class="muted">not sent</span>'}</td><td class="num">${u.used ? pct(u.tokens, a.totals.tokens) : ''}</td><td class="num">${u.used ? pct(u.chars, s.size || u.chars) : ''}</td>
    <td class="small">${Object.entries(u.matches).map(([k, n]) => `<span class="badge outline">${esc(k)}×${n}</span>`).join(' ')}</td>
    <td class="small">${u.parts.slice(0, 8).map((pid) => { const p = a.parts.find((x) => x.id === pid); return p ? `<span class="link" data-part="${p.id}" title="${esc(p.label)}">${esc(partPath(p) || p.id)}</span>` : ''; }).join(' ')}${u.parts.length > 8 ? ` <span class="muted">+${u.parts.length - 8}</span>` : ''}</td>
    <td class="small mono">${(stepsFor.get(s.id) || []).join(' ')}</td>
  </tr>`;
      })
      .join('');
    $$('tr[data-src]', tbody).forEach((tr) => {
      tr.onclick = (ev) => {
        const link = (ev.target as HTMLElement).closest<HTMLElement>('[data-part]');
        const p = link && a.parts.find((x) => x.id === link.dataset.part);
        if (p) return openPart(p, a);
        void openSource(tr.dataset.src!);
      };
    });
  };
  drawRows();
  $<HTMLInputElement>('#s-filter', v).oninput = (e) => {
    S.sourceFilter = (e.target as HTMLInputElement).value;
    drawRows();
  };
  $<HTMLInputElement>('#s-unused', v).onchange = (e) => {
    S.showUnused = (e.target as HTMLInputElement).checked;
    drawSourceTree($('#c-srctree', v), rec, a, all);
  };
  drawSourceTree($('#c-srctree', v), rec, a, all);
  if (!S.sessionAnalyses.size) void ensureSessionAnalyses().then(() => { if (S.tab === 'sources' && S.rec === rec) drawRows(); });
}

function drawSourceTree(el: HTMLElement, rec: FullRequest, a: Analysis, all: UiSource[]): void {
  const usage = a.totals.sourceUsage;
  const nodes: GNode[] = [];
  const links: GLink[] = [];
  const has = new Set<string>();
  const node = (n: GNode): void => { if (!has.has(n.id)) { has.add(n.id); nodes.push(n); } };
  const maxTok = Math.max(1, ...all.map((s) => usage[s.id]?.tokens || 0), ...Object.values(a.totals.byKind).map((k) => k!.tokens));
  const rad = (t: number): number => 4 + 16 * Math.sqrt(t / maxTok);

  node({ id: 'root', label: basename(rec.projectDir) || 'project', color: '#18181b', r: 13, ax: 0.3, ay: 0.5, fixed: true, labelAlways: true, tip: `<b>${esc(short(rec.projectDir))}</b><div class="muted small">project root of this session</div>` });
  const areas: Array<[string, string, number]> = [['system', 'System prompt', 0.2], ['tools', 'Tools', 0.5], ['messages', 'Messages', 0.8]];
  for (const [k, label, y] of areas) {
    const t = a.totals.byArea[k as 'system']?.tokens || 0;
    node({ id: `area:${k}`, label: `${label} · ${fmtKk(t)}`, color: AREA_COLOR[k], r: 8 + 12 * Math.sqrt(t / Math.max(1, a.totals.tokens)), ax: 0.88, ay: y, fixed: true, labelAlways: true, tip: `<b>${label}</b><div class="row"><span>tokens</span><span>${fmt(t)}</span></div>` });
  }
  // per-source → area token sums from the spans
  const flows = new Map<string, number>();
  const kindFlows = new Map<string, number>();
  for (const p of a.parts) for (const s of p.spans) {
    const key = s.sourceId ? `${s.sourceId}|${p.area}` : `${s.kind}|${p.area}`;
    (s.sourceId ? flows : kindFlows).set(key, ((s.sourceId ? flows : kindFlows).get(key) || 0) + (s.tokens || 0));
  }
  for (const s of all) {
    const u = usage[s.id];
    if (!u?.used && !S.showUnused) continue;
    const scope = `scope:${s.scope}`;
    const kind = `kind:${s.scope}:${s.kind}`;
    node({ id: scope, label: s.scope, color: '#3f3f46', r: 9, labelAlways: true, tip: `<b>scope: ${esc(s.scope)}</b>` });
    node({ id: kind, label: kindLabel(s.kind), color: kindColor(s.kind), r: 6.5, labelAlways: true, tip: `<b>${esc(kindLabel(s.kind))}</b><div class="muted small">${esc(s.scope)} scope</div>` });
    if (!links.some((l) => l.source === 'root' && l.target === scope)) links.push({ source: 'root', target: scope, value: 0, width: 1.6, tree: true, color: 'var(--muted-foreground)' });
    if (!links.some((l) => l.source === scope && l.target === kind)) links.push({ source: scope, target: kind, value: 0, width: 1.3, tree: true, color: 'var(--muted-foreground)' });
    node({
      id: `src:${s.id}`, label: s.name, color: kindColor(s.kind), r: u?.used ? rad(u.tokens) : 3.5, dim: !u?.used, ring: !u?.used,
      labelAlways: !!u?.used,
      tip: `<b>${esc(s.name)}</b><div class="mono muted small">${esc(short(s.path))}</div><div class="row"><span>kind</span><span>${esc(kindLabel(s.kind))}</span></div><div class="row"><span>tokens here</span><span>${u?.used ? fmt(u.tokens) : 'not sent'}</span></div>${u?.used ? `<div class="row"><span>coverage</span><span>${pct(u.chars, s.size || u.chars)}</span></div><div class="row"><span>parts</span><span>${u.parts.length}</span></div>` : ''}<div class="muted small">click to open the file</div>`,
    });
    links.push({ source: kind, target: `src:${s.id}`, value: 0, width: 1, tree: true, color: 'var(--muted-foreground)' });
  }
  // built-in producers (no file): harness, tools, conversation
  for (const [key, t] of kindFlows) {
    const [kind] = key.split('|');
    if (t <= 0) continue;
    node({ id: 'scope:built-in', label: 'built-in & conversation', color: '#3f3f46', r: 9, labelAlways: true, tip: '<b>built-in & conversation</b><div class="muted small">tokens not produced by an inventory file</div>' });
    if (!links.some((l) => l.target === 'scope:built-in')) links.push({ source: 'root', target: 'scope:built-in', value: 0, width: 1.6, tree: true, color: 'var(--muted-foreground)', dash: '3 3' });
    const tot = a.totals.byKind[kind as SourceKind]?.tokens || 0;
    node({ id: `bk:${kind}`, label: kindLabel(kind), color: kindColor(kind), r: rad(tot), labelAlways: true, tip: `<b>${esc(kindLabel(kind))}</b><div class="row"><span>tokens</span><span>${fmt(tot)}</span></div>` });
    if (!links.some((l) => l.target === `bk:${kind}`)) links.push({ source: 'scope:built-in', target: `bk:${kind}`, value: 0, width: 1, tree: true, color: 'var(--muted-foreground)' });
  }
  const flowLink = (from: string, area: string, t: number, color: string, label: string): void => {
    if (t <= 0 || !has.has(from)) return;
    links.push({ source: from, target: `area:${area}`, value: t, color, tip: `<b>${esc(label)} → ${area}</b><div class="row"><span>tokens</span><span>${fmt(t)}</span></div>` });
  };
  for (const [key, t] of flows) {
    const [id, area] = key.split('|');
    const s = all.find((x) => x.id === id);
    flowLink(`src:${id}`, area, t, s ? kindColor(s.kind) : '#94a3b8', s?.name || id);
  }
  for (const [key, t] of kindFlows) {
    const [kind, area] = key.split('|');
    flowLink(`bk:${kind}`, area, t, kindColor(kind), kindLabel(kind));
  }
  forceGraph(el, nodes, links, {
    charge: -200, anchorStrength: 0.08, maxWidth: 12,
    linkDistance: (l) => (l.tree ? 46 : 220),
    legend: '<span>grey lines: structure (project → scope → kind → file)</span><span>coloured curves: usage flow into request areas, width = tokens</span><span>hollow dots: files not sent</span>',
    onClick: (g) => {
      if (g.id.startsWith('src:')) void openSource(g.id.slice(4));
    },
  });
}

function sessionStepsBySource(): Map<string, string[]> {
  const m = new Map<string, string[]>();
  const sess = S.sessions.find((s) => s.id === S.selSession);
  if (!sess) return m;
  for (const r of sess.requests) {
    const a = S.sessionAnalyses.get(r.id);
    if (!a) continue;
    for (const [sid, u] of Object.entries(a.totals.sourceUsage || {})) {
      if (!u.used) continue;
      const arr = m.get(sid) || [];
      arr.push('#' + r.seq);
      m.set(sid, arr);
    }
  }
  return m;
}

async function ensureSessionAnalyses(): Promise<void> {
  const sess = S.sessions.find((s) => s.id === S.selSession);
  if (!sess) return;
  await Promise.all(
    sess.requests.map(async (r) => {
      if (S.sessionAnalyses.has(r.id) && r.status != null) return;
      try {
        const rec = await api<{ analysis: SlimAnalysis | null }>(`/api/requests/${r.id}`);
        if (rec.analysis) S.sessionAnalyses.set(r.id, rec.analysis);
      } catch {}
    }),
  );
}

// ---------------------------------------------------------------------------- diff

function renderDiff(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const d = a.diff;
  if (!d) {
    v.innerHTML = statTiles(a) + '<div class="card"><div class="empty">First agent turn in this session (or a side call), so there is nothing to compare against.</div></div>';
    return;
  }
  const prev = S.sessions.find((s) => s.id === rec.sessionId)?.requests.find((r) => r.id === a.prevId);
  const row = (cls: string, sign: string, x: DiffEntry): string => `<tr class="click" data-part="${esc(x.id)}"><td class="${cls}" style="font-weight:700">${sign}</td><td>${esc(x.label)} <div class="muted small mono">${esc(x.key)}</div></td><td class="num">${x.prevTokens != null ? `<span class="muted">${fmt(x.prevTokens)} →</span> ` : ''}${fmt(x.tokens)}</td><td class="num ${cls}">${x.prevTokens != null ? `${(x.tokens || 0) - x.prevTokens >= 0 ? '+' : ''}${fmt((x.tokens || 0) - x.prevTokens)}` : `${sign === '−' ? '−' : '+'}${fmt(x.tokens)}`}</td><td class="num">${x.prevChars != null ? `<span class="muted">${fmt(x.prevChars)} →</span> ` : ''}${fmt(x.chars)}</td></tr>`;
  v.innerHTML = `<div class="stats">
      ${stat('Compared with', prev ? `#${prev.seq}` : '?', 'previous agent turn')}
      ${stat('Added', `+${fmt(d.addedTokens)}`, `${d.added.length} parts`, 'add')}
      ${stat('Removed', `−${fmt(d.removedTokens)}`, `${d.removed.length} parts`, 'rem')}
      ${stat('Changed', `${d.changedDelta >= 0 ? '+' : ''}${fmt(d.changedDelta)}`, `${d.changed.length} parts`, 'chg')}
      ${stat('Unchanged', fmt(d.sameCount), 'parts')}
      ${a.cache ? stat('Cache read / write', `${fmtKk(a.cache.read)} / ${fmtKk(a.cache.write)}`, `uncached ${fmt(a.cache.uncached)}`) : ''}
    </div>
    <div class="card diff"><div class="card-hd"><h3>Changed parts</h3><span class="desc">click a row to inspect the part in this request</span></div><div class="card-bd"><div class="table-wrap"><table><thead><tr><th></th><th>part</th><th class="num">tokens</th><th class="num">Δ</th><th class="num">chars</th></tr></thead><tbody>
    ${d.added.map((x) => row('add', '+', x)).join('')}${d.changed.map((x) => row('chg', '~', x)).join('')}${d.removed.map((x) => row('rem', '−', x)).join('')}</tbody></table></div></div></div>`;
  $$('tr[data-part]', v).forEach((tr) => {
    const p = a.parts.find((x) => x.id === tr.dataset.part);
    if (p) tr.onclick = () => openPart(p, a);
    else tr.classList.remove('click');
  });
}

// ---------------------------------------------------------------------------- response

function renderResponse(v: HTMLElement, rec: FullRequest): void {
  const r = rec.response;
  if (!r) {
    v.innerHTML = '<div class="card"><div class="empty">No response yet.</div></div>';
    return;
  }
  const u = r.usage || {};
  v.innerHTML = `<div class="stats">
    ${stat('Status', `${rec.status ?? '–'}`, esc(r.stop_reason || ''), rec.status && rec.status >= 400 ? 'rem' : '')}
    ${stat('Output tokens', fmt(u.output_tokens))}
    ${stat('Input (uncached)', fmt(u.input_tokens))}
    ${stat('Cache read', fmt(u.cache_read_input_tokens))}
    ${stat('Cache write', fmt(u.cache_creation_input_tokens))}
    ${stat('Duration', `${fmt(rec.durationMs)}<span class="muted" style="font-size:12px"> ms</span>`, `TTFB ${fmt(rec.ttfbMs)} ms${rec.ttftMs ? ` · first token ${fmt(rec.ttftMs)} ms` : ''}`)}
    ${stat('SSE events', fmt(r.eventCount))}
  </div><div id="resp-blocks" style="display:flex;flex-direction:column;gap:10px"></div>`;
  const list = $('#resp-blocks', v);
  if (r.error) {
    const c = card(`<span class="pill bad">error</span> ${esc(r.error.type)}`, '');
    $('.card-bd', c).appendChild(jsonView(r.error, { expand: 3 }));
    list.appendChild(c);
  }
  (r.content || []).forEach((b, i) => {
    const blk = b as unknown as Record<string, unknown>;
    const path = `content[${i}]`;
    const c = card(`<span class="badge outline mono">${esc(b.type)}</span> ${blk.name ? `<b>${esc(blk.name)}</b>` : ''}`, `<span class="mono muted small">${path}</span>`);
    const bd = $('.card-bd', c);
    if (b.type === 'text' || b.type === 'thinking') {
      const t = String(b.type === 'text' ? blk.text : blk.thinking || '');
      bd.innerHTML = `<pre class="txt">${t ? esc(t) : `<span class="muted">(empty${blk.signature ? `; encrypted signature ${fmt(String(blk.signature).length)} chars` : ''})</span>`}</pre>`;
    } else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      bd.innerHTML = `<div class="small muted" style="margin-bottom:6px">id <span class="mono">${esc(blk.id)}</span></div>`;
      bd.appendChild(jsonView(blk.input, { expand: 4, path: `${path}.input`, maxString: 2000 }));
    } else {
      bd.appendChild(jsonView(blk, { expand: 2, path }));
    }
    list.appendChild(c);
  });
  if (r.context_management) {
    const c = card('context_management', '');
    $('.card-bd', c).appendChild(jsonView(r.context_management, { expand: 4 }));
    list.appendChild(c);
  }
}

function card(title: string, right: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `<div class="card-hd"><h3 style="display:flex;gap:8px;align-items:center">${title}</h3><span class="grow"></span>${right}</div><div class="card-bd"></div>`;
  return el;
}

// ---------------------------------------------------------------------------- raw

async function renderRaw(v: HTMLElement, rec: FullRequest): Promise<void> {
  v.innerHTML = '<div class="card"><div class="empty">loading…</div></div>';
  const raw = await rawFor(rec.id);
  if (S.rec !== rec || S.tab !== 'raw') return;
  const size = (x: unknown): number => (typeof x === 'string' ? x.length : JSON.stringify(x ?? null).length);
  v.innerHTML = `<div class="card"><div class="card-bd toolbar">
      <input class="search" id="r-path" placeholder="Jump to path, e.g. messages[3].content[0]" style="flex:1">
      <span class="small muted">expand</span><button data-depth="1">1</button><button data-depth="2">2</button><button data-depth="3">3</button>
      <button data-copy="request">copy body</button><button data-copy="response">copy response</button>
    </div></div>` +
    acc('raw:reqh', 'Request headers', `${Object.keys((raw.headers as object) || {}).length} headers · credentials redacted`, '', false) +
    acc('raw:req', 'Request body', `${fmt(size(raw.request))} chars`, '', true) +
    acc('raw:resh', 'Response headers', `${Object.keys((raw.responseHeaders as object) || {}).length} headers`, '', false) +
    acc('raw:res', 'Response (assembled from the stream)', `${fmt(size(raw.response))} chars`, '', true);
  const mount = (key: string, value: unknown, expand: number, reveal?: string): void => {
    const d = $<HTMLDetailsElement>(`details[data-acc="${key}"]`, v);
    const bd = $('.acc-bd', d);
    bd.innerHTML = '';
    bd.appendChild(jsonView(typeof value === 'string' ? tryParse(value) : value, { expand, reveal }));
  };
  mount('raw:reqh', raw.headers, 1);
  mount('raw:req', raw.request, 1);
  mount('raw:resh', raw.responseHeaders, 1);
  mount('raw:res', raw.response, 2);
  $$<HTMLDetailsElement>('details[data-acc]', v).forEach((d) => d.addEventListener('toggle', () => S.acc.set(d.dataset.acc!, d.open)));
  $$<HTMLButtonElement>('[data-depth]', v).forEach((b) => {
    b.onclick = () => $$('.acc-bd > .jt', v).forEach((jt) => expandAll(jt, Number(b.dataset.depth)));
  });
  $$<HTMLButtonElement>('[data-copy]', v).forEach((b) => {
    b.onclick = async () => {
      const val = b.dataset.copy === 'request' ? raw.request : raw.response;
      await navigator.clipboard.writeText(typeof val === 'string' ? val : JSON.stringify(val, null, 2));
      const t = b.textContent;
      b.textContent = 'copied ✓';
      setTimeout(() => (b.textContent = t), 1200);
    };
  });
  $<HTMLInputElement>('#r-path', v).onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const path = (e.target as HTMLInputElement).value.trim().replace(/^\$\.?/, '');
    const d = $<HTMLDetailsElement>('details[data-acc="raw:req"]', v);
    d.open = true;
    mount('raw:req', raw.request, 1, path);
  };
}

// ---------------------------------------------------------------------------- session overview

function renderSessionOverview(): void {
  void ensureSessionAnalyses().then(() => {
    if (S.rec && S.rec.sessionId === S.selSession) {
      if (S.tab === 'sources') renderCenter(true);
      return;
    }
    const sess = S.sessions.find((s) => s.id === S.selSession);
    if (!sess) return;
    const c = $('#center');
    const reqs = sess.requests.filter((r) => S.sessionAnalyses.has(r.id));
    const main = reqs.filter((r) => (r.kind || '').startsWith('main'));
    const out = sess.requests.reduce((x, r) => x + (r.usage.output || 0), 0);
    const peak = Math.max(0, ...reqs.map((r) => S.sessionAnalyses.get(r.id)!.totals.tokens));
    c.innerHTML = `<div class="view"><div class="stats">
        ${stat('Session', esc(sess.agent || basename(sess.projectDir) || sess.id.slice(0, 8)), new Date(sess.startedAt).toLocaleString())}
        ${stat('Calls', fmt(sess.requests.length), `${main.length} agent turns · ${reqs.length - main.length} side calls`)}
        ${stat('Peak context', fmt(peak), 'sum of parts, largest step')}
        ${stat('Output tokens', fmt(out), 'all calls')}
      </div>
      <div class="card"><div class="card-hd"><h3>Context per step</h3><span class="desc">stacked by source kind · faded columns are side calls · click a column to open that step</span></div><div class="card-bd"><div id="c-steps" class="chart"></div></div></div></div>`;
    stepColumns($('#c-steps', c), reqs.map((r) => {
      const a = S.sessionAnalyses.get(r.id)!;
      return { id: r.id, seq: r.seq || 0, label: r.kind || '', total: a.totals.tokens, parts: kindSlices(a), side: !(r.kind || '').startsWith('main') };
    }), (id) => void select(id));
  });
}

async function openSource(id: string, matchedText?: string, back?: () => void): Promise<void> {
  const fallback = [...recSources(), ...(S.rec?.adhocSources || [])].find((x) => x.id === id) as PublicSource | undefined;
  return renderSourcePanel(id, fallback, matchedText, back);
}

// ---------------------------------------------------------------------------- live + keys

function live(): void {
  const es = new EventSource(BASE + '/events');
  const refresh = async (data?: RequestSummary): Promise<void> => {
    S.sessions = await api<SessionSummary[]>('/api/sessions');
    const st = await api<State>('/api/state');
    S.state = st;
    S.sources = st.inventory.sources;
    renderHeaderPills();
    if (!S.sel && data && data.id) {
      S.selSession = data.sessionId;
      void select(data.id);
    } else {
      renderLeft();
      renderGraphLink();
    }
  };
  const parse = (e: Event): RequestSummary => JSON.parse((e as MessageEvent).data) as RequestSummary;
  es.addEventListener('request', (e) => {
    const d = parse(e);
    void refresh(d).then(() => {
      if (!S.sel) void select(d.id);
    });
  });
  es.addEventListener('response', (e) => {
    const d = parse(e);
    void refresh(d);
    if (S.sel === d.id) void select(d.id);
  });
  es.addEventListener('analysis', (e) => {
    const d = parse(e);
    void refresh(d);
    S.sessionAnalyses.delete(d.id);
    if (S.sel === d.id) {
      S.raw = null;
      void select(d.id);
    }
  });
  es.addEventListener('inventory', () => void refresh());
  es.addEventListener('cleared', () => {
    S.sel = null;
    S.rec = null;
    S.sessionAnalyses.clear();
    location.reload();
  });
}

document.addEventListener('keydown', (e) => {
  if (e.target instanceof Element && e.target.closest('input,textarea,select')) return;
  if (e.key === 'Escape') return closeSide();
  if (e.key !== 'j' && e.key !== 'k') return;
  const sess = S.sessions.find((s) => s.id === S.selSession);
  if (!sess) return;
  const i = sess.requests.findIndex((r) => r.id === S.sel);
  const next = sess.requests[i + (e.key === 'j' ? 1 : -1)];
  if (next) void select(next.id);
});

$<HTMLButtonElement>('#b-rescan').onclick = () => void api('/api/rescan', { method: 'POST' });
$<HTMLButtonElement>('#b-clear').onclick = () => {
  if (confirm('Delete all captured sessions?')) void api('/api/clear', { method: 'POST' });
};
void loadState().then(live);
