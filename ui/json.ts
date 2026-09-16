// Collapsible, syntax-highlighted JSON viewer. Children are built on first expand and long
// arrays and strings are paged, so a multi-megabyte request body stays responsive.
// Compiled to dist/ui/json.js and served under /<agent>/json.js.
import { esc } from './common.js';

export interface JsonViewOptions {
  /** Levels expanded on first render (root = 0). */
  expand?: number;
  /** JSON path of the root value, shown on hover and passed to onPath. */
  path?: string;
  /** Paths (as produced by this viewer) to open and highlight, e.g. "messages[3].content[1]". */
  reveal?: string;
  maxString?: number;
}

const PAGE = 100;

const childPath = (base: string, key: string | number): string =>
  typeof key === 'number' ? `${base}[${key}]` : /^[A-Za-z_$][\w$]*$/.test(key) ? (base ? `${base}.${key}` : key) : `${base}[${JSON.stringify(key)}]`;

function scalar(v: unknown, maxString: number): string {
  if (v === null) return '<span class="null">null</span>';
  switch (typeof v) {
    case 'string': {
      const body = JSON.stringify(v);
      if (body.length <= maxString) return `<span class="str">${esc(body)}</span>`;
      return `<span class="str" data-full="1">${esc(body.slice(0, maxString))}</span><span class="more" data-more="1">… ${(body.length - maxString).toLocaleString()} more chars</span>`;
    }
    case 'number': return `<span class="num">${v}</span>`;
    case 'boolean': return `<span class="bool">${v}</span>`;
    default: return `<span class="null">${esc(String(v))}</span>`;
  }
}

export function jsonView(value: unknown, opts: JsonViewOptions = {}): HTMLElement {
  const root = document.createElement('div');
  root.className = 'jt';
  const maxString = opts.maxString ?? 600;
  const expand = opts.expand ?? 1;
  const reveal = opts.reveal || '';
  root.appendChild(node(value, null, opts.path || '', 0, true));

  function node(v: unknown, key: string | number | null, path: string, depth: number, last: boolean): HTMLElement {
    const row = document.createElement('div');
    row.className = 'row';
    row.dataset.path = path;
    const keyHtml = key == null ? '' : typeof key === 'number' ? '' : `<span class="key">${esc(JSON.stringify(key))}</span><span class="p">: </span>`;
    const comma = last ? '' : '<span class="p">,</span>';
    if (v === null || typeof v !== 'object') {
      row.innerHTML = keyHtml + scalar(v, maxString) + comma;
      const more = row.querySelector<HTMLElement>('[data-more]');
      if (more) more.onclick = () => { row.innerHTML = keyHtml + `<span class="str">${esc(JSON.stringify(v))}</span>` + comma; };
      return row;
    }
    const isArr = Array.isArray(v);
    const entries: Array<[string | number, unknown]> = isArr ? (v as unknown[]).map((x, i) => [i, x]) : Object.entries(v as Record<string, unknown>);
    const [o, c] = isArr ? ['[', ']'] : ['{', '}'];
    if (!entries.length) {
      row.innerHTML = `${keyHtml}<span class="p">${o}${c}</span>${comma}`;
      return row;
    }
    const count = isArr ? `${entries.length} item${entries.length > 1 ? 's' : ''}` : `${entries.length} key${entries.length > 1 ? 's' : ''}`;
    // collapsed objects preview the fields that identify them (role / type / name)
    const o2 = v as Record<string, unknown>;
    const hint = isArr ? '' : ['role', 'type', 'name'].filter((k) => typeof o2[k] === 'string').map((k) => ` <span class="str">${esc(String(o2[k]).slice(0, 40))}</span>`).join('');
    row.innerHTML = `<span class="tg">▶</span>${keyHtml}<span class="p">${o}</span><span class="cnt">${count}${hint}</span><span class="path-tip">${esc(path || '$')}</span><span class="close"><span class="p">${c}</span>${comma}</span>`;
    const tg = row.querySelector<HTMLElement>('.tg')!;
    const cnt = row.querySelector<HTMLElement>('.cnt')!;
    const close = row.querySelector<HTMLElement>('.close')!;
    let kids: HTMLElement | null = null;
    let shown = 0;
    const fill = (): void => {
      const end = Math.min(entries.length, shown + PAGE);
      const frag = document.createDocumentFragment();
      for (let i = shown; i < end; i++) {
        const [k, x] = entries[i];
        frag.appendChild(node(x, k, childPath(path, k), depth + 1, i === entries.length - 1));
      }
      kids!.querySelector('.pager')?.remove();
      kids!.appendChild(frag);
      shown = end;
      if (shown < entries.length) {
        const pg = document.createElement('div');
        pg.className = 'row pager';
        pg.innerHTML = `<span class="more">show ${Math.min(PAGE, entries.length - shown)} more of ${(entries.length - shown).toLocaleString()}</span>`;
        pg.onclick = fill;
        kids!.appendChild(pg);
      }
    };
    const setOpen = (open: boolean): void => {
      if (open && !kids) {
        kids = document.createElement('div');
        kids.className = 'kids';
        row.insertBefore(kids, close);
        fill();
      }
      if (kids) kids.hidden = !open;
      tg.textContent = open ? '▼' : '▶';
      cnt.style.display = open ? 'none' : '';
      close.style.display = open ? 'block' : '';
    };
    const toggle = (): void => setOpen(!kids || kids.hidden);
    tg.onclick = toggle;
    cnt.onclick = toggle;
    const onRevealPath = reveal && (reveal === path || reveal.startsWith(path + '[') || reveal.startsWith(path + '.') || path === '');
    if (depth < expand || onRevealPath) {
      setOpen(true);
      // page far enough to include the revealed index
      const m = onRevealPath && isArr ? /^\[(\d+)\]/.exec(reveal.slice(path.length)) : null;
      if (m) while (shown <= Number(m[1]) && shown < entries.length) fill();
    }
    if (reveal && reveal === path && path) row.classList.add('hot');
    return row;
  }

  if (reveal) requestAnimationFrame(() => root.querySelector('.row.hot')?.scrollIntoView({ block: 'start' }));
  return root;
}

/** Walk a JSON path produced by childPath ("messages[3].content[1]") into a value. */
export function atPath(value: unknown, path: string): unknown {
  const re = /(?:^|\.)([A-Za-z_$][\w$]*)|\[(\d+)\]|\[("(?:[^"\\]|\\.)*")\]/g;
  let cur: unknown = value;
  let m: RegExpExecArray | null;
  while ((m = re.exec(path))) {
    if (cur == null || typeof cur !== 'object') return undefined;
    const key = m[1] ?? (m[2] != null ? Number(m[2]) : JSON.parse(m[3]));
    cur = (cur as Record<string | number, unknown>)[key];
  }
  return cur;
}

/** Expand / collapse every loaded node of a viewer to a given depth. */
export function expandAll(root: HTMLElement, depth: number): void {
  const walk = (el: HTMLElement, d: number): void => {
    for (const row of Array.from(el.children) as HTMLElement[]) {
      const tg = row.querySelector<HTMLElement>(':scope > .tg');
      if (!tg) continue;
      const kids = row.querySelector<HTMLElement>(':scope > .kids');
      const open = !!kids && !kids.hidden;
      if (d < depth && !open) tg.click();
      if (d >= depth && open) tg.click();
      const k = row.querySelector<HTMLElement>(':scope > .kids');
      if (k && !k.hidden) walk(k, d + 1);
    }
  };
  walk(root, 0);
}
