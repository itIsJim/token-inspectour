// Session flow-graph drawn with d3. The flow is a chain of agent
// turns; each turn fans out into the tool calls it made (grouped by MCP server) and those calls'
// results feed the next turn. That shape needs no general graph layout: turns sit on one lane,
// each turn's calls hang in a column between it and the next turn, side calls sit on the other
// side of the lane. Positions are deterministic, so live updates never reshuffle the drawing.
// Compiled to dist/ui/flow.js and served under /<agent>/flow.js.
import type * as D3 from 'd3';
import type { GraphData, GraphEdgeData, GraphNodeData } from '../src/types.js';
import { esc, fmt, fmtKk, hideTip, kindColor, kindLabel, showTip } from './common.js';

export type Dir = 'LR' | 'TB';

interface Box {
  d: GraphNodeData;
  w: number;
  h: number;
  x: number; // centre
  y: number;
  lines: string[];
}

interface GroupBox { d: GraphNodeData; x: number; y: number; w: number; h: number }

export interface FlowHandle {
  fit(animate?: boolean): void;
  focus(requestId: string | null, animate?: boolean): void;
  select(requestId: string | null): void;
  transform(): D3.ZoomTransform;
}

export interface FlowOptions {
  dir: Dir;
  selected: string | null;
  onClick: (d: GraphNodeData) => void;
  /** keep this zoom transform instead of choosing an initial view (live refresh) */
  keep?: D3.ZoomTransform | null;
}

const W = { turn: 236, agent: 236, side: 170, call: 214 } as Record<string, number>;
const GAP_MAIN = 64; // between a turn and its call column (along the flow)
const GAP_CROSS = 12; // between stacked calls
const LANE_GAP = 56; // lane ↔ call column / side calls
const GROUP_PAD = 12;
const GROUP_LABEL = 18;

const isTurn = (d: GraphNodeData): boolean => d.ref?.type === 'request' && d.kind !== 'side';
const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function nodeLines(d: GraphNodeData, w: number): string[] {
  const chars = Math.floor((w - 24) / 6.4);
  const lines = [clip(d.label, chars)];
  if (d.sub) lines.push(clip(d.sub, chars));
  if (d.tokens != null) {
    if (isTurn(d) || d.kind === 'side') lines.push(`${fmtKk(d.tokens)} in${d.tokensOut != null ? ` · ${fmtKk(d.tokensOut)} out` : ''}`);
    else lines.push(`≈${fmtKk(d.tokens)} input${typeof d.detail?.resultTokens === 'number' ? ` · ${fmtKk(d.detail.resultTokens as number)} back` : ''}`);
  }
  return lines;
}

// ---------------------------------------------------------------------------- layout

function layout(data: GraphData, dir: Dir): { boxes: Map<string, Box>; groups: GroupBox[] } {
  const LR = dir === 'LR';
  const boxes = new Map<string, Box>();
  for (const n of data.nodes) {
    if (n.data.kind === 'group') continue;
    const w = isTurn(n.data) ? W.turn : n.data.kind === 'side' ? W.side : W.call;
    const lines = nodeLines(n.data, w);
    boxes.set(n.data.id, { d: n.data, w, h: 16 + lines.length * 15 + (isTurn(n.data) ? 6 : 0), x: 0, y: 0, lines });
  }
  // extent along the flow (main) and across it (cross), by direction
  const main = (b: Box): number => (LR ? b.w : b.h);
  const cross = (b: Box): number => (LR ? b.h : b.w);
  const place = (b: Box, u: number, v: number): void => { if (LR) { b.x = u; b.y = v; } else { b.x = v; b.y = u; } };

  const turns = data.nodes.map((n) => n.data).filter(isTurn);
  const out = new Map<string, GraphEdgeData[]>();
  for (const e of data.edges) out.set(e.data.source, [...(out.get(e.data.source) || []), e.data]);
  const parentOf = new Map(data.nodes.filter((n) => n.data.parent).map((n) => [n.data.id, n.data.parent!]));
  const groupData = new Map(data.nodes.filter((n) => n.data.kind === 'group').map((n) => [n.data.id, n.data]));
  const groups: GroupBox[] = [];

  let u = 0;
  const laneCross = Math.max(...turns.map((t) => cross(boxes.get(t.id)!)), 40);
  const placeSides = (ids: string[], atU: number): void => {
    let v = -(laneCross / 2 + LANE_GAP);
    for (const id of ids) {
      const b = boxes.get(id)!;
      place(b, atU, v - cross(b) / 2);
      v -= cross(b) + GAP_CROSS;
    }
  };
  // side calls made before the first turn (session title etc.) point at the first turn
  const orphans = data.edges.filter((e) => e.data.kind === 'side' && boxes.get(e.data.source)?.d.kind === 'side').map((e) => e.data.source);
  if (orphans.length) {
    placeSides(orphans, u + W.side / 2);
    u += (LR ? W.side : 0) + GAP_MAIN;
  }
  for (const t of turns) {
    const tb = boxes.get(t.id)!;
    place(tb, u + main(tb) / 2, 0);
    const edges = out.get(t.id) || [];
    placeSides(edges.filter((e) => e.kind === 'side').map((e) => e.target), u + main(tb) / 2);
    u += main(tb);
    const calls = edges.filter((e) => e.kind === 'call' || e.kind === 'spawn').map((e) => e.target).filter((id) => boxes.has(id));
    if (!calls.length) { u += GAP_MAIN; continue; }
    // keep members of one MCP group together, in first-appearance order
    const order: string[] = [];
    const seen = new Set<string>();
    for (const id of calls) {
      const g = parentOf.get(id);
      if (!g) order.push(id);
      else if (!seen.has(g)) { seen.add(g); order.push(...calls.filter((c) => parentOf.get(c) === g)); }
    }
    const colMain = Math.max(...order.map((id) => main(boxes.get(id)!))) + (seen.size ? GROUP_PAD * 2 + (LR ? 0 : GROUP_LABEL) : 0);
    const centreU = u + GAP_MAIN + colMain / 2;
    let v = laneCross / 2 + LANE_GAP;
    let open: string | null = null;
    const closeGroup = (): void => {
      if (!open) return;
      const members = order.filter((id) => parentOf.get(id) === open).map((id) => boxes.get(id)!);
      const lo = Math.min(...members.map((b) => (LR ? b.y - b.h / 2 : b.x - b.w / 2)));
      const hi = Math.max(...members.map((b) => (LR ? b.y + b.h / 2 : b.x + b.w / 2)));
      const mMain = Math.max(...members.map(main));
      const gw = (LR ? mMain : hi - lo) + GROUP_PAD * 2;
      const gh = (LR ? hi - lo : mMain) + GROUP_PAD * 2 + GROUP_LABEL;
      const gx = LR ? centreU : (lo + hi) / 2;
      const gy = LR ? (lo + hi) / 2 - GROUP_LABEL / 2 : centreU - GROUP_LABEL / 2;
      groups.push({ d: groupData.get(open)!, x: gx, y: gy, w: gw, h: gh });
      v += GROUP_PAD + GAP_CROSS;
      open = null;
    };
    for (const id of order) {
      const g = parentOf.get(id) || null;
      if (g !== open) {
        closeGroup();
        if (g) { open = g; v += GROUP_PAD + (LR ? GROUP_LABEL : 0); }
      }
      const b = boxes.get(id)!;
      place(b, centreU, v + cross(b) / 2);
      v += cross(b) + GAP_CROSS;
    }
    closeGroup();
    u += GAP_MAIN + colMain + GAP_MAIN;
  }
  return { boxes, groups };
}

// ---------------------------------------------------------------------------- render

export function flowGraph(el: HTMLElement, data: GraphData, opts: FlowOptions): FlowHandle {
  const LR = opts.dir === 'LR';
  const { boxes, groups } = layout(data, opts.dir);
  el.innerHTML = '';
  const width = el.clientWidth || 1000;
  const height = el.clientHeight || 700;
  const svg = d3.select(el).append('svg').attr('class', 'flow').attr('width', '100%').attr('height', '100%');
  const defs = svg.append('defs');
  const markers: Record<string, string> = { next: 'var(--hl)', call: 'var(--flow-edge)', result: 'var(--flow-edge)', spawn: kindColor('agent'), side: 'var(--flow-edge)', feeds: 'var(--flow-edge)' };
  for (const [k, c] of Object.entries(markers)) {
    defs.append('marker').attr('id', `fa-${k}`).attr('viewBox', '0 -5 10 10').attr('refX', 9).attr('markerWidth', 7).attr('markerHeight', 7).attr('orient', 'auto')
      .attr('markerUnits', 'userSpaceOnUse').append('path').attr('d', 'M0,-4L9,0L0,4Z').style('fill', c);
  }
  const view = svg.append('g');
  const zoom = d3.zoom<SVGSVGElement, undefined>().scaleExtent([0.03, 2.5]).on('zoom', (ev: D3.D3ZoomEvent<SVGSVGElement, undefined>) => view.attr('transform', ev.transform.toString()));
  (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).call(zoom).on('dblclick.zoom', null);

  // groups (MCP server boxes)
  view.append('g').selectAll('g').data(groups).join('g').attr('class', 'fgroup')
    .call((g) => g.append('rect').attr('x', (b) => b.x - b.w / 2).attr('y', (b) => b.y - b.h / 2).attr('width', (b) => b.w).attr('height', (b) => b.h).attr('rx', 12))
    .call((g) => g.append('text').attr('x', (b) => b.x - b.w / 2 + 12).attr('y', (b) => b.y - b.h / 2 + 15).text((b) => b.d.label.toUpperCase()));

  // edges
  const edges = data.edges.map((e) => e.data).filter((e) => boxes.has(e.source) && boxes.has(e.target));
  const maxTok = d3.max(edges.filter((e) => e.kind !== 'next'), (e) => e.tokens || 0) || 1;
  const wScale = d3.scaleSqrt().domain([0, maxTok]).range([1.2, 6]);
  const anchor = (b: Box, side: 'in' | 'out', e: GraphEdgeData): [number, number] => {
    if (e.kind === 'side') {
      // side calls sit across the lane: leave the turn on its lane-facing edge
      if (LR) return side === 'out' ? [b.x, b.y - b.h / 2] : [b.x, b.y + b.h / 2];
      return side === 'out' ? [b.x - b.w / 2, b.y] : [b.x + b.w / 2, b.y];
    }
    if (LR) return side === 'out' ? [b.x + b.w / 2, b.y] : [b.x - b.w / 2, b.y];
    return side === 'out' ? [b.x, b.y + b.h / 2] : [b.x, b.y - b.h / 2];
  };
  const curve = (e: GraphEdgeData): string => {
    const s = boxes.get(e.source)!;
    const t = boxes.get(e.target)!;
    const [x1, y1] = anchor(s, 'out', e);
    const [x2, y2] = anchor(t, 'in', e);
    const vertical = e.kind === 'side' ? LR : !LR;
    if (vertical) { const my = (y1 + y2) / 2; return `M${x1},${y1}C${x1},${my} ${x2},${my} ${x2},${y2}`; }
    const mx = (x1 + x2) / 2;
    return `M${x1},${y1}C${mx},${y1} ${mx},${y2} ${x2},${y2}`;
  };
  const edgeSel = view.append('g').attr('fill', 'none').selectAll<SVGPathElement, GraphEdgeData>('path').data(edges, (e) => e.id).join('path')
    .attr('class', (e) => `fedge ${e.kind}`)
    .attr('d', curve)
    .attr('stroke-width', (e) => (e.kind === 'next' ? 2.5 : e.kind === 'side' ? 1.2 : wScale(e.tokens || 0)))
    .attr('marker-end', (e) => (e.kind === 'side' ? null : `url(#fa-${e.kind})`))
    .on('mouseenter', (ev: MouseEvent, e) => showTip(`<b>${esc({ next: 'next turn', call: 'tool call', result: 'result back into the next turn', spawn: 'subagent spawn', side: 'side call', feeds: 'feeds' }[e.kind])}</b>${e.tokens != null ? `<div class="row"><span>tokens</span><span>${fmt(e.tokens)}</span></div>` : ''}`, ev))
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', hideTip);
  // edge labels: tokens added per turn, tokens coming back from a call
  const labelled = edges.filter((e) => e.label && (e.kind === 'next' || e.kind === 'result'));
  const labelSel = view.append('g').selectAll<SVGGElement, GraphEdgeData>('g').data(labelled, (e) => e.id).join('g').attr('class', (e) => `flabel ${e.kind}`)
    .attr('transform', (e) => {
      const [x1, y1] = anchor(boxes.get(e.source)!, 'out', e);
      const [x2, y2] = anchor(boxes.get(e.target)!, 'in', e);
      return `translate(${(x1 + x2) / 2},${(y1 + y2) / 2})`;
    });
  labelSel.append('rect');
  labelSel.append('text').attr('text-anchor', 'middle').attr('dy', '0.32em').text((e) => e.label!);
  labelSel.each(function () {
    const t = (this as SVGGElement).querySelector('text')!;
    const w = t.getComputedTextLength?.() || 30;
    d3.select(this).select('rect').attr('x', -w / 2 - 5).attr('y', -8).attr('width', w + 10).attr('height', 16).attr('rx', 8);
  });

  // nodes
  const nodeSel = view.append('g').selectAll<SVGGElement, Box>('g').data([...boxes.values()], (b) => b.d.id).join('g')
    .attr('class', (b) => `fnode k-${b.d.kind}${isTurn(b.d) ? ' turn' : ''}`)
    .attr('transform', (b) => `translate(${b.x - b.w / 2},${b.y - b.h / 2})`);
  const colorOf = (d: GraphNodeData): string => (isTurn(d) && d.kind !== 'agent' ? 'var(--hl)' : d.kind === 'side' ? 'var(--muted-foreground)' : kindColor(d.kind));
  nodeSel.append('rect').attr('class', 'body').attr('width', (b) => b.w).attr('height', (b) => b.h).attr('rx', (b) => (isTurn(b.d) ? 12 : 9))
    .style('--c', (b) => colorOf(b.d));
  nodeSel.filter((b) => !isTurn(b.d) && b.d.kind !== 'side').append('rect').attr('class', 'stripe').attr('width', 4).attr('height', (b) => b.h - 16).attr('x', 8).attr('y', 8).attr('rx', 2)
    .style('fill', (b) => colorOf(b.d));
  nodeSel.each(function (b) {
    const g = d3.select(this);
    const x = isTurn(b.d) || b.d.kind === 'side' ? 12 : 20;
    b.lines.forEach((line, i) => {
      g.append('text').attr('class', i === 0 ? 't' : i === b.lines.length - 1 && b.d.tokens != null ? 'n' : 's').attr('x', x).attr('y', 20 + i * 15 + (isTurn(b.d) && i > 0 ? 3 : 0)).text(line);
    });
  });

  const nbrs = new Map<string, Set<string>>();
  for (const e of edges) {
    if (!nbrs.has(e.source)) nbrs.set(e.source, new Set([e.source]));
    if (!nbrs.has(e.target)) nbrs.set(e.target, new Set([e.target]));
    nbrs.get(e.source)!.add(e.target);
    nbrs.get(e.target)!.add(e.source);
  }
  const focusOn = (id: string | null): void => {
    const hood = id ? nbrs.get(id) || new Set([id]) : null;
    nodeSel.classed('dim', (b) => !!hood && !hood.has(b.d.id));
    edgeSel.classed('dim', (e) => !!id && e.source !== id && e.target !== id).classed('hl', (e) => !!id && (e.source === id || e.target === id));
    labelSel.classed('dim', (e) => !!id && e.source !== id && e.target !== id);
  };
  nodeSel
    .on('mouseenter', (ev: MouseEvent, b) => {
      focusOn(b.d.id);
      const d = b.d;
      const bits = [`<b>${esc(d.label)}</b>`];
      if (d.sub) bits.push(`<div class="muted small">${esc(d.sub)}</div>`);
      if (d.tokens != null) bits.push(`<div class="row"><span>${isTurn(d) || d.kind === 'side' ? 'prompt tokens' : 'input tokens (≈)'}</span><span>${fmt(d.tokens)}</span></div>`);
      if (d.tokensOut != null) bits.push(`<div class="row"><span>output tokens</span><span>${fmt(d.tokensOut)}</span></div>`);
      if (typeof d.detail?.resultTokens === 'number') bits.push(`<div class="row"><span>result tokens</span><span>${fmt(d.detail.resultTokens as number)}</span></div>`);
      if (!isTurn(d) && d.kind !== 'side') bits.push(`<div class="muted small">${esc(kindLabel(d.kind))}</div>`);
      bits.push('<div class="muted small">click for details</div>');
      showTip(bits.join(''), ev);
    })
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', () => { focusOn(null); hideTip(); })
    .on('click', (_ev, b) => { hideTip(); opts.onClick(b.d); });
  svg.on('click', (ev: MouseEvent) => { if (ev.target === svg.node()) focusOn(null); });

  // ---- view helpers
  const all = [...boxes.values()];
  const bounds = (bs: Box[]): [number, number, number, number] => [
    d3.min(bs, (b) => b.x - b.w / 2)!, d3.min(bs, (b) => b.y - b.h / 2)!, d3.max(bs, (b) => b.x + b.w / 2)!, d3.max(bs, (b) => b.y + b.h / 2)!,
  ];
  const fitTo = (bs: Box[], animate: boolean, maxScale = 1.1): void => {
    if (!bs.length) return;
    const [x0, y0, x1, y1] = bounds(bs);
    const w = el.clientWidth || width;
    const h = el.clientHeight || height;
    const k = Math.min(maxScale, 0.92 / Math.max((x1 - x0) / w, (y1 - y0) / h));
    zoom.scaleExtent([Math.min(0.03, k), 2.5]); // long sessions need to zoom out further to fit
    const t = d3.zoomIdentity.translate(w / 2 - (k * (x0 + x1)) / 2, h / 2 - (k * (y0 + y1)) / 2).scale(k);
    const s = svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>;
    // a hidden tab gets no animation frames, so a transition there would never arrive
    if (animate && !document.hidden) s.transition().duration(450).call(zoom.transform, t);
    else s.call(zoom.transform, t);
  };
  // the neighbourhood of a turn: the turn before and after, their calls and side calls
  const around = (requestId: string | null): Box[] => {
    const turns = all.filter((b) => isTurn(b.d));
    let i = turns.findIndex((b) => b.d.ref?.id === requestId);
    if (i < 0) i = turns.length - 1;
    const pick = new Set(turns.slice(Math.max(0, i - 1), i + 2).map((b) => b.d.id));
    for (const e of edges) if (pick.has(e.source) && (e.kind === 'call' || e.kind === 'spawn' || e.kind === 'side')) pick.add(e.target);
    return all.filter((b) => pick.has(b.d.id));
  };
  const select = (requestId: string | null): void => {
    nodeSel.classed('sel', (b) => !!requestId && b.d.ref?.type === 'request' && b.d.ref.id === requestId);
  };
  select(opts.selected);
  if (opts.keep) (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).call(zoom.transform, opts.keep);
  else fitTo(around(opts.selected), false);

  return {
    fit: (animate = true) => fitTo(all, animate, 1),
    focus: (requestId, animate = true) => fitTo(around(requestId), animate),
    select,
    transform: () => d3.zoomTransform(svg.node() as SVGSVGElement),
  };
}
