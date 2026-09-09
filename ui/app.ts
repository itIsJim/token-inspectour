// token-inspectour UI. Compiled by `tsc -p tsconfig.ui.json` to dist/ui/app.js and served
// under /<agent>/app.js. Type-only imports are erased, so the output has no module imports.
import type * as CyNS from 'cytoscape';
import type { Analysis, DiffEntry, Part, PublicSource, RequestSummary, SessionSummary, SourceUsage, Span, AdhocSource, AssembledResponse, SlimAnalysis, GraphData, GraphNodeData } from '../src/types.js';

type Kinds = Record<string, { label: string; color: string }>;
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

const meta = (n: string): string => (document.querySelector(`meta[name="${n}"]`) as HTMLMetaElement | null)?.content || '';
const BASE = meta('inspectour-base');
const NAME = meta('inspectour-name');

const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document): T => el.querySelector(s) as T;
const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document): T[] => Array.from(el.querySelectorAll(s)) as T[];
const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
const fmt = (n: number | null | undefined): string => (n == null ? '–' : n.toLocaleString());
const pct = (a: number, b: number | undefined): string => (b ? ((100 * a) / b).toFixed(1) + '%' : '–');
const short = (p: string | null | undefined): string => (p || '').replace(/^\/Users\/[^/]+/, '~');
const basename = (p: string | null | undefined): string => (p || '').split('/').pop() || '';

const G = {
  cy: null as CyNS.Core | null,
  mode: 'flow' as 'flow' | 'context',
  dir: 'LR' as 'LR' | 'TB',
  data: null as GraphData | null,
  key: '' as string, // what the current drawing represents (session/request + mode)
  refreshT: 0 as number,
  on: false,
};

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
};

async function api<T>(p: string, opt?: RequestInit): Promise<T> {
  const r = await fetch(BASE + p, opt);
  if (!r.ok) throw new Error(p + ' ' + r.status);
  return r.json() as Promise<T>;
}
const kindColor = (k: string): string => S.kinds[k]?.color || '#94a3b8';
const kindLabel = (k: string): string => S.kinds[k]?.label || k;
const recSources = (): PublicSource[] => S.rec?.inventory?.sources || S.sources;

async function loadState(): Promise<void> {
  S.state = await api<State>('/api/state');
  S.kinds = S.state.kinds;
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
  const first = S.sessions[0];
  if (!S.sel && first && first.requests.length) {
    S.selSession = first.id;
    void select(first.requests[first.requests.length - 1].id);
  }
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
  left.innerHTML = S.sessions
    .map((s) => {
      const open = s.id === S.selSession;
      const main = s.requests.filter((r) => r.kind === 'main');
      const last = main[main.length - 1];
      const tot = last && last.usage ? (last.usage.input || 0) + (last.usage.cacheRead || 0) + (last.usage.cacheWrite || 0) : null;
      const proj = basename(s.projectDir);
      const title = s.agent || proj || s.id.slice(0, 8);
      return `<div class="sess ${open ? 'sel' : ''}" data-id="${s.id}">
      <div class="hd" data-sess="${s.id}" title="${esc(s.projectDir || '')}"><span>${open ? '▾' : '▸'}</span><b>${esc(title)}</b>${s.agent && proj && s.agent !== proj ? `<span class="muted small">${esc(proj)}</span>` : ''}<span class="muted small">${new Date(s.startedAt).toLocaleString()}</span><span class="grow"></span><span class="small mono">${s.requests.length} calls${tot ? ` · ctx ${fmt(tot)}` : ''}</span></div>
      ${open ? s.requests.map((r) => reqRow(r)).join('') : ''}
    </div>`;
    })
    .join('');
  $$('[data-sess]', left).forEach((h) => {
    h.onclick = () => {
      const id = h.dataset.sess!;
      S.selSession = S.selSession === id ? null : id;
      renderLeft();
      if (G.on) void drawGraph(true);
      else if (S.selSession) renderSessionOverview();
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
  const head = side ? `<span class="pill">${esc(kind.replace('side:', ''))}</span>` : kind.startsWith('main:') ? `<b>${esc(kind.slice(5))}</b>` : '<b>turn</b>';
  return `<div class="req ${side ? 'side' : ''} ${r.id === S.sel ? 'sel' : ''}" data-id="${r.id}">
    <span class="seq">#${r.seq}</span>
    <span>${head} <span class="muted small">${esc((r.model || '').replace('claude-', ''))}</span> ${st}</span>
    <span class="tok" title="prompt tokens from usage: uncached + cache read + cache write | output">${tot != null ? fmt(tot) : '…'}${u.output != null ? ` <span class="muted">→${fmt(u.output)}</span>` : ''}</span>
    <span class="prev">${esc(r.userPreview || '')}${r.assistantPreview ? ` <span class="muted">⇢ ${esc(r.assistantPreview)}</span>` : ''}</span>
  </div>`;
}

async function select(id: string): Promise<void> {
  S.sel = id;
  const rec = await api<FullRequest>(`/api/requests/${id}?full=1`);
  S.rec = rec;
  S.selSession = rec.sessionId;
  renderLeft();
  renderCenter();
  if (G.on) void drawGraph(true);
}

function renderCenter(): void {
  const rec = S.rec;
  if (!rec) return;
  const c = $('#center');
  const tabs: Tab[] = ['anatomy', 'sources', 'diff', 'response', 'raw'];
  c.innerHTML = `<div class="tabs">${tabs.map((t) => `<button class="${S.tab === t ? 'on' : ''}" data-tab="${t}">${t}</button>`).join('')}
    <span class="grow"></span><span class="small muted" style="padding:6px 8px">#${rec.seq} · ${esc(rec.kind)} · ${esc(rec.model || '')} · ${rec.durationMs ? rec.durationMs + ' ms' : 'in flight'}${rec.ttftMs ? ` · first token ${rec.ttftMs} ms` : ''}</span>
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
    case 'anatomy': return renderAnatomy(v, rec, a);
    case 'sources': return renderSources(v, rec, a);
    case 'diff': return renderDiff(v, rec, a);
    case 'response': return renderResponse(v, rec);
    case 'raw': return void renderRaw(v, rec);
  }
}

function wireLegend(v: HTMLElement): void {
  $$('.legend .item', v).forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.kind!;
      if (S.hiddenKinds.has(k)) S.hiddenKinds.delete(k);
      else S.hiddenKinds.add(k);
      renderCenter();
    };
  });
}

function summaryBlock(a: Analysis): string {
  const t = a.totals;
  const kinds = Object.entries(t.byKind).sort((x, y) => y[1]!.tokens - x[1]!.tokens);
  const total = t.tokens || 1;
  const u = a.cache;
  const bar = `<div class="bar" id="kindbar">${kinds.map(([k, v]) => `<div style="width:${(100 * v!.tokens) / total}%;background:${kindColor(k)}" data-kind="${k}" title="${esc(kindLabel(k))}: ${fmt(v!.tokens)} tokens (${pct(v!.tokens, total)})"></div>`).join('')}</div>`;
  const legend = `<div class="legend">${kinds.map(([k, v]) => `<span class="item ${S.hiddenKinds.has(k) ? 'off' : ''}" data-kind="${k}"><span class="k" style="background:${kindColor(k)}"></span>${esc(kindLabel(k))} <b class="mono">${fmt(v!.tokens)}</b> <span class="muted">${pct(v!.tokens, total)}</span></span>`).join('')}</div>`;
  const exactNote = a.exactTotal ? `<span class="pill ok">exact: ${a.counted}/${a.partCount} parts counted</span>` : a.counted ? `<span class="pill warn">partially exact: ${a.counted}/${a.partCount} parts</span>` : '<span class="pill">estimated (≈)</span>';
  const usage = u ? `<span class="stat">prompt (server usage) <b>${fmt(a.promptTotalFromUsage)}</b></span><span class="stat">cache read <b>${fmt(u.read)}</b></span><span class="stat">cache write <b>${fmt(u.write)}</b></span><span class="stat">uncached <b>${fmt(u.uncached)}</b></span>` : '<span class="stat muted">no usage yet</span>';
  const delta = a.promptTotalFromUsage != null ? a.promptTotalFromUsage - t.tokens : null;
  const sum = `<span class="stat">sum of parts <b>${fmt(t.tokens)}</b></span>${delta != null ? `<span class="stat" title="server usage total minus the sum of attributed parts: request-level extras such as structured-output schemas, thinking config, or counting drift">unattributed Δ <b>${delta >= 0 ? '+' : ''}${fmt(delta)}</b></span>` : ''}${a.toolsOverhead != null ? `<span class="stat" title="tokens the API adds for the tool-use system prompt beyond the individual tool definitions">tools framing overhead <b>${fmt(a.toolsOverhead)}</b></span>` : ''}`;
  return `<div style="margin-bottom:10px">${bar}${legend}<div class="small">${usage} ${sum} ${exactNote}</div></div>`;
}

function renderAnatomy(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const parts = a.parts;
  const grp = (area: string) => parts.filter((p) => p.area === area);
  const sumT = (ps: Part[]) => ps.reduce((x, p) => x + (p.tokens || 0), 0);
  let html = summaryBlock(a);
  const areas: Array<[string, string]> = [['system', 'System prompt'], ['tools', 'Tools'], ['messages', 'Messages']];
  for (const [area, label] of areas) {
    const ps = grp(area);
    if (!ps.length) continue;
    html += `<div class="group"><h3>${label} <span class="sum">${ps.length} parts · ${fmt(sumT(ps))} tokens${area === 'tools' && a.toolsTotal != null ? ` · ${fmt(a.toolsTotal)} incl. framing` : ''}${area === 'system' && a.systemTotal != null ? ` · ${fmt(a.systemTotal)} counted together` : ''}</span></h3>`;
    if (area === 'tools') {
      const groups: Record<string, Part[]> = {};
      for (const p of ps) {
        const g = p.blockType === 'framing' ? 'Tool-use framing (added by the API once per request)' : p.kind === 'harness-tool' ? 'Built-in tools' : `MCP: ${(p.name || '').split('__')[1]}`;
        (groups[g] ||= []).push(p);
      }
      for (const [g, gp] of Object.entries(groups)) html += `<details class="toolgrp"><summary><span class="k" style="background:${kindColor(gp[0].kind || 'harness')}"></span>${esc(g)} <span class="n">${gp.length} tools · ${fmt(sumT(gp))} tokens</span></summary>${gp.sort((x, y) => (y.tokens || 0) - (x.tokens || 0)).map((p) => partRow(p, a)).join('')}</details>`;
    } else html += ps.map((p) => partRow(p, a)).join('');
    html += '</div>';
  }
  v.innerHTML = html;
  wireParts(v, a);
  wireLegend(v);
}

function partRow(p: Part, a: Analysis): string {
  const total = p.tokens || 0;
  const mini = p.spans.map((s) => `<div style="width:${(100 * (s.end - s.start)) / Math.max(1, p.chars)}%;background:${kindColor(s.kind)}"></div>`).join('');
  const roleTag = p.area === 'messages' ? `<span class="pill">${esc(p.role)}${p.blockType !== 'text' ? ' · ' + esc(p.blockType) : ''}</span> ` : '';
  const srcCount = new Set(p.spans.filter((s) => s.sourceId).map((s) => s.sourceId)).size;
  return `<div class="part" data-part="${p.id}"><div class="hd">
    <span class="k" style="background:${kindColor(p.spans.length === 1 ? p.spans[0].kind : 'harness')}"></span>
    <span class="lab">${roleTag}${esc(p.label)}<span class="sub">${p.cache ? '<span class="pill" title="cache_control breakpoint">cache ⏸</span> ' : ''}${srcCount ? `${srcCount} source${srcCount > 1 ? 's' : ''} · ` : ''}${fmt(p.chars)} chars</span></span>
    <span class="mini" title="span composition">${mini}</span>
    <span class="n ${p.exact ? '' : 'est'}" title="${p.exact ? 'exact (count_tokens)' : 'estimate'}">${p.exact ? '' : '≈'}${fmt(total)}</span>
    <span class="n muted">${pct(total, a.totals.tokens)}</span>
  </div><div class="body"></div></div>`;
}

function wireParts(v: HTMLElement, a: Analysis): void {
  $$('.part', v).forEach((el) => {
    const p = a.parts.find((x) => x.id === el.dataset.part);
    if (!p) return;
    $('.hd', el).onclick = () => {
      el.classList.toggle('open');
      if (el.classList.contains('open') && !el.dataset.done) {
        el.dataset.done = '1';
        $('.body', el).innerHTML = partBody(p);
        wireSpans(el, p);
      }
    };
  });
  applyHidden(v);
}

function applyHidden(v: HTMLElement): void {
  $$('.txt span.sp', v).forEach((s) => s.classList.toggle('dim', S.hiddenKinds.has(s.dataset.kind || '')));
}

const MAXTXT = 60000;
function partBody(p: Part): string {
  const chips = p.spans.map((s, i) => `<span class="sp" data-i="${i}" style="border-color:${kindColor(s.kind)};background:${kindColor(s.kind)}22">${esc(s.label || kindLabel(s.kind))} · ${s.exact ? '' : '≈'}${fmt(s.tokens)}</span>`).join('');
  const text = p.text || '';
  const trunc = text.length > MAXTXT;
  let html = '';
  for (let i = 0; i < p.spans.length; i++) {
    const s = p.spans[i];
    if (s.start >= MAXTXT) break;
    const seg = text.slice(s.start, Math.min(s.end, MAXTXT));
    html += `<span class="sp" data-i="${i}" data-kind="${s.kind}" ${s.sourceId ? `data-src="${s.sourceId}"` : ''} style="background:${kindColor(s.kind)}26;box-shadow:inset 0 -2px 0 ${kindColor(s.kind)}66">${esc(seg)}</span>`;
  }
  if (trunc) html += `<div class="muted">… ${fmt(text.length - MAXTXT)} more chars (open raw to see all)</div>`;
  return `<div class="spans">${chips}</div><div class="txt">${html}</div>`;
}

function wireSpans(el: HTMLElement, p: Part): void {
  const tip = $('#tip');
  $$('.sp', el).forEach((s) => {
    const i = Number(s.dataset.i);
    const sp: Span = p.spans[i];
    s.onmouseenter = () => {
      tip.style.display = 'block';
      tip.innerHTML = `<b>${esc(sp.label || kindLabel(sp.kind))}</b><br>${sp.exact ? '' : '≈'}${fmt(sp.tokens)} tokens · ${fmt(sp.end - sp.start)} chars${sp.match ? ` · match: ${esc(sp.match)}` : ''}${sp.sourceId ? '<br>click to open source' : ''}`;
      $$(`.sp[data-i="${i}"]`, el).forEach((x) => x.classList.add('hl'));
    };
    s.onmousemove = (e: MouseEvent) => {
      tip.style.left = Math.min(window.innerWidth - 440, e.clientX + 12) + 'px';
      tip.style.top = e.clientY + 12 + 'px';
    };
    s.onmouseleave = () => {
      tip.style.display = 'none';
      $$('.sp.hl', el).forEach((x) => x.classList.remove('hl'));
    };
    s.onclick = () => {
      if (sp.sourceId) void openSource(sp.sourceId, p.text.slice(sp.start, sp.end));
    };
  });
  applyHidden(el);
}

function renderSources(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const usage = a.totals.sourceUsage;
  const all: UiSource[] = [...recSources(), ...(a.adhocSources || [])];
  const empty: SourceUsage = { used: false, tokens: 0, chars: 0, spans: 0, parts: [], matches: {}, coverage: 0 };
  const rows = all
    .map((s) => ({ s, u: usage[s.id] || empty }))
    .sort((x, y) => y.u.tokens - x.u.tokens || x.s.kind.localeCompare(y.s.kind) || x.s.name.localeCompare(y.s.name));
  const used = rows.filter((r) => r.u.used);
  const stepsFor = sessionStepsBySource();
  v.innerHTML = summaryBlock(a) + `<div class="small muted" style="margin-bottom:8px">Project <b class="mono">${esc(short(rec.projectDir))}</b> · ${used.length} of ${all.length} inventory sources appear in this request. Hover a row to see where it lands; click to open the file. "coverage" = how much of the file is present verbatim; "steps" = which calls in this session include it.</div>
  <table><thead><tr><th></th><th>source</th><th>scope</th><th class="num">file size</th><th class="num">tokens here</th><th class="num">share</th><th class="num">coverage</th><th>match</th><th>where</th><th>steps</th></tr></thead><tbody>
  ${rows
    .map(({ s, u }) => {
      const full = s as PublicSource;
      return `<tr class="click ${u.used ? '' : 'unused'}" data-src="${s.id}">
    <td><span class="k" style="background:${kindColor(s.kind)}"></span></td>
    <td><b>${esc(s.name)}</b> <span class="muted small">${esc(kindLabel(s.kind))}${(s as AdhocSource).adhoc ? ' (outside inventory)' : ''}</span><div class="muted small mono">${esc(short(s.path))}</div>${s.description ? `<div class="small muted">${esc(s.description.slice(0, 160))}</div>` : ''}${full.hooks && full.hooks.length ? `<div class="small">hooks: ${full.hooks.map((h) => `<span class="pill">${esc(h.event)}${h.matcher ? ' ' + esc(h.matcher) : ''}</span>`).join(' ')}</div>` : ''}${full.servers ? `<div class="small">servers: ${full.servers.map((x) => `<span class="pill">${esc(x.name)}</span>`).join(' ')}</div>` : ''}</td>
    <td>${esc(s.scope)}</td><td class="num">${fmt(s.size)}</td><td class="num">${u.used ? fmt(u.tokens) : '<span class="muted">not sent</span>'}</td><td class="num">${u.used ? pct(u.tokens, a.totals.tokens) : ''}</td><td class="num">${u.used ? pct(u.chars, s.size || u.chars) : ''}</td>
    <td class="small">${Object.entries(u.matches).map(([k, n]) => `${esc(k)}×${n}`).join(', ')}</td>
    <td class="small">${u.parts.map((pid) => { const p = a.parts.find((x) => x.id === pid); return p ? `<span class="pill" title="${esc(p.label)}">${esc(p.area === 'messages' ? `msg ${p.index}.${p.sub} ${p.role}` : p.id)}</span>` : ''; }).join(' ')}</td>
    <td class="small mono">${(stepsFor.get(s.id) || []).join(' ')}</td>
  </tr>`;
    })
    .join('')}</tbody></table>`;
  $$('tr[data-src]', v).forEach((tr) => {
    tr.onclick = () => void openSource(tr.dataset.src!);
  });
  wireLegend(v);
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

function renderDiff(v: HTMLElement, rec: FullRequest, a: Analysis): void {
  const d = a.diff;
  let html = summaryBlock(a);
  if (!d) {
    v.innerHTML = html + '<div class="muted">First agent turn in this session (or a side call) — nothing to compare against.</div>';
    wireLegend(v);
    return;
  }
  const prev = S.sessions.find((s) => s.id === rec.sessionId)?.requests.find((r) => r.id === a.prevId);
  html += `<div class="diff"><div class="small" style="margin-bottom:8px">Compared with step <b>#${prev ? prev.seq : '?'}</b>: <span class="add">+${fmt(d.addedTokens)} added</span> · <span class="rem">−${fmt(d.removedTokens)} removed</span> · <span class="chg">${d.changedDelta >= 0 ? '+' : ''}${fmt(d.changedDelta)} in changed parts</span> · ${d.sameCount} parts unchanged${a.cache ? ` · server reports cache read <b>${fmt(a.cache.read)}</b>, cache write <b>${fmt(a.cache.write)}</b>, uncached <b>${fmt(a.cache.uncached)}</b>` : ''}</div>`;
  const row = (cls: string, sign: string, x: DiffEntry) => `<tr><td class="${cls}">${sign}</td><td>${esc(x.label)} <span class="muted small mono">${esc(x.key)}</span></td><td class="num">${x.prevTokens != null ? fmt(x.prevTokens) + ' → ' : ''}${fmt(x.tokens)}</td><td class="num">${x.prevChars != null ? fmt(x.prevChars) + ' → ' : ''}${fmt(x.chars)}</td></tr>`;
  html += `<table><thead><tr><th></th><th>part</th><th class="num">tokens</th><th class="num">chars</th></tr></thead><tbody>
    ${d.added.map((x) => row('add', '+', x)).join('')}${d.changed.map((x) => row('chg', '~', x)).join('')}${d.removed.map((x) => row('rem', '−', x)).join('')}</tbody></table></div>`;
  v.innerHTML = html;
  wireLegend(v);
}

function renderResponse(v: HTMLElement, rec: FullRequest): void {
  const r = rec.response;
  if (!r) {
    v.innerHTML = '<div class="empty">No response yet.</div>';
    return;
  }
  const u = r.usage || {};
  let html = `<div class="small" style="margin-bottom:10px"><span class="stat">status <b>${rec.status}</b></span><span class="stat">stop <b>${esc(r.stop_reason || '')}</b></span><span class="stat">output tokens <b>${fmt(u.output_tokens)}</b></span><span class="stat">input <b>${fmt(u.input_tokens)}</b></span><span class="stat">cache read <b>${fmt(u.cache_read_input_tokens)}</b></span><span class="stat">cache write <b>${fmt(u.cache_creation_input_tokens)}</b></span><span class="stat">duration <b>${fmt(rec.durationMs)} ms</b></span><span class="stat">TTFB <b>${fmt(rec.ttfbMs)} ms</b></span><span class="stat">SSE events <b>${fmt(r.eventCount)}</b></span></div>`;
  if (r.error) html += `<pre class="txt">${esc(JSON.stringify(r.error, null, 2))}</pre>`;
  for (const b of r.content || []) {
    const blk = b as Record<string, unknown>;
    const t = b.type === 'text' ? String(blk.text) : b.type === 'thinking' ? String(blk.thinking) : b.type === 'tool_use' ? JSON.stringify({ name: blk.name, input: blk.input }, null, 2) : JSON.stringify(b, null, 2);
    html += `<div class="part open"><div class="hd"><span class="k" style="background:${kindColor('model')}"></span><span class="lab"><span class="pill">${esc(b.type)}</span> ${blk.name ? esc(blk.name) : ''}</span><span></span><span class="n muted">${fmt((t || '').length)} chars</span><span></span></div><div class="body"><div class="txt">${esc(t)}</div></div></div>`;
  }
  if (r.context_management) html += `<h3>context_management</h3><pre class="txt">${esc(JSON.stringify(r.context_management, null, 2))}</pre>`;
  v.innerHTML = html;
}

async function renderRaw(v: HTMLElement, rec: FullRequest): Promise<void> {
  v.innerHTML = '<div class="muted">loading…</div>';
  const raw = await api<RawRequest>(`/api/requests/${rec.id}/raw`);
  const req = JSON.stringify(raw.request, null, 2);
  v.innerHTML = `<h3>Request headers</h3><pre class="txt">${esc(JSON.stringify(raw.headers, null, 2))}</pre><h3>Request body <span class="muted small">${fmt(req.length)} chars</span></h3><pre class="txt" style="max-height:60vh">${esc(req.slice(0, 400000))}${req.length > 400000 ? '\n… truncated' : ''}</pre><h3>Response</h3><pre class="txt">${esc(JSON.stringify(raw.response, null, 2).slice(0, 200000))}</pre>`;
}

function renderSessionOverview(): void {
  void ensureSessionAnalyses().then(() => {
    if (S.rec && S.rec.sessionId === S.selSession) {
      if (S.tab === 'sources') renderCenter();
      return;
    }
    const sess = S.sessions.find((s) => s.id === S.selSession);
    if (!sess) return;
    const c = $('#center');
    const reqs = sess.requests.filter((r) => S.sessionAnalyses.has(r.id));
    const max = Math.max(1, ...reqs.map((r) => S.sessionAnalyses.get(r.id)!.totals.tokens));
    c.innerHTML = `<div class="view"><h3>Session ${esc(sess.agent || basename(sess.projectDir) || sess.id.slice(0, 8))} · ${sess.requests.length} calls</h3><div class="steps">${reqs
      .map((r) => {
        const a = S.sessionAnalyses.get(r.id)!;
        const ks = Object.entries(a.totals.byKind);
        return `<div class="st" data-id="${r.id}" title="#${r.seq} ${esc(r.kind)} · ${fmt(a.totals.tokens)} tokens" style="height:${(100 * a.totals.tokens) / max}%">${ks.map(([k, v]) => `<div style="height:${(100 * v!.tokens) / a.totals.tokens}%;background:${kindColor(k)}"></div>`).join('')}</div>`;
      })
      .join('')}</div><div class="muted small">Click a bar to open that step.</div></div>`;
    $$('.st', c).forEach((el) => {
      el.onclick = () => void select(el.dataset.id!);
    });
  });
}

async function openSource(id: string, matchedText?: string): Promise<void> {
  const side = $('#side');
  $('#main').classList.add('with-side');
  side.innerHTML = '<div class="hd"><span class="t">loading…</span></div>';
  let s: PublicSource & { content?: string };
  try {
    s = await api<PublicSource & { content: string }>(`/api/sources/${id}`);
  } catch {
    const ad = [...recSources(), ...(S.rec?.adhocSources || [])].find((x) => x.id === id);
    s = ad ? ({ ...ad, content: '(file outside the scanned inventory — content not loaded)' } as PublicSource & { content: string }) : ({ id, name: id, content: '' } as unknown as PublicSource & { content: string });
  }
  let content = esc(s.content || '');
  if (matchedText && s.content) {
    const needle = matchedText.trim().slice(0, 200);
    const i = s.content.indexOf(needle);
    if (i >= 0) {
      const j = i + Math.min(matchedText.trim().length, s.content.length - i);
      content = esc(s.content.slice(0, i)) + '<mark>' + esc(s.content.slice(i, j)) + '</mark>' + esc(s.content.slice(j));
    }
  }
  const fm = s.frontmatter && Object.keys(s.frontmatter).length ? `<div class="meta">frontmatter: ${esc(JSON.stringify(s.frontmatter))}</div>` : '';
  side.innerHTML = `<div class="hd"><span class="k" style="background:${kindColor(s.kind)}"></span><span class="t" title="${esc(s.path)}">${esc(s.name)}</span><span class="pill">${esc(kindLabel(s.kind))}</span><span class="pill">${esc(s.scope || '')}</span><button data-act="close">✕</button></div>
    <div class="meta">${esc(s.path || '')} · ${fmt(s.size)} chars${s.mtime ? ` · modified ${new Date(s.mtime).toLocaleString()}` : ''}</div>${fm}<div class="txt">${content}</div>`;
  $<HTMLButtonElement>('[data-act=close]', side).onclick = () => $('#main').classList.remove('with-side');
  if (matchedText) $('mark', side)?.scrollIntoView({ block: 'center' });
}

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
    } else renderLeft();
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
    scheduleGraphRefresh();
  });
  es.addEventListener('analysis', (e) => {
    const d = parse(e);
    void refresh(d);
    S.sessionAnalyses.delete(d.id);
    if (S.sel === d.id) void select(d.id);
    scheduleGraphRefresh();
  });
  es.addEventListener('inventory', () => void refresh());
  es.addEventListener('cleared', () => {
    S.sel = null;
    S.rec = null;
    S.sessionAnalyses.clear();
    location.reload();
  });
}

$<HTMLButtonElement>('#b-rescan').onclick = () => void api('/api/rescan', { method: 'POST' });
$<HTMLButtonElement>('#b-clear').onclick = () => {
  if (confirm('Delete all captured sessions?')) void api('/api/clear', { method: 'POST' });
};
void loadState().then(live);

// ============================================================================
// flow-graph: interactive Cytoscape view of a session (turns → tool calls → results)
// or of one request's context composition (sources → areas → request).
// ============================================================================

type GMode = 'flow' | 'context';

const cssVar = (n: string): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
const isDark = (): boolean => matchMedia('(prefers-color-scheme: dark)').matches;

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
  for (const k of Object.keys(S.kinds)) {
    st.push({ selector: `node[kind = "${k}"]`, style: { 'background-color': fill(k), 'border-color': kindColor(k) } });
  }
  return st as unknown as CyNS.Stylesheet[];
}

const fmtKk = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n >= 1000 ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : String(n));

function layoutOptions(): CyNS.LayoutOptions {
  return {
    name: 'dagre', rankDir: G.dir, nodeSep: 22, rankSep: G.mode === 'context' ? 110 : 70, edgeSep: 10, ranker: 'network-simplex',
    animate: true, animationDuration: 380, animationEasing: 'ease-in-out-cubic', fit: true, padding: 36, spacingFactor: 1,
  } as unknown as CyNS.LayoutOptions;
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
    if (n.data('kind') !== 'group') void showGraphDetail(n.data() as GraphNodeData);
  });
  cy.on('tap', (ev) => {
    if (ev.target === cy) $('#main').classList.remove('with-side');
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => cy.style(graphStyle()));
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

async function drawGraph(force = false): Promise<void> {
  if (!G.on) return;
  const sessId = S.selSession || S.rec?.sessionId || S.sessions[0]?.id;
  const reqId = S.sel || S.rec?.id;
  let url: string | null = null;
  if (G.mode === 'flow' && sessId) url = `/api/sessions/${sessId}/graph`;
  if (G.mode === 'context' && reqId) url = `/api/requests/${reqId}/graph`;
  const empty = $('#gempty');
  if (!url) {
    empty.hidden = false;
    empty.textContent = G.mode === 'flow' ? 'Select a session on the left to draw its flow.' : 'Select a request on the left to draw its context.';
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
  G.data = data;
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
    cy.layout(layoutOptions()).run();
  }
  renderLegend(data);
  const st = data.stats;
  $('#gstats').textContent = data.mode === 'flow'
    ? `${st.turns} turns · ${st.calls} tool calls · ${st.sideCalls} side calls · ${fmt(st.promptTokens)} prompt tokens · ${fmt(st.outputTokens)} output`
    : `${st.sources} sources · ${fmt(st.tokens)} prompt tokens`;
}

async function showGraphDetail(d: GraphNodeData): Promise<void> {
  if (d.ref?.type === 'source') return openSource(d.ref.id);
  const side = $('#side');
  $('#main').classList.add('with-side');
  const det = d.detail || {};
  const kv = (rows: Array<[string, unknown]>): string => `<div class="kv">${rows.filter(([, v]) => v != null && v !== '').map(([k, v]) => `<span class="muted">${esc(k)}</span><b>${esc(typeof v === 'number' ? v.toLocaleString() : String(v))}</b>`).join('')}</div>`;
  let body = '';
  if (d.ref?.type === 'request' || d.kind === 'turn' || d.kind === 'side' || d.kind === 'request') {
    const byKind = (det.byKind || {}) as Record<string, number>;
    body = kv([['step', det.seq], ['model', det.model], ['status', det.status], ['stop', det.stopReason], ['duration', det.durationMs != null ? `${det.durationMs} ms` : null], ['prompt tokens', d.tokens], ['output tokens', d.tokensOut], ['cache read', det.cacheRead], ['cache write', det.cacheWrite], ['uncached', det.uncached]]);
    const kinds = Object.entries(byKind).sort((a, b) => b[1] - a[1]);
    if (kinds.length) body += `<h4>prompt by source kind</h4>${kv(kinds.map(([k, v]) => [kindLabel(k), v]))}`;
    if (det.userPreview) body += `<h4>user</h4><pre>${esc(det.userPreview)}</pre>`;
    if (det.assistantPreview) body += `<h4>assistant</h4><pre>${esc(det.assistantPreview)}</pre>`;
    body += `<p><button data-act="open-inspect">open in inspector</button></p>`;
  } else if (d.ref?.type === 'call') {
    body = kv([['tool', det.tool], ['turn', det.turn], ['input tokens (≈)', d.tokens], ['result tokens', det.resultTokens], ['error', det.isError ? 'yes' : null]]);
    body += `<h4>input</h4><pre>${esc(JSON.stringify(det.input ?? {}, null, 2))}</pre>`;
    if (det.resultPreview) body += `<h4>result (first 400 chars)</h4><pre>${esc(String(det.resultPreview))}</pre>`;
  } else if (d.ref?.type === 'area') {
    body = kv([['area', d.label], ['tokens', d.tokens]]) + '<p class="muted small">Open the request in the inspector to see every part of this area.</p><p><button data-act="open-inspect">open in inspector</button></p>';
  } else {
    body = kv([['kind', kindLabel(d.kind)], ['tokens', d.tokens]]);
  }
  side.innerHTML = `<div class="hd"><span class="k" style="background:${d.kind === 'turn' || d.kind === 'request' ? cssVar('--accent') : kindColor(d.kind)}"></span><span class="t">${esc(d.label)}</span><button data-act="close">✕</button></div><div id="gdetail">${body}</div>`;
  $<HTMLButtonElement>('[data-act=close]', side).onclick = () => $('#main').classList.remove('with-side');
  const open = side.querySelector<HTMLButtonElement>('[data-act=open-inspect]');
  if (open) open.onclick = () => {
    const id = d.ref?.type === 'request' ? d.ref.id : d.ref?.requestId;
    setMode(false);
    if (id) void select(id);
  };
}

function setMode(graph: boolean): void {
  G.on = graph;
  $('#main').classList.toggle('graph', graph);
  $('#graph').hidden = !graph;
  $('#b-graph').classList.toggle('on', graph);
  $('#b-inspect').classList.toggle('on', !graph);
  $('#main').classList.remove('with-side');
  if (graph) {
    void drawGraph(true).then(() => G.cy?.resize());
  }
}

function scheduleGraphRefresh(): void {
  if (!G.on) return;
  window.clearTimeout(G.refreshT);
  G.refreshT = window.setTimeout(() => void drawGraph(false), 400);
}

$<HTMLButtonElement>('#b-graph').onclick = () => setMode(true);
$<HTMLButtonElement>('#b-inspect').onclick = () => setMode(false);
$$<HTMLButtonElement>('[data-gmode]').forEach((b) => {
  b.onclick = () => {
    G.mode = b.dataset.gmode as GMode;
    $$('[data-gmode]').forEach((x) => x.classList.toggle('on', x === b));
    void drawGraph(true);
  };
});
$$<HTMLButtonElement>('[data-gdir]').forEach((b) => {
  b.onclick = () => {
    G.dir = b.dataset.gdir as 'LR' | 'TB';
    $$('[data-gdir]').forEach((x) => x.classList.toggle('on', x === b));
    G.cy?.layout(layoutOptions()).run();
    G.key = '';
  };
});
$<HTMLButtonElement>('[data-gact=fit]').onclick = () => G.cy?.animate({ fit: { eles: G.cy.elements(), padding: 36 }, duration: 250 });
$<HTMLButtonElement>('[data-gact=relayout]').onclick = () => G.cy?.layout(layoutOptions()).run();
window.addEventListener('resize', () => G.cy?.resize());
