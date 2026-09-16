// d3 charts for the inspector: area donut, zoomable request map (icicle), force-directed
// relation graphs, and the per-session step columns. d3 is vendored (vendor/d3.min.js) and
// loaded as a global before app.js. Compiled to dist/ui/charts.js.
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

// ---------------------------------------------------------------------------- force graph

export interface GNode {
  id: string;
  label: string;
  color: string;
  r: number;
  group?: string;
  /** anchor positions in [0,1] of the canvas (weak forces pull the node toward them) */
  ax?: number;
  ay?: number;
  fixed?: boolean;
  dim?: boolean;
  ring?: boolean;
  tip?: string;
  labelAlways?: boolean;
}
export interface GLink {
  source: string;
  target: string;
  value: number;
  color?: string;
  dash?: string;
  width?: number;
  tree?: boolean;
  tip?: string;
}

type SimNode = GNode & D3.SimulationNodeDatum;
type SimLink = Omit<GLink, 'source' | 'target'> & D3.SimulationLinkDatum<SimNode>;

export interface ForceOptions {
  onClick?: (n: GNode) => void;
  legend?: string;
  linkDistance?: (l: GLink) => number;
  charge?: number;
  anchorStrength?: number;
  maxWidth?: number;
}

export interface ForceHandle { highlight(id: string | null): void; fit(): void; destroy(): void }

export function forceGraph(el: HTMLElement, nodes: GNode[], links: GLink[], opts: ForceOptions = {}): ForceHandle {
  el.innerHTML = '';
  const w = el.clientWidth || 800;
  const h = el.clientHeight || 460;
  const simNodes: SimNode[] = nodes.map((n) => {
    const x = (n.ax ?? 0.5) * w;
    const y = (n.ay ?? 0.5) * h;
    return n.fixed ? { ...n, x, y, fx: x, fy: y } : { ...n, x: x + (Math.random() - 0.5) * 40, y: y + (Math.random() - 0.5) * 40 };
  });
  const byId = new Map(simNodes.map((n) => [n.id, n]));
  const simLinks: SimLink[] = links.filter((l) => byId.has(l.source) && byId.has(l.target)).map((l) => ({ ...l, source: byId.get(l.source)!, target: byId.get(l.target)! }));
  const maxV = d3.max(simLinks, (l) => l.value) || 1;
  const wScale = d3.scaleSqrt().domain([0, maxV]).range([0.8, opts.maxWidth ?? 9]);

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`);
  const defs = svg.append('defs');
  defs.append('marker').attr('id', 'arrow').attr('viewBox', '0 -4 8 8').attr('refX', 8).attr('markerWidth', 5).attr('markerHeight', 5).attr('orient', 'auto')
    .append('path').attr('d', 'M0,-4L8,0L0,4').attr('fill', 'var(--muted-foreground)');
  const view = svg.append('g');
  const zoom = d3.zoom<SVGSVGElement, undefined>().scaleExtent([0.15, 5]).on('zoom', (ev: D3.D3ZoomEvent<SVGSVGElement, undefined>) => view.attr('transform', ev.transform.toString()));
  (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).call(zoom).on('dblclick.zoom', null);

  const link = view.append('g').selectAll<SVGPathElement, SimLink>('path').data(simLinks).join('path')
    .attr('class', 'link')
    .attr('stroke', (l) => l.color || 'var(--muted-foreground)')
    .attr('stroke-opacity', (l) => (l.tree ? 0.35 : 0.55))
    .attr('stroke-width', (l) => l.width ?? wScale(l.value))
    .attr('stroke-dasharray', (l) => l.dash || null)
    .on('mouseenter', (ev: MouseEvent, l) => { if (l.tip) showTip(l.tip, ev); })
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', hideTip);

  const node = view.append('g').selectAll<SVGGElement, SimNode>('g').data(simNodes).join('g').attr('class', 'node')
    .style('opacity', (n) => (n.dim ? 0.45 : 1));
  node.append('circle').attr('r', (n) => n.r).style('fill', (n) => (n.ring ? 'var(--card)' : n.color))
    .style('stroke', (n) => (n.ring ? n.color : 'var(--card)')).style('stroke-width', (n) => (n.ring ? 2.5 : 1.5));
  node.append('text').attr('x', (n) => n.r + 4).attr('y', 3.5).text((n) => n.label)
    .style('display', (n) => (n.labelAlways || n.r >= 7 ? null : 'none'));

  const neighbors = new Map<string, Set<string>>();
  for (const l of simLinks) {
    const s = (l.source as SimNode).id;
    const t = (l.target as SimNode).id;
    if (!neighbors.has(s)) neighbors.set(s, new Set([s]));
    if (!neighbors.has(t)) neighbors.set(t, new Set([t]));
    neighbors.get(s)!.add(t);
    neighbors.get(t)!.add(s);
  }
  const highlight = (id: string | null): void => {
    if (!id) {
      node.classed('dim', false).select('text').style('display', (n) => (n.labelAlways || n.r >= 7 ? null : 'none'));
      link.classed('dim', false);
      return;
    }
    const hood = neighbors.get(id) || new Set([id]);
    node.classed('dim', (n) => !hood.has(n.id)).select('text').style('display', (n) => (hood.has(n.id) || n.labelAlways || n.r >= 7 ? null : 'none'));
    link.classed('dim', (l) => (l.source as SimNode).id !== id && (l.target as SimNode).id !== id);
  };
  node
    .on('mouseenter', (ev: MouseEvent, n) => { highlight(n.id); showTip(n.tip || `<b>${esc(n.label)}</b>`, ev); })
    .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
    .on('mouseleave', () => { highlight(null); hideTip(); })
    .on('click', (_ev, n) => opts.onClick?.(n));

  const sim = d3.forceSimulation<SimNode>(simNodes)
    .force('link', d3.forceLink<SimNode, SimLink>(simLinks).id((n) => n.id).distance((l) => (opts.linkDistance ? opts.linkDistance(l as unknown as GLink) : 60)).strength((l) => (l.tree ? 0.9 : 0.25)))
    .force('charge', d3.forceManyBody<SimNode>().strength((n) => (opts.charge ?? -160) * Math.max(0.6, n.r / 8)).distanceMax(500))
    .force('collide', d3.forceCollide<SimNode>().radius((n) => n.r + (n.fixed ? 3 : n.labelAlways ? 22 : 5)))
    .force('ax', d3.forceX<SimNode>((n) => (n.ax ?? 0.5) * w).strength((n) => (n.ax == null ? 0.02 : opts.anchorStrength ?? 0.25)))
    .force('ay', d3.forceY<SimNode>((n) => (n.ay ?? 0.5) * h).strength((n) => (n.ay == null ? 0.03 : opts.anchorStrength ?? 0.25)));

  const drag = d3.drag<SVGGElement, SimNode>()
    .on('start', (ev: D3.D3DragEvent<SVGGElement, SimNode, SimNode>, n) => { if (!ev.active) sim.alphaTarget(0.25).restart(); n.fx = n.x; n.fy = n.y; })
    .on('drag', (ev: D3.D3DragEvent<SVGGElement, SimNode, SimNode>, n) => { n.fx = ev.x; n.fy = ev.y; })
    .on('end', (ev: D3.D3DragEvent<SVGGElement, SimNode, SimNode>, n) => { if (!ev.active) sim.alphaTarget(0); if (!n.fixed) { n.fx = null; n.fy = null; } });
  node.call(drag);

  const curve = (l: SimLink): string => {
    const s = l.source as SimNode;
    const t = l.target as SimNode;
    const dx = t.x! - s.x!;
    const dy = t.y! - s.y!;
    const dist = Math.hypot(dx, dy) || 1;
    const ex = t.x! - (dx / dist) * (t.r + 2);
    const ey = t.y! - (dy / dist) * (t.r + 2);
    if (l.tree) return `M${s.x},${s.y}L${ex},${ey}`;
    const bend = dist * 0.18;
    const mx = (s.x! + ex) / 2 - (dy / dist) * bend;
    const my = (s.y! + ey) / 2 + (dx / dist) * bend;
    return `M${s.x},${s.y}Q${mx},${my} ${ex},${ey}`;
  };
  const tick = (): void => {
    link.attr('d', curve);
    node.attr('transform', (n) => `translate(${n.x},${n.y})`);
  };
  sim.on('tick', tick);
  // settle mostly off-screen so the first paint is readable, then let it breathe
  sim.stop();
  for (let i = 0; i < 180; i++) sim.tick();
  tick();
  sim.alpha(0.08).restart();

  const fit = (): void => {
    const xs = d3.extent(simNodes, (n) => n.x!) as [number, number];
    const ys = d3.extent(simNodes, (n) => n.y!) as [number, number];
    if (xs[0] == null) return;
    const bw = xs[1] - xs[0] + 160;
    const bh = ys[1] - ys[0] + 80;
    const k = Math.min(2, 0.95 / Math.max(bw / w, bh / h));
    const tx = w / 2 - k * (xs[0] + xs[1]) / 2;
    const ty = h / 2 - k * (ys[0] + ys[1]) / 2;
    (svg as unknown as D3.Selection<SVGSVGElement, undefined, null, undefined>).transition().duration(450).call(zoom.transform, d3.zoomIdentity.translate(tx, ty).scale(k));
  };
  setTimeout(fit, 30);

  const ctrl = document.createElement('div');
  ctrl.className = 'ctrl';
  ctrl.innerHTML = '<button class="icon" data-g="fit" title="fit to view">fit</button><button class="icon" data-g="shake" title="re-run the layout">relayout</button>';
  el.appendChild(ctrl);
  (ctrl.querySelector('[data-g=fit]') as HTMLElement).onclick = fit;
  (ctrl.querySelector('[data-g=shake]') as HTMLElement).onclick = () => { sim.alpha(0.9).restart(); setTimeout(fit, 900); };
  if (opts.legend) {
    const lg = document.createElement('div');
    lg.className = 'glegend';
    lg.innerHTML = opts.legend;
    el.appendChild(lg);
  }
  return { highlight, fit, destroy: () => sim.stop() };
}

// ---------------------------------------------------------------------------- session columns

export interface StepCol { id: string; seq: number; label: string; total: number; parts: Slice[]; side: boolean; selected?: boolean }

export function stepColumns(el: HTMLElement, steps: StepCol[], onClick: (id: string) => void): void {
  whenSized(el, (w, _h, first) => {
    el.innerHTML = '';
    const h = 220;
    const m = { t: 10, r: 8, b: 22, l: 44 };
    const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${w} ${h}`).attr('height', h);
    const x = d3.scaleBand().domain(steps.map((s) => s.id)).range([m.l, w - m.r]).paddingInner(0.18);
    const y = d3.scaleLinear().domain([0, d3.max(steps, (s) => s.total) || 1]).nice().range([h - m.b, m.t]);
    svg.append('g').attr('class', 'axis').attr('transform', `translate(${m.l},0)`)
      .call(d3.axisLeft(y).ticks(4).tickFormat((v) => fmtKk(Number(v))).tickSize(-(w - m.l - m.r)))
      .call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('.tick line').attr('stroke-opacity', 0.5));
    const every = Math.ceil(steps.length / Math.max(1, Math.floor((w - m.l) / 34)));
    svg.append('g').attr('class', 'axis').attr('transform', `translate(0,${h - m.b})`)
      .call(d3.axisBottom(x).tickFormat((id) => { const i = steps.findIndex((s) => s.id === id); return i % every === 0 ? `#${steps[i].seq}` : ''; }).tickSize(0))
      .call((g) => g.select('.domain').remove());
    const col = svg.append('g').selectAll('g').data(steps).join('g').attr('class', 'cell').attr('transform', (s) => `translate(${x(s.id)},0)`)
      .style('opacity', (s) => (s.side ? 0.55 : 1));
    col.each(function (s) {
      let acc = 0;
      d3.select(this).selectAll('rect').data(s.parts.filter((p) => p.value > 0)).join('rect')
        .attr('width', x.bandwidth()).attr('fill', (p) => p.color).style('stroke', 'none')
        .attr('y', h - m.b).attr('height', 0)
        .transition().duration(first ? 450 : 0).delay((_p, i) => i * 10)
        .attr('y', (p) => { acc += p.value; return y(acc); })
        .attr('height', (p) => Math.max(0, y(0) - y(p.value)));
      if (s.selected) d3.select(this).append('rect').attr('x', -2).attr('width', x.bandwidth() + 4).attr('y', y(s.total) - 3).attr('height', y(0) - y(s.total) + 3).attr('fill', 'none').attr('stroke', 'var(--hl)').attr('stroke-width', 1.5).attr('rx', 3);
    });
    col.on('mouseenter', (ev: MouseEvent, s) => showTip(`<b>#${s.seq} ${esc(s.label)}</b><div class="row"><span>prompt tokens</span><span>${fmt(s.total)}</span></div>${s.parts.slice().sort((a, b) => b.value - a.value).slice(0, 6).map((p) => `<div class="row"><span><span class="k" style="background:${p.color}"></span>${esc(p.label)}</span><span>${fmt(p.value)}</span></div>`).join('')}`, ev))
      .on('mousemove', (ev: MouseEvent) => showTip(null, ev))
      .on('mouseleave', hideTip)
      .on('click', (_ev, s) => { hideTip(); onClick(s.id); });
  });
}
