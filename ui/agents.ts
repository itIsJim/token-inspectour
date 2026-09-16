// Agent-level views of one session for the graph page: a swimlane timeline (main agent, parallel
// model loops, each subagent, side calls; bars = request start → end) and a spawn tree (turn →
// Agent call → subagent turns → their calls). Both link Agent tool calls to the subagent turns
// they started through the thread key set by the server, falling back to subagent type and time
// window. Compiled to dist/ui/agents.js.
import type * as D3 from 'd3';
import type { GraphData, GraphNodeData, RequestSummary } from '../src/types.js';
import { esc, fmt, fmtKk, hideTip, kindColor, showTip } from './common.js';
import { collapsibleTree } from './charts.js';
import type { TreeNode } from './charts.js';

const promptOf = (r: RequestSummary): number => (r.usage.input || 0) + (r.usage.cacheRead || 0) + (r.usage.cacheWrite || 0);
const t0 = (r: RequestSummary): number => Date.parse(r.startedAt);
const t1 = (r: RequestSummary): number => (r.endedAt ? Date.parse(r.endedAt) : Math.max(Date.now(), t0(r)));
const subagentOf = (r: RequestSummary): string | null => {
  const m = /^main:subagent(?::\s*(.+)|\s*\((built-in)\))?/.exec(r.kind || '');
  return m ? m[1] || 'built-in' : null;
};

// ---------------------------------------------------------------------------- spawn linking

export interface Spawn {
  callId: string; // graph node id (call:…)
  turn: RequestSummary; // the turn whose response made the Agent call
  type: string;
  description: string;
  children: RequestSummary[]; // subagent turns it started, in order
}

/** Match each Agent/Task call to the subagent turns that ran for it. The server links a call to the
 *  thread (first-message hash) whose first message holds the call's prompt; every turn of that
 *  subagent instance shares the thread. Without a thread, fall back to same subagent type within
 *  the time after the calling turn. */
export function linkSpawns(data: GraphData, reqs: RequestSummary[]): Spawn[] {
  const byId = new Map(reqs.map((r) => [r.id, r]));
  const nodes = new Map(data.nodes.map((n) => [n.data.id, n.data]));
  const spawns: Spawn[] = [];
  for (const e of data.edges) {
    if (e.data.kind !== 'spawn') continue;
    const turn = byId.get(nodes.get(e.data.source)?.ref?.id || '');
    const call = nodes.get(e.data.target);
    if (!turn || !call) continue;
    const input = (call.detail?.input || {}) as Record<string, unknown>;
    const type = typeof input.subagent_type === 'string' && input.subagent_type ? input.subagent_type : 'built-in';
    spawns.push({ callId: call.id, turn, type, description: String(input.description || input.prompt || '').slice(0, 80), children: [] });
  }
  const taken = new Set<string>();
  const subs = reqs.filter((r) => subagentOf(r)).sort((a, b) => t0(a) - t0(b));
  for (const sp of spawns) {
    const thread = nodes.get(sp.callId)?.detail?.thread;
    if (typeof thread !== 'string') continue;
    sp.children = subs.filter((r) => r.thread === thread);
    for (const r of sp.children) taken.add(r.id);
  }
  for (const sp of spawns.sort((a, b) => t0(a.turn) - t0(b.turn))) {
    if (sp.children.length) continue;
    const from = t1(sp.turn) - 1000;
    const next = reqs.find((r) => !subagentOf(r) && r.model === sp.turn.model && (r.kind || '').startsWith('main') && t0(r) > t1(sp.turn));
    const until = next ? t0(next) : Infinity;
    const wanted = (r: RequestSummary): boolean => {
      const t = subagentOf(r)!;
      return t === sp.type || (sp.type === 'built-in' && t === 'built-in') || (sp.type === 'general-purpose' && t === 'built-in');
    };
    // parallel spawns of the same type in one turn share the window; hand turns out by order
    const siblings = spawns.filter((o) => o.turn === sp.turn && o.type === sp.type);
    const pool = subs.filter((r) => !taken.has(r.id) && wanted(r) && t0(r) >= from && t0(r) < until);
    const share = siblings.length > 1 ? Math.ceil(pool.length / siblings.length) : pool.length;
    for (const r of pool.slice(0, share)) { sp.children.push(r); taken.add(r.id); }
  }
  return spawns;
}

// ---------------------------------------------------------------------------- timeline

interface Lane { key: string; label: string; color: string; rows: RequestSummary[][] }

const big = (n: number): string => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmtKk(n));
const GAP_MS = 5 * 60 * 1000; // idle longer than this is compressed into a break
const BREAK_PX = 34;
const ROW_H = 16;
const ROW_GAP = 4;
const LANE_PAD = 22;

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h}h ${m % 60}m` : `${Math.floor(h / 24)}d ${h % 24}h`;
}

export function agentTimeline(el: HTMLElement, reqs: RequestSummary[], spawns: Spawn[], opts: { selected: string | null; onClick: (id: string) => void }): void {
  const done = reqs.filter((r) => r.startedAt).sort((a, b) => t0(a) - t0(b));
  if (!done.length) {
    el.innerHTML = '<div class="empty">No calls in this session yet.</div>';
    return;
  }
  // lanes: the main agent (the model with the most main-turn tokens), other main-turn models
  // running alongside it, one lane per subagent type, side calls
  const mainTok = new Map<string, number>();
  for (const r of done) if (r.kind === 'main') mainTok.set(r.model || '?', (mainTok.get(r.model || '?') || 0) + promptOf(r));
  const primary = [...mainTok.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const subTypes = [...new Set(done.map(subagentOf).filter((x): x is string => !!x))];
  const palette = ['#0891b2', '#7c3aed', '#db2777', '#ca8a04', '#059669', '#ea580c'];
  const laneOf = (r: RequestSummary): { key: string; label: string; color: string } => {
    const sub = subagentOf(r);
    if (sub) return { key: `sub:${sub}`, label: `subagent · ${sub}`, color: palette[subTypes.indexOf(sub) % palette.length] };
    if ((r.kind || '').startsWith('side')) return { key: 'side', label: 'side calls', color: '#a1a1aa' };
    if (r.model === primary) return { key: 'main', label: `main agent · ${(r.model || '').replace('claude-', '')}`, color: '#2563eb' };
    return { key: `loop:${r.model}`, label: `parallel loop · ${(r.model || '').replace('claude-', '')}`, color: '#64748b' };
  };
  const lanes = new Map<string, Lane>();
  for (const r of done) {
    const l = laneOf(r);
    const lane = lanes.get(l.key) || { ...l, rows: [] };
    // one row per conversation thread (each subagent instance gets its own row); calls without a
    // thread, like side calls, are packed into the first row they do not overlap
    const packed = l.key === 'side' || !r.thread;
    const row = packed
      ? lane.rows.find((rw) => (l.key === 'side' || !rw[0].thread) && t1(rw[rw.length - 1]) <= t0(r))
      : lane.rows.find((rw) => rw[0].thread === r.thread);
    if (row) row.push(r);
    else lane.rows.push([r]);
    lanes.set(l.key, lane);
  }
  const order = ['main', ...[...lanes.keys()].filter((k) => k.startsWith('loop:')), ...[...lanes.keys()].filter((k) => k.startsWith('sub:')), 'side'];
  const laneList = order.map((k) => lanes.get(k)).filter((l): l is Lane => !!l);

  // compressed time: active spans keep their proportions, idle gaps become fixed breaks
  const spans: Array<{ a: number; b: number }> = [];
  for (const r of done) {
    const last = spans[spans.length - 1];
    if (last && t0(r) - last.b <= GAP_MS) last.b = Math.max(last.b, t1(r));
    else spans.push({ a: t0(r), b: t1(r) });
  }
  const labelW = 210;
  const plotW = Math.max(400, (el.clientWidth || 1000) - labelW - 24);
  const activeMs = spans.reduce((x, s) => x + Math.max(1000, s.b - s.a), 0);
  const k = (plotW - (spans.length - 1) * BREAK_PX) / activeMs;
  const offsets: number[] = [];
  let acc = 0;
  for (const s of spans) { offsets.push(acc); acc += Math.max(1000, s.b - s.a) * k + BREAK_PX; }
  const U = (t: number): number => {
    let i = spans.findIndex((s) => t <= s.b);
    if (i < 0) i = spans.length - 1;
    return offsets[i] + Math.max(0, Math.min(t, spans[i].b) - spans[i].a) * k;
  };

  // vertical positions
  let y = 30;
  const rowY = new Map<string, number>();
  const laneBoxes: Array<{ lane: Lane; y: number; h: number }> = [];
  for (const lane of laneList) {
    const top = y;
    y += LANE_PAD;
    lane.rows.forEach((row) => { for (const r of row) rowY.set(r.id, y); y += ROW_H + ROW_GAP; });
    y += 8;
    laneBoxes.push({ lane, y: top, h: y - top });
  }
  const H = y + 8;
  const W = labelW + plotW + 16;
  el.innerHTML = '';
  const svg = d3.select(el).append('svg').attr('class', 'atl').attr('viewBox', `0 0 ${W} ${H}`).attr('width', '100%'); // scales with the details panel
  const clipId = `atl-${Math.random().toString(36).slice(2, 8)}`;
  svg.append('clipPath').attr('id', clipId).append('rect').attr('x', labelW).attr('y', 0).attr('width', plotW + 8).attr('height', H);
  const lanesG = svg.append('g');
  lanesG.selectAll('rect').data(laneBoxes).join('rect').attr('class', 'lane').attr('x', 0).attr('y', (b) => b.y).attr('width', W).attr('height', (b) => b.h);
  lanesG.selectAll('text.ln').data(laneBoxes).join('text').attr('class', 'ln').attr('x', 12).attr('y', (b) => b.y + 16)
    .text((b) => b.lane.label);
  lanesG.selectAll('text.lc').data(laneBoxes).join('text').attr('class', 'lc').attr('x', 12).attr('y', (b) => b.y + 31)
    .text((b) => { const all = b.lane.rows.flat(); return `${all.length} call${all.length > 1 ? 's' : ''} · ${big(all.reduce((x, r) => x + promptOf(r), 0))} prompt`; });
  lanesG.selectAll('text.lp').data(laneBoxes.filter((b) => b.lane.rows.length > 1)).join('text').attr('class', 'lc').attr('x', 12).attr('y', (b) => b.y + 45)
    .text((b) => (b.lane.key === 'side' ? `up to ${b.lane.rows.length} at once` : `${b.lane.rows.length} ${b.lane.key.startsWith('sub:') ? 'instances' : 'threads'}`));
  lanesG.selectAll('circle').data(laneBoxes).join('circle').attr('cx', 6).attr('cy', (b) => b.y + 12).attr('r', 3).style('fill', (b) => b.lane.color);
  const plot = svg.append('g').attr('clip-path', `url(#${clipId})`);
  const axis = plot.append('g').attr('class', 'axis');
  const breaks = plot.append('g');
  const links = plot.append('g').attr('fill', 'none');
  const bars = plot.append('g');

  const maxTok = d3.max(done, promptOf) || 1;
  const opacity = d3.scaleSqrt().domain([0, maxTok]).range([0.35, 1]);
  const all = laneList.flatMap((l) => l.rows.flat().map((r) => ({ r, color: l.color })));
  const barSel = bars.selectAll<SVGRectElement, { r: RequestSummary; color: string }>('rect').data(all).join('rect')
    .attr('class', (d) => `bar${d.r.id === opts.selected ? ' sel' : ''}${d.r.status != null && d.r.status >= 400 ? ' err' : ''}`)
    .attr('y', (d) => rowY.get(d.r.id)!).attr('height', ROW_H).attr('rx', 3)
    .style('fill', (d) => d.color).style('fill-opacity', (d) => opacity(promptOf(d.r)))
    .on('mouseenter', (ev: MouseEvent, d) => {
      const r = d.r;
      showTip(`<b>#${r.seq} ${esc((r.kind || '').replace(/^main:?/, '') || 'turn')}</b><div class="muted small">${esc(r.model || '')} · ${new Date(r.startedAt).toLocaleTimeString()}</div><div class="row"><span>duration</span><span>${r.durationMs != null ? fmt(r.durationMs) + ' ms' : 'in flight'}</span></div><div class="row"><span>prompt tokens</span><span>${fmt(promptOf(r))}</span></div><div class="row"><span>output tokens</span><span>${fmt(r.usage.output)}</span></div>${r.userPreview ? `<div class="muted small">${esc(r.userPreview.slice(0, 90))}</div>` : ''}<div class="muted small">click for details</div>`, ev);
    })
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', hideTip)
    .on('click', (_ev, d) => { hideTip(); barSel.classed('sel', (x) => x.r.id === d.r.id); opts.onClick(d.r.id); });

  const spawnLinks = spawns.filter((s) => s.children.length && rowY.has(s.turn.id)).map((s) => ({ s, first: s.children[0] }));

  let zx = d3.zoomIdentity;
  const X = (t: number): number => labelW + zx.applyX(U(t));
  const draw = (): void => {
    barSel.attr('x', (d) => X(t0(d.r))).attr('width', (d) => Math.max(2, X(t1(d.r)) - X(t0(d.r))));
    links.selectAll<SVGPathElement, (typeof spawnLinks)[number]>('path').data(spawnLinks).join('path').attr('class', 'spawn')
      .attr('d', ({ s, first }) => {
        const x1 = X(t1(s.turn));
        const y1 = rowY.get(s.turn.id)! + ROW_H / 2;
        const x2 = X(t0(first));
        const y2 = rowY.get(first.id)! + ROW_H / 2;
        const mx = Math.max(x1 + 14, (x1 + x2) / 2);
        return `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2 - 2},${y2}`;
      });
    // one axis per active span, ticks at a readable density
    const ticks: Array<{ x: number; label: string }> = [];
    spans.forEach((s, i) => {
      const xa = labelW + zx.applyX(offsets[i]);
      const xb = labelW + zx.applyX(offsets[i] + Math.max(1000, s.b - s.a) * k);
      const sc = d3.scaleTime().domain([new Date(s.a), new Date(s.b)]).range([xa, xb]);
      const n = Math.max(1, Math.floor((xb - xa) / 90));
      const fmtT = s.b - s.a > 86400000 ? d3.timeFormat('%b %d %H:%M') : d3.timeFormat('%H:%M:%S');
      for (const t of sc.ticks(n)) ticks.push({ x: sc(t), label: fmtT(t) });
      if (!sc.ticks(n).length) ticks.push({ x: xa, label: fmtT(new Date(s.a)) });
    });
    // drop ticks that would collide with the previous one (spans can be narrow)
    ticks.sort((p, q) => p.x - q.x);
    for (let i = 1; i < ticks.length; i++) if (ticks[i].x - ticks[i - 1].x < 76) ticks.splice(i--, 1);
    axis.selectAll<SVGGElement, (typeof ticks)[number]>('g').data(ticks).join((enter) => {
      const g = enter.append('g');
      g.append('line').attr('y1', 22).attr('y2', H);
      g.append('text').attr('y', 16).attr('text-anchor', 'middle');
      return g;
    }).attr('transform', (d) => `translate(${d.x},0)`).call((g) => g.select('text').text((d) => d.label));
    breaks.selectAll<SVGGElement, number>('g').data(spans.slice(1).map((_s, i) => i + 1)).join((enter) => {
      const g = enter.append('g').attr('class', 'brk');
      g.append('rect').attr('y', 22).attr('height', H - 22);
      g.append('text').attr('text-anchor', 'middle').attr('dy', '0.32em');
      return g;
    }).attr('transform', (i) => `translate(${labelW + zx.applyX(offsets[i] - BREAK_PX)},0)`)
      .call((g) => g.select('rect').attr('width', Math.max(2, BREAK_PX * zx.k)))
      // label runs vertically inside the break so it never meets the time ticks
      .call((g) => g.select('text').attr('transform', `translate(${(BREAK_PX * zx.k) / 2},${(H + 22) / 2}) rotate(-90)`).text((i) => `${fmtDur(spans[i].a - spans[i - 1].b)} idle`));
  };
  draw();
  const zoom = d3.zoom<SVGSVGElement, undefined>().scaleExtent([1, 500]).extent([[labelW, 0], [labelW + plotW, H]]).translateExtent([[0, 0], [plotW + 16, H]])
    .filter((ev: Event) => !(ev instanceof WheelEvent) || !ev.shiftKey)
    .on('zoom', (ev: D3.D3ZoomEvent<SVGSVGElement, undefined>) => { zx = ev.transform; draw(); });
  (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).call(zoom).on('dblclick.zoom', null)
    .on('dblclick', () => (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).call(zoom.transform, d3.zoomIdentity));
}

// ---------------------------------------------------------------------------- spawn tree

export function spawnTree(el: HTMLElement, data: GraphData, reqs: RequestSummary[], spawns: Spawn[], opts: { sessionLabel: string; onSelect: (d: GraphNodeData) => void }): void {
  if (!spawns.length) {
    el.innerHTML = '<div class="empty">No subagents were spawned in this session.</div>';
    return;
  }
  const nodes = new Map(data.nodes.map((n) => [n.data.id, n.data]));
  const callsOf = new Map<string, GraphNodeData[]>();
  for (const e of data.edges) {
    if (e.data.kind !== 'call' && e.data.kind !== 'spawn') continue;
    const call = nodes.get(e.data.target);
    if (call) callsOf.set(e.data.source, [...(callsOf.get(e.data.source) || []), call]);
  }
  const spawnByCall = new Map(spawns.map((s) => [s.callId, s]));
  const turnTip = (r: RequestSummary): string => `<b>#${r.seq} ${esc((r.kind || '').replace(/^main:?/, '') || 'turn')}</b><div class="muted small">${esc(r.model || '')}</div><div class="row"><span>prompt tokens</span><span>${fmt(promptOf(r))}</span></div><div class="row"><span>output tokens</span><span>${fmt(r.usage.output)}</span></div><div class="muted small">click for details · click again to expand</div>`;
  const agentColor = kindColor('agent');
  const seen = new Set<string>();

  // a turn node: its calls as children; Agent calls recurse into the subagent turns they started
  const turnNode = (r: RequestSummary, collapsed: boolean): TreeNode => {
    seen.add(r.id);
    const calls = callsOf.get(`req:${r.id}`) || [];
    return {
      id: `req:${r.id}`, label: `#${r.seq} ${subagentOf(r) ? subagentOf(r) : 'turn'}`, color: subagentOf(r) ? agentColor : '#2563eb',
      value: promptOf(r), tip: turnTip(r), collapsed,
      children: calls.map((c) => callNode(c)),
    };
  };
  const callNode = (c: GraphNodeData): TreeNode => {
    const sp = spawnByCall.get(c.id);
    if (!sp) {
      return { id: c.id, label: c.label, color: kindColor(c.kind), value: c.tokens || 0, tip: `<b>${esc(c.label)}</b><div class="row"><span>input tokens (≈)</span><span>${fmt(c.tokens)}</span></div>${typeof c.detail?.resultTokens === 'number' ? `<div class="row"><span>result tokens</span><span>${fmt(c.detail.resultTokens as number)}</span></div>` : ''}` };
    }
    const tok = sp.children.reduce((x, r) => x + promptOf(r), 0);
    return {
      id: c.id, label: `Agent → ${sp.type}${sp.description ? `: ${sp.description}` : ''}`, color: agentColor, value: tok,
      tip: `<b>spawned ${esc(sp.type)}</b><div class="muted small">${esc(sp.description)}</div><div class="row"><span>subagent turns</span><span>${sp.children.length}</span></div><div class="row"><span>their prompt tokens</span><span>${fmt(tok)}</span></div>${sp.children.length ? '' : '<div class="muted small">no matching subagent turns were captured</div>'}`,
      children: sp.children.map((r) => turnNode(r, true)),
    };
  };
  const spawningTurns = [...new Set(spawns.map((s) => s.turn))].filter((r) => !subagentOf(r)).sort((a, b) => t0(a) - t0(b));
  const children = spawningTurns.map((r) => {
    const n = turnNode(r, false);
    // keep only the spawn branches under the root-level turns; other calls stay reachable in the flow view
    n.children = (n.children || []).filter((c) => spawnByCall.has(c.id));
    return n;
  });
  const unlinked = reqs.filter((r) => subagentOf(r) && !seen.has(r.id));
  if (unlinked.length) children.push({ id: 'unlinked', label: 'subagent turns not matched to a call', color: '#a1a1aa', value: 0, collapsed: true, tip: '<b>unmatched subagent turns</b><div class="muted small">their Agent call was not captured, or its timing overlapped another spawn</div>', children: unlinked.map((r) => turnNode(r, true)) });
  const total = spawns.reduce((x, s) => x + s.children.length, 0);
  collapsibleTree(el, { id: 'root', label: `${opts.sessionLabel} · ${spawns.length} spawns · ${total} subagent turns`, color: '#18181b', value: 0, tip: '<b>session</b>', children }, {
    onSelect: (n) => {
      const d = nodes.get(n.id);
      if (d) opts.onSelect(d);
    },
  });
}
