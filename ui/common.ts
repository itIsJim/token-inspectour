// Helpers shared by the inspector page (app.ts) and the standalone graph page (graph.ts).
// Compiled to dist/ui/common.js and served under /<agent>/common.js.
import type { PublicSource } from '../src/types.js';

export type Kinds = Record<string, { label: string; color: string }>;

const meta = (n: string): string => (document.querySelector(`meta[name="${n}"]`) as HTMLMetaElement | null)?.content || '';
export const BASE = meta('inspectour-base');
export const NAME = meta('inspectour-name');

export const $ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document): T => el.querySelector(s) as T;
export const $$ = <T extends Element = HTMLElement>(s: string, el: ParentNode = document): T[] => Array.from(el.querySelectorAll(s)) as T[];
export const esc = (s: unknown): string => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string);
export const fmt = (n: number | null | undefined): string => (n == null ? '–' : n.toLocaleString());
export const fmtKk = (n: number): string => (n >= 10000 ? `${(n / 1000).toFixed(1)}k` : n >= 1000 ? `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}k` : String(n));
export const pct = (a: number, b: number | undefined): string => (b ? ((100 * a) / b).toFixed(1) + '%' : '–');
export const short = (p: string | null | undefined): string => (p || '').replace(/^\/Users\/[^/]+/, '~');
export const basename = (p: string | null | undefined): string => (p || '').split('/').pop() || '';

export const cssVar = (n: string): string => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
export const isDark = (): boolean => matchMedia('(prefers-color-scheme: dark)').matches;

export async function api<T>(p: string, opt?: RequestInit): Promise<T> {
  const r = await fetch(BASE + p, opt);
  if (!r.ok) throw new Error(p + ' ' + r.status);
  return r.json() as Promise<T>;
}

// The kind palette comes from /api/state; both pages set it once and read colours from here.
export const KINDS: { kinds: Kinds } = { kinds: {} };
export const kindColor = (k: string): string => KINDS.kinds[k]?.color || '#94a3b8';
export const kindLabel = (k: string): string => KINDS.kinds[k]?.label || k;

// Floating tooltip (#tip). Pass html=null to only move it.
export function showTip(html: string | null, ev: MouseEvent): void {
  const tip = document.getElementById('tip');
  if (!tip) return;
  if (html != null) {
    tip.innerHTML = html;
    tip.style.display = 'block';
  }
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.max(8, Math.min(window.innerWidth - r.width - 12, ev.clientX + 14)) + 'px';
  tip.style.top = (ev.clientY + 16 + r.height > window.innerHeight ? ev.clientY - r.height - 12 : ev.clientY + 16) + 'px';
}
export function hideTip(): void {
  const tip = document.getElementById('tip');
  if (tip) tip.style.display = 'none';
}

// Source viewer in the right-hand panel. `matchedText`, when given, is highlighted and scrolled to;
// `back`, when given, adds a button that returns to whatever the panel showed before.
export async function renderSourcePanel(id: string, fallback: PublicSource | undefined, matchedText?: string, back?: () => void): Promise<void> {
  const side = $('#side');
  $('#main').classList.add('with-side');
  side.innerHTML = '<div class="hd"><span class="t">loading…</span></div>';
  let s: PublicSource & { content?: string };
  try {
    s = await api<PublicSource & { content: string }>(`/api/sources/${id}`);
  } catch {
    s = fallback ? ({ ...fallback, content: '(file outside the scanned inventory — content not loaded)' } as PublicSource & { content: string }) : ({ id, name: id, content: '' } as unknown as PublicSource & { content: string });
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
  side.innerHTML = `<div class="hd">${back ? '<button class="ghost icon" data-act="back" title="back">←</button>' : ''}<span class="k" style="background:${kindColor(s.kind)}"></span><span class="t" title="${esc(s.path)}">${esc(s.name)}</span><span class="pill">${esc(kindLabel(s.kind))}</span><span class="pill">${esc(s.scope || '')}</span><button class="ghost icon" data-act="close">✕</button></div>
    <div class="meta">${esc(s.path || '')} · ${fmt(s.size)} chars${s.mtime ? ` · modified ${new Date(s.mtime).toLocaleString()}` : ''}</div>${fm}<div class="txt">${content}</div>`;
  $<HTMLButtonElement>('[data-act=close]', side).onclick = () => $('#main').classList.remove('with-side');
  if (back) $<HTMLButtonElement>('[data-act=back]', side).onclick = back;
  if (matchedText) $('mark', side)?.scrollIntoView({ block: 'center' });
}
