// token-inspectour inspector UI. Compiled by `tsc -p tsconfig.ui.json` to dist/ui/app.js and
// served under /<agent>/app.js; shared helpers live in common.ts. The flow-graph is its own
// page (graph.html / graph.ts), reached through the "graph" link in the header.
import type { Analysis, DiffEntry, Part, PublicSource, RequestSummary, SessionSummary, SourceUsage, Span, AdhocSource, AssembledResponse, SlimAnalysis } from '../src/types.js';
import { $, $$, BASE, NAME, api, basename, esc, fmt, KINDS, kindColor, kindLabel, pct, renderSourcePanel, short } from './common.js';
import type { Kinds } from './common.js';

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
};

const recSources = (): PublicSource[] => S.rec?.inventory?.sources || S.sources;

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
  renderGraphLink();
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
  const fallback = [...recSources(), ...(S.rec?.adhocSources || [])].find((x) => x.id === id) as PublicSource | undefined;
  return renderSourcePanel(id, fallback, matchedText);
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
    if (S.sel === d.id) void select(d.id);
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
