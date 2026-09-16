// d3 charts for the inspector and the graph page: area donut, kind bar, zoomable request map
// (icicle), Sankey flows, the messages/tools arc diagram, the collapsible source tree, the source
// presence heatmap and the session timeline. d3 and d3-sankey are vendored (vendor/*.min.js) and
// loaded as globals before the page modules. Compiled to dist/ui/charts.js.
import type * as D3 from 'd3';
import { esc, fmt, fmtKk, hideTip, showTip } from './common.js';

// ---------------------------------------------------------------------------- shared

const readable = (hex: string): boolean => {
  const c = d3.color(hex)?.rgb();
  if (!c) return true;
  return (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255 < 0.62;
};

// Draw now, and redraw (without entry animation) when the element's width changes, e.g. when the
// details panel opens. Redraws are debounced so a sliding panel does not restart them every frame.
function whenSized(el: HTMLElement, draw: (w: number, h: number, first: boolean) => void): void {
  let last = 0;
  let timer = 0;
  const run = (first: boolean): void => {
    const w = Math.floor(el.clientWidth);
    if (!w || w === last) return;
    last = w;
    draw(w, el.clientHeight, first);
  };
  new ResizeObserver(() => {
    if (!last) return run(true);
    clearTimeout(timer);
    timer = window.setTimeout(() => run(false), 120);
  }).observe(el);
  run(true);
}

// ---------------------------------------------------------------------------- donut

export interface Slice { key: string; label: string; value: number; color: string; sub?: string }

export function donut(el: HTMLElement, slices: Slice[], center: { value: string; label: string }, onClick?: (s: Slice) => void): void {
  const size = 200;
  const r = size / 2;
  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${size} ${size}`).style('max-width', `${size}px`).style('margin', '0 auto');
  const g = svg.append('g').attr('transform', `translate(${r},${r})`);
  const total = d3.sum(slices, (s) => s.value) || 1;
  const pie = d3.pie<Slice>().value((s) => s.value).sort(null).padAngle(0.012);
  const arc = d3.arc<D3.PieArcDatum<Slice>>().innerRadius(r * 0.64).outerRadius(r - 4).cornerRadius(3);
  const arcHover = d3.arc<D3.PieArcDatum<Slice>>().innerRadius(r * 0.62).outerRadius(r);
  g.selectAll('path').data(pie(slices.filter((s) => s.value > 0))).join('path')
    .attr('class', 'cell').attr('fill', (d) => d.data.color).attr('d', arc)
    .style('cursor', onClick ? 'pointer' : 'default')
    .on('mouseenter', function (ev: MouseEvent, d) {
      d3.select(this).transition().duration(120).attr('d', arcHover(d));
      showTip(`<b>${esc(d.data.label)}</b><div class="row"><span>tokens</span><span>${fmt(d.data.value)}</span></div><div class="row"><span>share</span><span>${((100 * d.data.value) / total).toFixed(1)}%</span></div>${d.data.sub ? `<div class="muted">${esc(d.data.sub)}</div>` : ''}`, ev);
    })
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', function (_ev, d) {
      d3.select(this).transition().duration(120).attr('d', arc(d));
      hideTip();
    })
    .on('click', (_ev, d) => onClick?.(d.data))
    .transition().duration(500).attrTween('d', (d) => {
      const i = d3.interpolate({ ...d, endAngle: d.startAngle }, d);
      return (t) => arc(i(t)) || '';
    });
  g.append('text').attr('text-anchor', 'middle').attr('dy', '-0.1em').style('font-size', '22px').style('font-weight', '650').style('letter-spacing', '-.02em').text(center.value);
  g.append('text').attr('text-anchor', 'middle').attr('dy', '1.5em').style('font-size', '11px').style('fill', 'var(--muted-foreground)').text(center.label);
}

// ---------------------------------------------------------------------------- stacked bar

export function stackBar(el: HTMLElement, slices: Slice[], onClick?: (s: Slice) => void): void {
  const total = d3.sum(slices, (s) => s.value) || 1;
  whenSized(el, (w, _h, first) => {
    el.innerHTML = '';
    const h = 26;
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
    const x = d3.scaleLinear().domain([0, total]).range([0, w]);
    let acc = 0;
    const data = slices.filter((s) => s.value > 0).map((s) => ({ s, x0: (acc += s.value) - s.value }));
    svg.append('clipPath').attr('id', 'sb-clip').append('rect').attr('width', w).attr('height', h).attr('rx', 6);
    const g = svg.append('g').attr('clip-path', 'url(#sb-clip)');
    g.selectAll('g').data(data).join('g').attr('class', 'cell')
      .call((sel) => sel.append('rect').attr('x', (d) => x(d.x0)).attr('width', 0).attr('height', h).attr('fill', (d) => d.s.color)
        .transition().duration(first ? 450 : 0).attr('width', (d) => Math.max(0.5, x(d.s.value))))
      .call((sel) => sel.append('text').attr('x', (d) => x(d.x0) + 6).attr('y', h / 2 + 4)
        .attr('class', (d) => (readable(d.s.color) ? '' : 'dark'))
        .text((d) => (x(d.s.value) > 70 ? `${((100 * d.s.value) / total).toFixed(0)}%` : '')))
      .on('mouseenter', (ev: MouseEvent, d) => showTip(`<b>${esc(d.s.label)}</b><div class="row"><span>tokens</span><span>${fmt(d.s.value)}</span></div><div class="row"><span>share</span><span>${((100 * d.s.value) / total).toFixed(1)}%</span></div>`, ev))
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', hideTip)
      .on('click', (_ev, d) => onClick?.(d.s));
  });
}

// ---------------------------------------------------------------------------- icicle (request map)

export interface MapNode {
  id: string;
  name: string;
  /** JSON path into the request body, when the node is a real field */
  path?: string;
  color?: string;
  value?: number;
  exact?: boolean;
  sub?: string;
  children?: MapNode[];
}

export interface IcicleHandle { focus(id: string): void }

/** Zoomable horizontal icicle: one row per depth, width ∝ tokens. Click a cell to zoom into it. */
export function icicle(el: HTMLElement, data: MapNode, opts: { onSelect: (n: MapNode, trail: MapNode[]) => void; rowH?: number }): IcicleHandle {
  const rowH = opts.rowH ?? 34;
  const root = d3.hierarchy<MapNode>(data, (d) => d.children).sum((d) => (d.children && d.children.length ? 0 : Math.max(0, d.value || 0)));
  const depth = root.height + 1;
  const partition = d3.partition<MapNode>().padding(0);
  const laid = partition(root);
  const nodeById = new Map<string, D3.HierarchyRectangularNode<MapNode>>();
  laid.each((n) => nodeById.set(n.data.id, n));
  let focus = laid;
  let draw: (animate: boolean) => void = () => {};

  whenSized(el, (w) => {
    el.innerHTML = '';
    const h = depth * rowH;
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('height', h).style('overflow', 'hidden');
    const x = d3.scaleLinear().range([0, w]);
    const cells = svg.selectAll<SVGGElement, D3.HierarchyRectangularNode<MapNode>>('g').data(laid.descendants()).join('g').attr('class', 'cell');
    cells.append('rect').attr('rx', 4).attr('height', rowH - 2).attr('fill', (d) => d.data.color || '#94a3b8');
    cells.append('clipPath').attr('id', (d) => `ic-${cssId(d.data.id)}`).append('rect').attr('height', rowH - 2);
    cells.append('text').attr('y', rowH / 2 + 4).attr('x', 7).attr('clip-path', (d) => `url(#ic-${cssId(d.data.id)})`)
      .attr('class', (d) => (readable(d.data.color || '#94a3b8') ? '' : 'dark'));
    cells
      .on('mouseenter', (ev: MouseEvent, d) => {
        const pct = laid.value ? ((100 * (d.value || 0)) / laid.value).toFixed(1) : '0';
        showTip(`<b>${esc(d.data.name)}</b>${d.data.path ? `<div class="mono muted small">${esc(d.data.path)}</div>` : ''}<div class="row"><span>tokens</span><span>${d.data.exact === false ? '≈' : ''}${fmt(d.value)}</span></div><div class="row"><span>of request</span><span>${pct}%</span></div>${d.data.sub ? `<div class="muted">${esc(d.data.sub)}</div>` : ''}<div class="muted small">${d.children ? 'click to zoom · ' : ''}click to inspect</div>`, ev);
      })
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', hideTip)
      .on('click', (_ev, d) => {
        hideTip();
        select(d.children ? d : d.parent && d.parent !== focus ? d.parent : focus, d);
      });

    draw = (animate: boolean): void => {
      x.domain([focus.x0, focus.x1]);
      const t = svg.transition().duration(animate ? 550 : 0).ease(d3.easeCubicInOut);
      const yOf = (d: D3.HierarchyRectangularNode<MapNode>): number => (d.depth - focus.depth) * rowH;
      const wOf = (d: D3.HierarchyRectangularNode<MapNode>): number => Math.max(0, x(d.x1) - x(d.x0) - 1.5);
      const visible = (d: D3.HierarchyRectangularNode<MapNode>): boolean => d.depth >= focus.depth && x(d.x1) > 0 && x(d.x0) < w;
      cells.transition(t as never)
        .attr('transform', (d) => `translate(${Math.max(-2, x(d.x0))},${d.depth < focus.depth ? -rowH : yOf(d)})`)
        .style('opacity', (d) => (visible(d) ? 1 : 0));
      cells.style('pointer-events', (d) => (visible(d) ? null : 'none'));
      cells.select('rect').transition(t as never).attr('width', (d) => wOf(d));
      cells.select('clipPath rect').attr('width', (d) => Math.max(0, wOf(d) - 6));
      cells.select('text').text((d) => {
        const cw = wOf(d);
        if (cw < 34) return '';
        const v = fmtKk(d.value || 0);
        return cw > 110 ? `${d.data.name} · ${v}` : cw > 60 ? d.data.name : v;
      });
    };
    draw(false);
  });

  function trail(n: D3.HierarchyRectangularNode<MapNode>): MapNode[] {
    return n.ancestors().reverse().map((a) => a.data);
  }
  function select(zoomTo: D3.HierarchyRectangularNode<MapNode>, picked: D3.HierarchyRectangularNode<MapNode>): void {
    if (zoomTo !== focus) {
      focus = zoomTo;
      draw(true);
    }
    opts.onSelect(picked.data, trail(picked));
  }
  return {
    focus(id: string): void {
      const n = nodeById.get(id);
      if (!n) return;
      focus = n.children ? n : n.parent || laid;
      draw(true);
    },
  };
}

const cssId = (s: string): string => s.replace(/[^A-Za-z0-9_-]/g, '_');
const cssVar = (n: string): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

// ---------------------------------------------------------------------------- sankey

export interface SNode { id: string; label: string; color: string; column: number; tip?: string }
export interface SLink { source: string; target: string; value: number; color?: string; tip?: string }

type SkNode = SNode & { x0?: number; x1?: number; y0?: number; y1?: number; value?: number };
type SkLink = { source: SkNode; target: SkNode; value: number; width?: number; color?: string; tip?: string };

/** Sankey diagram with fixed columns (node.column), link width = value. Hover highlights a node's
 *  links; click calls onClick. Built on the vendored d3-sankey. */
export function sankeyChart(el: HTMLElement, nodes: SNode[], links: SLink[], opts: { onClick?: (n: SNode) => void; rowH?: number; minHeight?: number; empty?: string } = {}): void {
  const ids = new Set(nodes.map((n) => n.id));
  const used = links.filter((l) => l.value > 0 && ids.has(l.source) && ids.has(l.target) && l.source !== l.target);
  const linked = new Set(used.flatMap((l) => [l.source, l.target]));
  const ns = nodes.filter((n) => linked.has(n.id));
  if (!used.length) {
    el.innerHTML = `<div class="empty">${esc(opts.empty || 'Nothing flows here.')}</div>`;
    return;
  }
  const columns = d3.max(ns, (n) => n.column)! + 1;
  const perCol = d3.max(d3.rollups(ns, (v) => v.length, (n) => n.column), (d) => d[1]) || 1;
  whenSized(el, (w) => {
    el.innerHTML = '';
    const h = Math.max(opts.minHeight ?? 240, perCol * (opts.rowH ?? 26));
    // room for the first column's labels on the left and the last column's on the right
    const labelW = (col: number): number => 18 + 6.2 * (d3.max(ns.filter((n) => n.column === col), (n) => Math.min(34, n.label.length) + 3 + fmtKk(1000).length) || 0);
    const padL = Math.min(w * 0.3, labelW(0));
    const padR = Math.min(w * 0.3, labelW(columns - 1));
    const graph = { nodes: ns.map((n) => ({ ...n })) as SkNode[], links: used.map((l) => ({ ...l })) as unknown as SkLink[] };
    const layout = d3.sankey<SkNode, SkLink>()
      .nodeId((n) => n.id)
      .nodeAlign((n) => Math.min(columns - 1, (n as SkNode).column))
      .nodeWidth(12).nodePadding(Math.max(8, Math.min(16, (h - 20) / perCol / 3)))
      .extent([[padL, 8], [w - padR, h - 8]]);
    try {
      layout(graph as never);
    } catch (e) {
      el.innerHTML = `<div class="empty">Could not lay out this flow: ${esc((e as Error).message)}</div>`;
      return;
    }
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
    const link = svg.append('g').attr('fill', 'none').selectAll<SVGPathElement, SkLink>('path').data(graph.links).join('path')
      .attr('class', 'link')
      .attr('d', d3.sankeyLinkHorizontal() as never)
      .style('stroke', (l) => l.color || l.source.color)
      .style('stroke-opacity', 0.38)
      .style('stroke-linecap', 'butt')
      .attr('stroke-width', (l) => Math.max(1, l.width || 0))
      .on('mouseenter', (ev: MouseEvent, l) => showTip(l.tip || `<b>${esc(l.source.label)} → ${esc(l.target.label)}</b><div class="row"><span>tokens</span><span>${fmt(l.value)}</span></div>`, ev))
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', hideTip);
    const node = svg.append('g').selectAll<SVGGElement, SkNode>('g').data(graph.nodes).join('g').attr('class', 'node');
    node.append('rect').attr('x', (n) => n.x0!).attr('y', (n) => n.y0!).attr('width', (n) => n.x1! - n.x0!).attr('height', (n) => Math.max(1.5, n.y1! - n.y0!))
      .attr('rx', 2).style('fill', (n) => n.color).style('stroke', 'none');
    // keep labels in one column at least 13px apart (small nodes sit on top of each other)
    const labelY = new Map<SkNode, number>();
    for (const colNodes of d3.groups(graph.nodes, (n) => n.x0).map((g) => g[1])) {
      const sorted = colNodes.slice().sort((p, q) => p.y0! - q.y0!);
      let last = -Infinity;
      for (const n of sorted) { const y = Math.max((n.y0! + n.y1!) / 2, last + 13); labelY.set(n, y); last = y; }
      const overflow = last - (h - 6);
      if (overflow > 0) for (const n of sorted) labelY.set(n, labelY.get(n)! - overflow);
    }
    const leftmost = d3.min(graph.nodes, (n) => n.x0!)!;
    const onLeft = (n: SkNode): boolean => n.x0 === leftmost; // first column labels sit left, the rest right
    node.append('text').attr('class', 'lbl')
      .attr('x', (n) => (onLeft(n) ? n.x0! - 6 : n.x1! + 6))
      .attr('y', (n) => labelY.get(n)!).attr('dy', '0.35em')
      .attr('text-anchor', (n) => (onLeft(n) ? 'end' : 'start'))
      .text((n) => `${clip(n.label, 34)} · ${fmtKk(n.value || 0)}`);
    const touches = (l: SkLink, n: SkNode): boolean => l.source === n || l.target === n;
    node
      .on('mouseenter', (ev: MouseEvent, n) => {
        link.classed('dim', (l) => !touches(l, n)).style('stroke-opacity', (l) => (touches(l, n) ? 0.7 : 0.38));
        showTip(n.tip || `<b>${esc(n.label)}</b><div class="row"><span>tokens</span><span>${fmt(n.value)}</span></div>`, ev);
      })
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', () => { link.classed('dim', false).style('stroke-opacity', 0.38); hideTip(); })
      .on('click', (_ev, n) => opts.onClick?.(n));
  });
}

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n - 1) + '…' : s);

// ---------------------------------------------------------------------------- arc diagram

export interface ArcNode { id: string; label: string; color: string; square?: boolean; value: number; tip: string; tick?: string }
export interface Arc { source: string; target: string; value: number; color: string; above: boolean; group: string; tip: string }
export interface ArcOrder { key: string; label: string; ids: string[] }
export interface ArcGroup { key: string; label: string; color: string; sub: string }

/** Nodes on one horizontal axis, arcs above and below it (width = value). An order select
 *  re-sorts the axis with a transition. */
export function arcDiagram(el: HTMLElement, nodes: ArcNode[], arcs: Arc[], opts: { orders: ArcOrder[]; groups: ArcGroup[]; aboveLabel: string; belowLabel: string; onClick?: (n: ArcNode) => void }): void {
  el.innerHTML = `<div class="toolbar arc-bar"><label class="small muted" for="arc-order">order</label><select id="arc-order" class="select">${opts.orders.map((o) => `<option value="${esc(o.key)}">${esc(o.label)}</option>`).join('')}</select>
    <span class="grow"></span>${opts.groups.map((g) => `<span class="chipk" data-g="${esc(g.key)}"><span class="k" style="background:${g.color}"></span>${esc(g.label)} <span class="muted mono">${esc(g.sub)}</span></span>`).join('')}</div><div class="arc-plot"></div>`;
  const plot = el.querySelector<HTMLElement>('.arc-plot')!;
  const select = el.querySelector<HTMLSelectElement>('#arc-order')!;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const valid = arcs.filter((a) => byId.has(a.source) && byId.has(a.target) && a.value > 0);
  const wScale = d3.scaleSqrt().domain([0, d3.max(valid, (a) => a.value) || 1]).range([1, 12]);
  const rScale = d3.scaleSqrt().domain([0, d3.max(nodes, (n) => n.value) || 1]).range([2, 7]);
  let order = opts.orders[0];
  let redraw: (animate: boolean) => void = () => {};

  whenSized(plot, (w) => {
    plot.innerHTML = '';
    const lobe = 140;
    const m = { t: 18, b: 26, l: 16, r: 16 };
    const h = m.t + lobe * 2 + m.b;
    const axisY = m.t + lobe;
    const svg = d3.select(plot).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
    svg.append('text').attr('class', 'lbl muted-t').attr('x', m.l).attr('y', m.t - 4).text(`▲ ${opts.aboveLabel}`);
    svg.append('text').attr('class', 'lbl muted-t').attr('x', m.l).attr('y', h - 6).text(`▼ ${opts.belowLabel}`);
    svg.append('line').attr('x1', m.l).attr('x2', w - m.r).attr('y1', axisY).attr('y2', axisY).style('stroke', 'var(--border)');
    const x = d3.scalePoint<string>().range([m.l, w - m.r]).padding(0.5);
    const path = (a: Arc): string => {
      const x1 = x(a.source) ?? 0;
      const x2 = x(a.target) ?? 0;
      const rx = Math.abs(x2 - x1) / 2 || 0.5;
      const ry = Math.min(lobe - 6, rx);
      const sweep = a.above === x1 < x2 ? 1 : 0;
      return `M${x1},${axisY}A${rx},${ry} 0 0,${sweep} ${x2},${axisY}`;
    };
    const arcSel = svg.append('g').attr('fill', 'none').selectAll<SVGPathElement, Arc>('path').data(valid).join('path')
      .attr('class', 'link').style('stroke', (a) => a.color).style('stroke-opacity', 0.5).attr('stroke-width', (a) => wScale(a.value))
      .on('mouseenter', (ev: MouseEvent, a) => { focus((b) => b === a); showTip(a.tip, ev); })
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', () => { focus(null); hideTip(); });
    const nodeSel = svg.append('g').selectAll<SVGGElement, ArcNode>('g').data(nodes, (n) => n.id).join('g').attr('class', 'node');
    nodeSel.filter((n) => !n.square).append('circle').attr('r', (n) => rScale(n.value)).style('fill', (n) => n.color).style('stroke', 'var(--card)').style('stroke-width', 1);
    nodeSel.filter((n) => !!n.square).append('rect').attr('x', -6).attr('y', -6).attr('width', 12).attr('height', 12).attr('rx', 2).style('fill', 'var(--card)').style('stroke', (n) => n.color).style('stroke-width', 2.5);
    const ticks = svg.append('g').attr('class', 'axis');
    nodeSel
      .on('mouseenter', (ev: MouseEvent, n) => { focus((a) => a.source === n.id || a.target === n.id); showTip(n.tip, ev); })
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', () => { focus(null); hideTip(); })
      .on('click', (_ev, n) => opts.onClick?.(n));
    function focus(pred: ((a: Arc) => boolean) | null): void {
      arcSel.classed('dim', (a) => !!pred && !pred(a)).style('stroke-opacity', (a) => (pred && pred(a) ? 0.85 : 0.5));
    }
    el.querySelectorAll<HTMLElement>('.chipk').forEach((c) => {
      c.onmouseenter = () => focus((a) => a.group === c.dataset.g);
      c.onmouseleave = () => focus(null);
    });
    redraw = (animate: boolean): void => {
      x.domain(order.ids);
      const t = svg.transition().duration(animate ? 700 : 0).ease(d3.easeCubicInOut);
      nodeSel.transition(t as never).attr('transform', (n) => `translate(${x(n.id) ?? -20},${axisY})`);
      arcSel.transition(t as never).attr('d', path);
      const every = Math.max(1, Math.ceil(order.ids.length / Math.max(1, Math.floor((w - m.l - m.r) / 38))));
      ticks.selectAll('text').data(order.ids.filter((_id, i) => i % every === 0), (d) => d as string).join('text')
        .attr('y', axisY + 4).attr('dy', '0.9em').attr('text-anchor', 'middle').style('font-size', '9.5px')
        .text((id) => byId.get(id)?.tick || '')
        .transition(t as never).attr('x', (id) => x(id) ?? -50);
    };
    redraw(false);
  });
  select.onchange = () => {
    order = opts.orders.find((o) => o.key === select.value) || opts.orders[0];
    redraw(true);
  };
}

// ---------------------------------------------------------------------------- collapsible tree

export interface TreeNode { id: string; label: string; color: string; value: number; tip: string; hollow?: boolean; collapsed?: boolean; children?: TreeNode[] }

/** Horizontal tidy tree; click an inner node to expand or collapse it, click a leaf for onLeaf. */
export function collapsibleTree(el: HTMLElement, data: TreeNode, opts: { onLeaf?: (n: TreeNode) => void } = {}): void {
  const closed = new Set<string>();
  const walk = (n: TreeNode): void => { if (n.collapsed && n.children?.length) closed.add(n.id); n.children?.forEach(walk); };
  walk(data);
  const maxVal = (() => { let m = 1; const v = (n: TreeNode): void => { if (!n.children?.length) m = Math.max(m, n.value); n.children?.forEach(v); }; v(data); return m; })();
  const rScale = d3.scaleSqrt().domain([0, maxVal]).range([3, 11]);
  const prev = new Map<string, { x: number; y: number }>();
  let width = 0;
  let update: (source: string | null, animate: boolean) => void = () => {};

  whenSized(el, (w) => {
    width = w;
    el.innerHTML = '';
    const svg = d3.select(el).append('svg');
    const gLink = svg.append('g').attr('fill', 'none');
    const gNode = svg.append('g');
    const dx = 24;
    update = (sourceId, animate) => {
      const root = d3.hierarchy<TreeNode>(data, (d) => (closed.has(d.id) ? null : d.children));
      const depth = Math.max(1, root.height);
      const room = Math.min(220, Math.max(120, width * 0.16)); // left of the root for its label
      const dy = Math.min(250, Math.max(130, (width - room - 300) / depth));
      d3.tree<TreeNode>().nodeSize([dx, dy])(root);
      const all = root.descendants() as D3.HierarchyPointNode<TreeNode>[];
      const [x0, x1] = d3.extent(all, (n) => n.x) as [number, number];
      const h = x1 - x0 + dx * 2;
      const t = svg.transition().duration(animate ? 350 : 0);
      svg.transition(t as never).attr('viewBox', `${-room} ${x0 - dx} ${width} ${h}`).attr('height', h);
      const from = (sourceId && prev.get(sourceId)) || { x: root.x ?? 0, y: 0 };
      const nodeSel = gNode.selectAll<SVGGElement, D3.HierarchyPointNode<TreeNode>>('g').data(all, (n) => n.data.id);
      const enter = nodeSel.enter().append('g').attr('class', 'node').attr('transform', `translate(${from.y},${from.x})`).style('opacity', 0)
        .on('mouseenter', (ev: MouseEvent, n) => showTip(n.data.tip, ev))
        .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
        .on('mouseleave', hideTip)
        .on('click', (_ev, n) => {
          if (n.data.children?.length) {
            if (closed.has(n.data.id)) closed.delete(n.data.id);
            else closed.add(n.data.id);
            update(n.data.id, true);
          } else opts.onLeaf?.(n.data);
        });
      enter.append('circle');
      enter.append('text').attr('class', 'lbl').attr('dy', '0.32em');
      const merged = enter.merge(nodeSel);
      merged.select('circle').attr('r', (n) => (n.data.children?.length ? 5.5 : rScale(n.data.value)))
        .style('fill', (n) => (n.data.hollow ? 'var(--card)' : closed.has(n.data.id) ? 'var(--card)' : n.data.color))
        .style('stroke', (n) => n.data.color).style('stroke-width', (n) => (closed.has(n.data.id) ? 2.5 : 1.5))
        .style('opacity', (n) => (n.data.hollow ? 0.6 : 1));
      merged.select('text')
        .attr('x', (n) => (n.data.children?.length ? -10 : rScale(n.data.value) + 6))
        .attr('text-anchor', (n) => (n.data.children?.length ? 'end' : 'start'))
        .style('opacity', (n) => (n.data.hollow ? 0.6 : 1))
        .text((n) => `${clip(n.data.label, 44)}${n.data.value ? ` · ${fmtKk(n.data.value)}` : ''}${closed.has(n.data.id) ? ` (+${n.data.children!.length})` : ''}`);
      merged.transition(t as never).attr('transform', (n) => `translate(${n.y},${n.x})`).style('opacity', 1);
      nodeSel.exit().transition(t as never).remove().attr('transform', () => { const p = root.find((n) => n.data.id === sourceId); return `translate(${p?.y ?? 0},${p?.x ?? 0})`; }).style('opacity', 0);

      const links = root.links() as Array<D3.HierarchyPointLink<TreeNode>>;
      const diag = d3.linkHorizontal<unknown, { x: number; y: number }>().x((p) => p.y).y((p) => p.x);
      const linkSel = gLink.selectAll<SVGPathElement, D3.HierarchyPointLink<TreeNode>>('path').data(links, (l) => l.target.data.id);
      linkSel.enter().append('path').attr('class', 'link').style('stroke', 'var(--muted-foreground)').style('stroke-opacity', 0.35).attr('stroke-width', 1.2)
        .attr('d', () => diag({ source: from, target: from } as never)!)
        .merge(linkSel)
        .transition(t as never).attr('d', (l) => diag({ source: { x: l.source.x, y: l.source.y }, target: { x: l.target.x, y: l.target.y } } as never)!);
      linkSel.exit().transition(t as never).remove().attr('d', () => { const p = root.find((n) => n.data.id === sourceId); const q = { x: p?.x ?? 0, y: p?.y ?? 0 }; return diag({ source: q, target: q } as never)!; });
      prev.clear();
      for (const n of all) prev.set(n.data.id, { x: n.x, y: n.y });
    };
    update(null, false);
  });
}

// ---------------------------------------------------------------------------- presence heatmap

export interface HeatRow { id: string; label: string; color: string; sub?: string }
export interface HeatCol { id: string; seq: number; mark?: boolean; selected?: boolean }

/** Rows × steps heatmap on a canvas (sessions can have hundreds of steps); empty cells stay blank. */
export function presenceHeatmap(el: HTMLElement, rows: HeatRow[], cols: HeatCol[], value: (r: number, c: number) => number, opts: { tip: (r: number, c: number, v: number) => string; onCell?: (r: number, c: number) => void; markLabel: string }): void {
  const rh = 18;
  el.innerHTML = `<div class="heat"><div class="heat-rows">${rows.map((r) => `<div class="heat-row" title="${esc(r.sub || r.label)}"><span class="k" style="background:${r.color}"></span>${esc(r.label)}</div>`).join('')}<div class="heat-row axis-pad"></div></div><div class="heat-scroll"><canvas></canvas><svg class="heat-axis"></svg></div></div>
    <div class="heat-key small muted"><span>fewer tokens</span><span class="ramp"></span><span>more</span><span class="sep"></span><span class="markk"></span>${esc(opts.markLabel)}<span class="sep"></span><span class="selk"></span>selected step · click a cell to open that step</div>`;
  const scroll = el.querySelector<HTMLElement>('.heat-scroll')!;
  const canvas = el.querySelector('canvas')!;
  const axis = el.querySelector<SVGSVGElement>('.heat-axis')!;
  let max = 1;
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < cols.length; c++) max = Math.max(max, value(r, c));
  const t = d3.scaleSqrt().domain([0, max]).range([0.18, 1]);
  whenSized(scroll, (w) => {
    const cw = Math.max(4, Math.floor(w / Math.max(1, cols.length)));
    const W = cw * cols.length;
    const H = rh * rows.length;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
    const ctx = canvas.getContext('2d')!;
    ctx.scale(dpr, dpr);
    const lo = cssVar('--muted-bg') || '#f4f4f5';
    const hi = cssVar('--hl') || '#2563eb';
    const color = d3.interpolateRgb(lo, hi);
    el.querySelector<HTMLElement>('.ramp')!.style.background = `linear-gradient(90deg, ${color(0.18)}, ${color(1)})`;
    ctx.strokeStyle = cssVar('--border') || '#e4e4e7';
    for (let r = 0; r <= rows.length; r++) { ctx.beginPath(); ctx.moveTo(0, r * rh + 0.5); ctx.lineTo(W, r * rh + 0.5); ctx.globalAlpha = 0.5; ctx.stroke(); }
    ctx.globalAlpha = 1;
    cols.forEach((col, c) => {
      if (col.mark) { ctx.fillStyle = '#e11d4833'; ctx.fillRect(c * cw, 0, cw, H); }
      for (let r = 0; r < rows.length; r++) {
        const v = value(r, c);
        if (v <= 0) continue;
        ctx.fillStyle = color(t(v));
        ctx.fillRect(c * cw + (cw > 5 ? 0.5 : 0), r * rh + 2, cw - (cw > 5 ? 1 : 0), rh - 4);
      }
    });
    const sel = cols.findIndex((c) => c.selected);
    if (sel >= 0) { ctx.strokeStyle = hi; ctx.lineWidth = 1.5; ctx.strokeRect(sel * cw + 0.75, 0.75, cw - 1.5, H - 1.5); }
    const every = Math.max(1, Math.ceil(46 / cw));
    d3.select(axis).attr('width', W).attr('height', 22).attr('viewBox', `0 0 ${W} 22`)
      .selectAll('text').data(cols.map((c, i) => ({ c, i })).filter((d) => d.i % every === 0)).join('text')
      .attr('x', (d) => d.i * cw + cw / 2).attr('y', 14).attr('text-anchor', 'middle').style('font-size', '10px').style('fill', 'var(--muted-foreground)')
      .text((d) => `#${d.c.seq}`);
    if (sel >= 0 && scroll.scrollWidth > scroll.clientWidth) scroll.scrollLeft = Math.max(0, sel * cw - scroll.clientWidth / 2);
    const at = (ev: MouseEvent): [number, number] => {
      const b = canvas.getBoundingClientRect();
      return [Math.floor((ev.clientY - b.top) / rh), Math.floor((ev.clientX - b.left) / cw)];
    };
    canvas.onmousemove = (ev) => {
      const [r, c] = at(ev);
      if (r < 0 || r >= rows.length || c < 0 || c >= cols.length) return hideTip();
      showTip(opts.tip(r, c, value(r, c)), ev);
    };
    canvas.onmouseleave = hideTip;
    canvas.onclick = (ev) => {
      const [r, c] = at(ev);
      if (r >= 0 && r < rows.length && c >= 0 && c < cols.length) opts.onCell?.(r, c);
    };
  });
}

// ---------------------------------------------------------------------------- session timeline

export interface TLStep { id: string; seq: number; label: string; layers: Record<string, number>; prompt: number; cacheRead: number; selected?: boolean }
export interface TLSide { id: string; seq: number; label: string; after: number }

/** Stacked area of context by kind over the agent turns, with a cache difference panel below that
 *  shares the x axis. Wheel / drag zooms both; a crosshair reads out every layer; click opens a step. */
export function sessionTimeline(el: HTMLElement, steps: TLStep[], sides: TLSide[], keys: Slice[], opts: { onClick: (id: string) => void }): void {
  if (!steps.length) {
    el.innerHTML = '<div class="empty">No completed agent turns in this session yet.</div>';
    return;
  }
  whenSized(el, (w) => {
    el.innerHTML = '';
    const m = { t: 8, r: 14, b: 22, l: 48 };
    const h1 = 230;
    const gap = 46;
    const h2 = 120;
    const H = m.t + h1 + gap + h2 + m.b;
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${H}`).attr('height', H);
    const clipId = `tl-clip-${Math.random().toString(36).slice(2, 8)}`;
    svg.append('clipPath').attr('id', clipId).append('rect').attr('x', m.l).attr('y', 0).attr('width', w - m.l - m.r).attr('height', H);
    const n = steps.length;
    const x = d3.scaleLinear().domain([0, Math.max(1, n - 1)]).range([m.l, w - m.r]);
    const stack = d3.stack<TLStep>().keys(keys.map((k) => k.key)).value((d, k) => d.layers[k] || 0);
    const series = stack(steps);
    const y1 = d3.scaleLinear().domain([0, d3.max(series.at(-1) || [], (d) => d[1]) || 1]).nice().range([m.t + h1, m.t]);
    const top2 = m.t + h1 + gap;
    const y2 = d3.scaleLinear().domain([0, d3.max(steps, (s) => s.prompt) || 1]).nice().range([top2 + h2, top2]);
    const colorOf = new Map(keys.map((k) => [k.key, k.color]));
    const labelOf = new Map(keys.map((k) => [k.key, k.label]));

    const gx1 = svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${m.t + h1})`);
    const gx2 = svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${top2 + h2})`);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y1).ticks(5).tickFormat((v) => fmtKk(Number(v))).tickSize(-(w - m.l - m.r)))
      .call((g) => g.select('.domain').remove()).call((g) => g.selectAll('.tick line').style('stroke-opacity', 0.45));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y2).ticks(3).tickFormat((v) => fmtKk(Number(v))).tickSize(-(w - m.l - m.r)))
      .call((g) => g.select('.domain').remove()).call((g) => g.selectAll('.tick line').style('stroke-opacity', 0.45));
    svg.append('text').attr('class', 'lbl muted-t').attr('x', m.l).attr('y', top2 - 10).text('cache: read (green) vs. missed = written + uncached (amber) · line = prompt total');

    const plot = svg.append('g').attr('clip-path', `url(#${clipId})`);
    const layers = plot.append('g').selectAll('path').data(series).join('path').style('fill', (s) => colorOf.get(s.key) || '#94a3b8').style('stroke', 'none').style('fill-opacity', 0.9);
    const readArea = plot.append('path').style('fill', kindTint('#16a34a')).style('stroke', 'none');
    const missArea = plot.append('path').style('fill', kindTint('#d97706')).style('stroke', 'none');
    const promptLine = plot.append('path').style('fill', 'none').style('stroke', 'var(--foreground)').style('stroke-width', 1.2);
    const sideTicks = plot.append('g').selectAll('line').data(sides).join('line').style('stroke', 'var(--muted-foreground)').style('stroke-width', 1.5)
      .attr('y1', m.t + h1 - 6).attr('y2', m.t + h1);
    const sel = steps.findIndex((s) => s.selected);
    const selLine = plot.append('line').style('stroke', 'var(--hl)').style('stroke-width', 1.5).attr('y1', m.t).attr('y2', top2 + h2).style('display', sel >= 0 ? 'inline' : 'none');
    const cross = svg.append('line').style('stroke', 'var(--foreground)').style('stroke-opacity', 0.5).style('stroke-dasharray', '3 3').attr('y1', m.t).attr('y2', top2 + h2).style('display', 'none').style('pointer-events', 'none');

    let xz = x;
    const draw = (): void => {
      const area = d3.area<D3.SeriesPoint<TLStep>>().x((_d, i) => xz(i)).y0((d) => y1(d[0])).y1((d) => y1(d[1]));
      layers.attr('d', (s) => area(s));
      readArea.attr('d', d3.area<TLStep>().x((_d, i) => xz(i)).y0(y2(0)).y1((s) => y2(s.cacheRead))(steps));
      missArea.attr('d', d3.area<TLStep>().x((_d, i) => xz(i)).y0((s) => y2(s.cacheRead)).y1((s) => y2(s.prompt))(steps));
      promptLine.attr('d', d3.line<TLStep>().x((_d, i) => xz(i)).y((s) => y2(s.prompt))(steps));
      sideTicks.attr('x1', (s) => xz(s.after + 0.5)).attr('x2', (s) => xz(s.after + 0.5));
      if (sel >= 0) selLine.attr('x1', xz(sel)).attr('x2', xz(sel));
      const [a, b] = xz.domain();
      const ticks = xz.ticks(Math.max(2, Math.floor((w - m.l) / 70))).filter((v) => Number.isInteger(v) && v >= Math.max(0, a) && v <= Math.min(n - 1, b));
      const ax = d3.axisBottom(xz).tickValues(ticks).tickFormat((v) => `#${steps[Number(v)]?.seq ?? ''}`).tickSize(3);
      gx1.call(ax).call((g) => g.select('.domain').remove());
      gx2.call(ax).call((g) => g.select('.domain').remove());
    };
    draw();

    const overlay = svg.append('rect').attr('x', m.l).attr('y', m.t).attr('width', w - m.l - m.r).attr('height', top2 + h2 - m.t).style('fill', 'transparent').style('cursor', 'crosshair');
    const zoom = d3.zoom<SVGRectElement, unknown>().scaleExtent([1, Math.max(1, n / 6)]).extent([[m.l, 0], [w - m.r, H]]).translateExtent([[m.l, 0], [w - m.r, H]])
      .on('zoom', (ev: D3.D3ZoomEvent<SVGRectElement, unknown>) => { xz = ev.transform.rescaleX(x); draw(); });
    overlay.call(zoom).on('dblclick.zoom', null).on('dblclick', () => overlay.transition().duration(300).call(zoom.transform, d3.zoomIdentity));
    const nearest = (ev: MouseEvent): number => Math.max(0, Math.min(n - 1, Math.round(xz.invert(d3.pointer(ev, svg.node())[0]))));
    overlay
      .on('pointermove', (ev: PointerEvent) => {
        const i = nearest(ev);
        const s = steps[i];
        cross.style('display', null).attr('x1', xz(i)).attr('x2', xz(i));
        const rows = Object.entries(s.layers).filter(([, v]) => v > 0).sort((p, q) => q[1] - p[1]).slice(0, 8)
          .map(([k, v]) => `<div class="row"><span><span class="k" style="background:${colorOf.get(k) || '#94a3b8'}"></span>${esc(labelOf.get(k) || k)}</span><span>${fmt(v)}</span></div>`).join('');
        const miss = Math.max(0, s.prompt - s.cacheRead);
        showTip(`<b>#${s.seq} ${esc(s.label)}</b>${rows}<div class="row" style="border-top:1px solid var(--border);margin-top:3px;padding-top:3px"><span>prompt (server)</span><span>${fmt(s.prompt)}</span></div><div class="row"><span>cache read</span><span>${fmt(s.cacheRead)}</span></div><div class="row"><span>cache missed</span><span>${fmt(miss)} · ${s.prompt ? ((100 * miss) / s.prompt).toFixed(0) : 0}%</span></div><div class="muted small">click to open · wheel to zoom · double-click to reset</div>`, ev);
      })
      .on('pointerleave', () => { cross.style('display', 'none'); hideTip(); })
      .on('click', (ev: MouseEvent) => { hideTip(); opts.onClick(steps[nearest(ev)].id); });
  });
}

const kindTint = (hex: string): string => `color-mix(in srgb, ${hex} 55%, transparent)`;
