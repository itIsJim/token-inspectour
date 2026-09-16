// Turn a captured request into an attributed anatomy: every system block, tool and
// message block becomes a "part"; text parts are split into spans that point back to
// the inventory source (CLAUDE.md, skill, command, agent, MCP, memory, harness…) that
// produced them. Token counts are exact when the counter is available, estimated otherwise.
import path from 'node:path';
import { estimateTokens, estimateSignatureTokens } from './tokens.js';
import type { Counter } from './tokens.js';
import { sanitizeMcp, KINDS } from './inventory.js';
import { sha } from './util.js';
import type {
  AdhocSource, Analysis, AnySource, Area, CaptureRecord, Classification, ContentBlock, Diff, DiffEntry, Inventory,
  MatchKind, Message, Part, RequestBody, SlimAnalysis, Source, SourceKind, Span, SystemBlock, ToolDef, ToolResultBlock, ToolUseBlock, Totals,
} from './types.js';

const MIN_MATCH = 40;

type AdhocFactory = (file: string, desc: string) => AdhocSource;

function systemBlocks(body: RequestBody): SystemBlock[] {
  const s = body.system;
  if (!s) return [];
  if (typeof s === 'string') return [{ type: 'text', text: s }];
  return s;
}

function systemText(body: RequestBody): string {
  return systemBlocks(body).map((b) => b.text || '').join('\n');
}

function messageBlocks(msg: Message): ContentBlock[] {
  if (typeof msg.content === 'string') return [{ type: 'text', text: msg.content }];
  return Array.isArray(msg.content) ? msg.content : [];
}

export function classifyRequest(body: RequestBody | null): Classification {
  if (!body) return { kind: 'unknown', label: 'unparseable' };
  const sys = systemText(body);
  const tools = Array.isArray(body.tools) ? body.tools.length : 0;
  if (/naming a coding session|session title/i.test(sys)) return { kind: 'side', label: 'session title' };
  if (/summariz(e|ing) (the|this) conversation|compact/i.test(sys) && tools === 0) return { kind: 'side', label: 'compaction' };
  if (/Extract any file paths|filepath extraction/i.test(sys)) return { kind: 'side', label: 'file-path extraction' };
  if (/quota|classif/i.test(sys) && tools === 0 && sys.length < 4000) return { kind: 'side', label: 'classifier' };
  if (tools > 0 || /interactive agent|Claude Code/i.test(sys)) return { kind: 'main', label: 'agent turn' };
  return { kind: 'side', label: 'side call' };
}

// Where was Claude Code running? The harness tells the model in an environment reminder;
// fall back to the deepest CLAUDE.md marked as project instructions.
export function detectProjectDir(body: RequestBody | null): string | null {
  if (!body) return null;
  const chunks = [systemText(body)];
  for (const m of (body.messages || []).slice(0, 3)) {
    for (const b of messageBlocks(m)) if (b.type === 'text') chunks.push((b as { text?: string }).text || '');
  }
  const all = chunks.join('\n');
  const m = /Primary working directory:\s*([^\n]+)/.exec(all);
  if (m) return m[1].trim().replace(/[\s.]+$/, '');
  let best: string | null = null;
  const re = /Contents of ([^\n]+?)\/(?:\.claude\/)?CLAUDE(?:\.local)?\.md \(project instructions/g;
  let mm: RegExpExecArray | null;
  while ((mm = re.exec(all))) if (!best || mm[1].length > best.length) best = mm[1];
  return best;
}

function blockText(block: ContentBlock | string | null | undefined): string {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  const b = block as Record<string, any>;
  switch (b.type) {
    case 'text':
      return b.text || '';
    case 'thinking':
      return b.thinking || '';
    case 'redacted_thinking':
      return '[redacted thinking]';
    case 'tool_use':
    case 'server_tool_use':
      return JSON.stringify({ name: b.name, input: b.input }, null, 1);
    case 'tool_result': {
      const c = b.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(blockText).join('\n');
      return '';
    }
    case 'image':
      return `[image ${(b.source && b.source.media_type) || ''}]`;
    case 'document':
      return '[document]';
    default:
      return JSON.stringify(b);
  }
}

function toolText(tool: ToolDef): string {
  return (tool.description || '') + '\n' + JSON.stringify(tool.input_schema || tool.parameters || {});
}

const kindLabel = (k: SourceKind): string => KINDS[k]?.label || k;

// ---------------------------------------------------------------------------
// Span attribution inside one text
// ---------------------------------------------------------------------------
interface Region {
  start: number;
  end: number;
  kind: SourceKind;
  label: string;
  sourceId?: string;
  match?: MatchKind;
}

class Spanner {
  spans: Span[] = [];
  defaultSourceId?: string;
  defaultMatch?: MatchKind;

  constructor(readonly text: string, readonly defaultKind: SourceKind, readonly defaultLabel: string) {}

  overlaps(s: number, e: number): boolean {
    return this.spans.some((x) => s < x.end && e > x.start);
  }

  add(start: number, end: number, kind: SourceKind, extra: Partial<Span> = {}): boolean {
    if (end <= start) return false;
    if (this.overlaps(start, end)) return false;
    this.spans.push({ start, end, kind, ...extra });
    return true;
  }

  // Fill in gaps with the default kind, or a region's kind where one applies.
  finalize(regions: Region[] = []): Span[] {
    const out: Span[] = [];
    const spans = this.spans.sort((a, b) => a.start - b.start);
    let pos = 0;
    const regionAt = (p: number): Region | null => regions.find((r) => p >= r.start && p < r.end) || null;
    const pushGap = (s: number, e: number): void => {
      let cur = s;
      while (cur < e) {
        const r = regionAt(cur);
        const nextStarts = regions.filter((x) => x.start > cur).map((x) => x.start);
        const next = r ? Math.min(e, r.end) : Math.min(e, ...nextStarts);
        out.push({
          start: cur, end: next,
          kind: r ? r.kind : this.defaultKind,
          label: r ? r.label : this.defaultLabel,
          sourceId: r ? r.sourceId : this.defaultSourceId,
          match: r ? r.match : this.defaultSourceId ? this.defaultMatch : undefined,
        });
        cur = next;
      }
    };
    for (const s of spans) {
      if (s.start > pos) pushGap(pos, s.start);
      out.push(s);
      pos = s.end;
    }
    if (pos < this.text.length) pushGap(pos, this.text.length);
    return out;
  }
}

function findAll(hay: string, needle: string, from = 0): number[] {
  const res: number[] = [];
  if (!needle) return res;
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    res.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return res;
}

function commonPrefixLen(a: string, b: string): number {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export interface AttributeOptions {
  defaultKind: SourceKind;
  defaultLabel: string;
  inventory: { sources: Source[] };
  adhoc: AdhocFactory;
  defaultSourceId?: string;
  defaultMatch?: MatchKind;
}

export function attributeText(text: string, { defaultKind, defaultLabel, inventory, adhoc, defaultSourceId, defaultMatch }: AttributeOptions): Span[] {
  const sp = new Spanner(text, defaultKind, defaultLabel);
  sp.defaultSourceId = defaultSourceId;
  sp.defaultMatch = defaultMatch;
  const regions: Region[] = [];
  const byPath = new Map(inventory.sources.map((s) => [s.path, s]));
  const byName = (kind: SourceKind, name: string): Source | undefined => inventory.sources.find((s) => s.kind === kind && s.name === name);

  // 1. <system-reminder> regions, "Contents of <path>" sections, hook output
  const remRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
  let m: RegExpExecArray | null;
  while ((m = remRe.exec(text))) {
    const rs = m.index;
    const re = m.index + m[0].length;
    const inner = m[1];
    const isHook = /\bhook\b/i.test(inner.slice(0, 400)) && !/Codebase and user instructions/.test(inner);
    regions.push({ start: rs, end: re, kind: isHook ? 'hook' : 'reminder', label: isHook ? 'hook output' : 'system reminder' });
    const secRe = /Contents of ([^\n]+?) \(([^)]*)\):\n/g;
    const secs: Array<{ at: number; file: string; desc: string }> = [];
    let sm: RegExpExecArray | null;
    while ((sm = secRe.exec(inner))) secs.push({ at: sm.index, file: sm[1], desc: sm[2] });
    const open = '<system-reminder>'.length;
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      const start = rs + open + s.at;
      const end = i + 1 < secs.length ? rs + open + secs[i + 1].at : re - '</system-reminder>'.length;
      const src: AnySource = byPath.get(s.file) || adhoc(s.file, s.desc);
      sp.add(start, end, src.kind, { sourceId: src.id, label: `${kindLabel(src.kind)}: ${path.basename(s.file)}`, match: 'contents-of', file: s.file, desc: s.desc });
    }
  }

  // 2. slash-command invocation markers
  const cmdRe = /<command-name>\/?([^<\n]+)<\/command-name>/g;
  while ((m = cmdRe.exec(text))) {
    const name = m[1].trim();
    const src = byName('command', name) || byName('skill', name);
    if (src) regions.push({ start: m.index, end: m.index + m[0].length, kind: src.kind, label: `${src.kind}: ${src.name}`, sourceId: src.id });
  }

  // 3. exact / prefix matches of source bodies
  for (const src of inventory.sources) {
    const candidates: string[] = [];
    if (src.body && src.body.trim().length >= MIN_MATCH) candidates.push(src.body.trim());
    if (src.content && src.content.trim().length >= MIN_MATCH && src.content.trim() !== (src.body || '').trim()) candidates.push(src.content.trim());
    for (const needle of candidates) {
      let hit = false;
      for (const at of findAll(text, needle)) {
        if (sp.add(at, at + needle.length, src.kind, { sourceId: src.id, label: `${kindLabel(src.kind)}: ${src.name}`, match: 'exact' })) hit = true;
      }
      if (hit) break;
      const head = needle.slice(0, Math.min(120, needle.length));
      for (const at of findAll(text, head)) {
        const len = commonPrefixLen(text.slice(at), needle);
        if (len >= Math.max(200, needle.length * 0.5)) {
          const pct = Math.round((100 * len) / needle.length);
          if (sp.add(at, at + len, src.kind, { sourceId: src.id, label: `${kindLabel(src.kind)}: ${src.name} (partial ${pct}%)`, match: 'partial', coverage: len / needle.length })) hit = true;
        }
      }
      if (hit) break;
    }
  }

  // 4. listings: skills, agents, MCP instructions
  const listBlock = (headerRe: RegExp, onLine: (name: string, s: number, e: number) => void): void => {
    const hm = headerRe.exec(text);
    if (!hm) return;
    let pos = hm.index + hm[0].length;
    const lineRe = /^- ([^:\n]+)(?::|\n)/gm;
    lineRe.lastIndex = pos;
    let lm: RegExpExecArray | null;
    while ((lm = lineRe.exec(text))) {
      const between = text.slice(pos, lm.index);
      if (/\n\n(?!- )/.test(between) && between.trim() && !/^- /.test(between.trim())) break;
      const nx = text.indexOf('\n- ', lm.index + 1);
      const bl = text.indexOf('\n\n', lm.index + 1);
      const tag = text.indexOf('\n<', lm.index + 1);
      const cands = [nx, bl, tag].filter((x) => x !== -1);
      const lineEnd = cands.length ? Math.min(...cands) + 1 : text.length;
      onLine(lm[1].trim(), lm.index, lineEnd);
      pos = lineEnd;
      lineRe.lastIndex = lineEnd;
      if (text.slice(lineEnd, lineEnd + 2) === '\n\n') break;
    }
  };
  listBlock(/The following skills are available[^\n]*\n\n?/, (name, s, e) => {
    const bare = name.split(' ')[0];
    const last = bare.split(':').pop() || bare;
    const src = byName('skill', bare) || byName('command', bare) || byName('skill', last) || byName('command', last);
    if (src) sp.add(s, e, src.kind, { sourceId: src.id, label: `${src.kind} listing: ${src.name}`, match: 'listing' });
    else sp.add(s, e, 'harness', { label: `built-in skill listing: ${bare}`, match: 'listing' });
  });
  listBlock(/Available agent types[^\n]*\n\n?/, (name, s, e) => {
    const src = byName('agent', name);
    if (src) sp.add(s, e, 'agent', { sourceId: src.id, label: `agent listing: ${src.name}`, match: 'listing' });
    else sp.add(s, e, 'harness', { label: `built-in agent listing: ${name}`, match: 'listing' });
  });
  const mcpHdr = /# MCP Server Instructions[^\n]*\n/.exec(text);
  if (mcpHdr) {
    const secRe = /^## ([^\n]+)\n/gm;
    secRe.lastIndex = mcpHdr.index;
    const secs: Array<{ at: number; name: string }> = [];
    let sm: RegExpExecArray | null;
    while ((sm = secRe.exec(text))) secs.push({ at: sm.index, name: sm[1].trim() });
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      let end = i + 1 < secs.length ? secs[i + 1].at : text.length;
      const nextH1 = text.indexOf('\n# ', s.at + 1);
      if (nextH1 !== -1 && nextH1 < end) end = nextH1 + 1;
      const src = inventory.sources.find((x) => x.kind === 'mcp' && x.servers && x.servers.some((v) => v.name === s.name || v.sanitized === sanitizeMcp(s.name)));
      if (src) sp.add(s.at, end, 'mcp', { sourceId: src.id, label: `MCP instructions: ${s.name}`, match: 'listing' });
      else sp.add(s.at, end, 'mcp-remote', { label: `MCP instructions: ${s.name}`, match: 'listing' });
    }
  }

  return sp.finalize(regions);
}

// ---------------------------------------------------------------------------
// Whole request
// ---------------------------------------------------------------------------
interface ToolCall {
  name: string;
  input: Record<string, unknown>;
}

export function buildParts(body: RequestBody, inventory: Inventory): { parts: Part[]; adhocSources: AdhocSource[] } {
  const parts: Part[] = [];
  const adhocSources: AdhocSource[] = [];
  const adhoc: AdhocFactory = (file, desc) => {
    let s = adhocSources.find((x) => x.path === file);
    if (s) return s;
    const kind: SourceKind = /project instructions/i.test(desc) ? 'claude-md' : /memory/i.test(desc) ? 'memory' : 'file';
    s = { id: 'x' + sha(file).slice(0, 11), kind, path: file, name: path.basename(file), scope: 'external', description: desc, size: 0, adhoc: true };
    adhocSources.push(s);
    return s;
  };
  const inv = { sources: inventory.sources };

  systemBlocks(body).forEach((b, i) => {
    const text = b.text || '';
    parts.push({
      id: `sys.${i}`, area: 'system', index: i, role: 'system', blockType: 'text', cache: !!b.cache_control,
      label: i === 0 && /billing-header/.test(text) ? 'billing header' : text.length < 200 ? 'system preamble' : 'harness system prompt',
      text, chars: text.length,
      spans: attributeText(text, { defaultKind: 'harness', defaultLabel: 'harness system prompt', inventory: inv, adhoc }),
    });
  });

  (body.tools || []).forEach((t, i) => {
    const text = toolText(t);
    let kind: SourceKind = 'harness-tool';
    let sourceId: string | undefined;
    let label = `tool: ${t.name}`;
    const mm = /^mcp__(.+?)__(.+)$/.exec(t.name || '');
    if (mm) {
      const server = mm[1];
      const src = inventory.sources.find((x) => x.kind === 'mcp' && x.servers && x.servers.some((v) => v.sanitized === server));
      kind = src ? 'mcp' : 'mcp-remote';
      sourceId = src ? src.id : undefined;
      label = `MCP ${server}: ${mm[2]}`;
    } else if (t.type && !t.description) {
      label = `server tool: ${t.type}`;
    }
    parts.push({
      id: `tool.${i}`, area: 'tools', index: i, role: 'tools', blockType: 'tool', name: t.name, cache: !!t.cache_control,
      label, text, chars: text.length, spans: [{ start: 0, end: text.length, kind, sourceId, label }], kind, sourceId,
    });
  });

  // tool_use id → call, so tool results can be attributed to the file / skill they came from
  const calls = new Map<string, ToolCall>();
  for (const msg of body.messages || []) {
    if (msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const b of msg.content) if (b.type === 'tool_use') calls.set((b as ToolUseBlock).id, { name: (b as ToolUseBlock).name, input: (b as ToolUseBlock).input || {} });
  }
  const byPath = new Map(inventory.sources.map((s) => [s.path, s]));
  const describeCall = (c: ToolCall | null): string => {
    if (!c) return '';
    const i = c.input;
    const arg = i.file_path || i.path || i.skill || i.command || i.pattern || i.url || i.description || i.prompt || '';
    return `${c.name}${arg ? ': ' + String(arg).slice(0, 80) : ''}`;
  };

  (body.messages || []).forEach((msg, mi) => {
    messageBlocks(msg).forEach((b, bi) => {
      const text = blockText(b);
      const bt = b.type || 'text';
      const tu = b as ToolUseBlock;
      let defaultKind: SourceKind = msg.role === 'assistant' ? 'model' : msg.role === 'system' ? 'harness' : bt === 'tool_result' ? 'tool-result' : 'user';
      let defaultLabel = msg.role === 'assistant'
        ? bt === 'thinking' ? 'model thinking' : bt === 'tool_use' ? `tool call: ${describeCall({ name: tu.name, input: tu.input || {} })}` : 'model reply'
        : msg.role === 'system' ? 'mid-conversation system message' : bt === 'tool_result' ? 'tool result' : 'user message';
      let defaultSourceId: string | undefined;
      let defaultMatch: MatchKind | undefined;
      let call: ToolCall | null = null;
      if (bt === 'tool_result') {
        const tr = b as ToolResultBlock;
        call = calls.get(tr.tool_use_id) || null;
        defaultLabel = call ? `tool result: ${describeCall(call)}` : 'tool result';
        if (call && /^(Read|NotebookRead)$/.test(call.name) && call.input.file_path) {
          const file = String(call.input.file_path);
          const exact = byPath.get(file);
          const src: AnySource = exact || inventory.sources.find((x) => x.dir && file.startsWith(x.dir + '/')) || adhoc(file, 'file read via Read tool');
          defaultKind = src.kind === 'skill' && !exact ? 'file' : src.kind;
          defaultSourceId = src.id;
          defaultMatch = 'tool-read';
          defaultLabel = `${kindLabel(defaultKind)} read: ${path.basename(file)}`;
        } else if (call && call.name === 'Skill' && call.input.skill) {
          const name = String(call.input.skill).replace(/^\//, '');
          const last = name.split(':').pop();
          const src = inventory.sources.find((x) => (x.kind === 'skill' || x.kind === 'command') && (x.name === name || x.name === last));
          if (src) {
            defaultKind = src.kind;
            defaultSourceId = src.id;
            defaultMatch = 'skill-invoke';
            defaultLabel = `${src.kind} invoked: ${src.name}`;
          }
        }
      }
      const spans: Span[] = bt === 'text' || bt === 'tool_result' || msg.role === 'system'
        ? attributeText(text, { defaultKind, defaultLabel, inventory: inv, adhoc, defaultSourceId, defaultMatch })
        : [{ start: 0, end: text.length, kind: defaultKind, label: defaultLabel }];
      parts.push({
        id: `msg.${mi}.${bi}`, area: 'messages', index: mi, sub: bi, role: msg.role, blockType: bt, cache: !!(b as { cache_control?: unknown }).cache_control,
        name: tu.name || (call ? call.name : undefined),
        toolUseId: (b as ToolResultBlock).tool_use_id || tu.id,
        isError: (b as ToolResultBlock).is_error || false,
        label: bt === 'thinking' && !text && (b as { signature?: string }).signature ? 'model thinking (encrypted signature only)' : defaultLabel,
        text, chars: text.length, spans,
        signatureChars: bt === 'thinking' ? ((b as { signature?: string }).signature || '').length || undefined : undefined,
        raw: bt === 'text' || bt === 'thinking' ? undefined : b,
      });
    });
  });

  return { parts, adhocSources };
}

export interface CountOptions {
  exact?: boolean;
  out?: { toolsTotal?: number | null; systemTotal?: number | null; toolFraming?: number | null };
}

// Assign token counts to parts and spans. Uses exact counts where available.
export async function countParts(parts: Part[], body: RequestBody, counter: Counter | null, opts: CountOptions = {}): Promise<number> {
  const out = (opts.out = opts.out || {});
  const model = body.model;
  const exactOk = !!counter && counter.ready && opts.exact !== false;
  let counted = 0;
  const jobs: Promise<unknown>[] = [];

  const sysParts = parts.filter((p) => p.area === 'system');
  const toolParts = parts.filter((p) => p.area === 'tools');
  const msgParts = parts.filter((p) => p.area === 'messages');

  const setTokens = (p: Part, n: number | null): void => {
    if (n != null) {
      p.tokens = n;
      p.exact = true;
      counted++;
    } else {
      p.tokens = estimateTokens(p.text) + (p.signatureChars ? estimateSignatureTokens(p.signatureChars) : 0);
      p.exact = false;
    }
  };

  if (exactOk && counter) {
    const sys = systemBlocks(body);
    sysParts.forEach((p, i) => jobs.push(counter.countSystemBlocks(model, [sys[i]]).then((n) => setTokens(p, n))));
    (body.tools || []).forEach((t, i) => jobs.push(counter.countTool(model, t).then((n) => setTokens(toolParts[i], n))));
    for (const p of msgParts) {
      const msg = body.messages![p.index];
      const block = messageBlocks(msg)[p.sub!];
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      if (block.type === 'thinking' || block.type === 'redacted_thinking') {
        jobs.push(counter.countThinkingBlock(model, block, { thinking: body.thinking, context_management: body.context_management }).then((n) => setTokens(p, n)));
        continue;
      }
      const structural = msg.role === 'system' || ['tool_result', 'tool_use', 'image', 'document'].includes(block.type);
      jobs.push(structural
        ? counter.countText(model, p.text).then((n) => setTokens(p, n))
        : counter.countMessageBlock(model, role, block).then((n) => setTokens(p, n)));
    }
    if (body.tools && body.tools.length) {
      jobs.push(counter.countTools(model, body.tools).then((n) => { out.toolsTotal = n; }));
      jobs.push(counter.toolFraming(model).then((n) => { out.toolFraming = n; }));
    }
    if (sys.length) jobs.push(counter.countSystemBlocks(model, sys).then((n) => { out.systemTotal = n; }));
    // Exact counts for large attributed spans, so per-source numbers are real
    for (const p of parts) {
      if (p.area !== 'tools' && p.spans.length > 1) {
        for (const s of p.spans) {
          if (s.end - s.start >= 200 && s.sourceId) {
            jobs.push(counter.countText(model, p.text.slice(s.start, s.end)).then((n) => { if (n != null) { s.tokens = n; s.exact = true; } }));
          }
        }
      }
    }
    await Promise.all(jobs);
  } else {
    for (const p of parts) setTokens(p, null);
  }

  // Tool-use framing: the API-side text that wraps tool definitions (counted once per request).
  if (body.tools && body.tools.length) {
    const sumTools = toolParts.reduce((a, p) => a + (p.tokens || 0), 0);
    const exact = out.toolsTotal != null;
    const overhead = exact ? Math.max(0, out.toolsTotal! - sumTools) : 400;
    parts.push({
      id: 'tools.framing', area: 'tools', index: -1, role: 'tools', blockType: 'framing', name: '(tool-use framing)',
      label: 'tool-use framing (API-side wrapper around the tool list, plus rounding residual)', text: '', chars: 0, kind: 'harness',
      spans: [{ start: 0, end: 0, kind: 'harness', label: 'tool-use framing', tokens: overhead, exact }], tokens: overhead, exact,
    });
    if (exact) counted++;
  }

  // distribute part tokens to spans proportionally (unless the span was counted)
  for (const p of parts) {
    const total = p.tokens || 0;
    const chars = Math.max(1, p.chars);
    const exactSpans = p.spans.filter((s) => s.exact);
    const exactTok = exactSpans.reduce((a, s) => a + (s.tokens || 0), 0);
    const exactChars = exactSpans.reduce((a, s) => a + (s.end - s.start), 0);
    const restTok = Math.max(0, total - exactTok);
    const restChars = Math.max(1, chars - exactChars);
    for (const s of p.spans) {
      if (s.exact) continue;
      s.tokens = p.spans.length === 1 ? total : Math.round((restTok * (s.end - s.start)) / restChars);
      s.exact = p.spans.length === 1 ? !!p.exact : false;
    }
  }
  return counted;
}

export function totals(parts: Part[], inventory: Inventory, adhocSources: AdhocSource[]): Totals {
  const byKind: Totals['byKind'] = {};
  const bySourceSets = new Map<string, { chars: number; tokens: number; spans: number; parts: Set<string>; matches: Record<string, number> }>();
  let chars = 0;
  let tokens = 0;
  for (const p of parts) {
    chars += p.chars;
    tokens += p.tokens || 0;
    for (const s of p.spans) {
      const k = byKind[s.kind] || (byKind[s.kind] = { chars: 0, tokens: 0, spans: 0, exactTokens: 0 });
      k.chars += s.end - s.start;
      k.tokens += s.tokens || 0;
      k.spans++;
      if (s.exact) k.exactTokens += s.tokens || 0;
      if (s.sourceId) {
        let b = bySourceSets.get(s.sourceId);
        if (!b) bySourceSets.set(s.sourceId, (b = { chars: 0, tokens: 0, spans: 0, parts: new Set(), matches: {} }));
        b.chars += s.end - s.start;
        b.tokens += s.tokens || 0;
        b.spans++;
        b.parts.add(p.id);
        const mk = s.match || 'x';
        b.matches[mk] = (b.matches[mk] || 0) + 1;
      }
    }
  }
  const byArea: Totals['byArea'] = {};
  for (const p of parts) {
    const a = byArea[p.area] || (byArea[p.area] = { chars: 0, tokens: 0, parts: 0 });
    a.chars += p.chars;
    a.tokens += p.tokens || 0;
    a.parts++;
  }
  const bySource: Totals['bySource'] = {};
  for (const [id, v] of bySourceSets) bySource[id] = { chars: v.chars, tokens: v.tokens, spans: v.spans, parts: [...v.parts], matches: v.matches };
  const sourceUsage: Totals['sourceUsage'] = {};
  for (const s of [...inventory.sources, ...adhocSources] as AnySource[]) {
    const b = bySource[s.id];
    sourceUsage[s.id] = {
      used: !!b, tokens: b ? b.tokens : 0, chars: b ? b.chars : 0, spans: b ? b.spans : 0, parts: b ? b.parts : [], matches: b ? b.matches : {},
      coverage: b && s.size ? Math.min(1, b.chars / s.size) : 0,
    };
  }
  return { chars, tokens, byKind, byArea, bySource, sourceUsage };
}

// Diff two analyses (same session, consecutive main requests).
export function diffParts(prevParts: Part[], parts: Part[]): Diff {
  const key = (p: Part): string => (p.area === 'tools' ? `tool:${p.name}` : p.area === 'system' ? `sys:${p.index}` : `msg:${p.index}.${p.sub}`);
  const prev = new Map(prevParts.map((p) => [key(p), p]));
  const cur = new Map(parts.map((p) => [key(p), p]));
  const added: DiffEntry[] = [];
  const removed: DiffEntry[] = [];
  const changed: DiffEntry[] = [];
  let same = 0;
  for (const [k, p] of cur) {
    const q = prev.get(k);
    if (!q) added.push({ id: p.id, key: k, label: p.label, tokens: p.tokens, chars: p.chars, role: p.role, blockType: p.blockType });
    else if (sha(q.text) !== sha(p.text)) changed.push({ id: p.id, prevId: q.id, key: k, label: p.label, tokens: p.tokens, prevTokens: q.tokens, chars: p.chars, prevChars: q.chars });
    else same++;
  }
  for (const [k, q] of prev) if (!cur.has(k)) removed.push({ id: q.id, key: k, label: q.label, tokens: q.tokens, chars: q.chars });
  const addedTokens = added.reduce((a, x) => a + (x.tokens || 0), 0);
  const removedTokens = removed.reduce((a, x) => a + (x.tokens || 0), 0);
  const changedDelta = changed.reduce((a, x) => a + ((x.tokens || 0) - (x.prevTokens || 0)), 0);
  return { added, removed, changed, sameCount: same, addedTokens, removedTokens, changedDelta };
}

export type AnalyzableRecord = Pick<CaptureRecord, 'body' | 'response'> & { id?: string; analysis?: Analysis | null };

export async function analyzeRequest(rec: AnalyzableRecord, inventory: Inventory, counter: Counter | null, prevRec: AnalyzableRecord | null, opts: { exact?: boolean } = {}): Promise<Analysis | null> {
  const body = rec.body;
  if (!body) return null;
  const cls = classifyRequest(body);
  const { parts, adhocSources } = buildParts(body, inventory);
  if (cls.kind === 'main') {
    const agentSpan = parts.filter((p) => p.area === 'system').flatMap((p) => p.spans).find((s) => s.kind === 'agent' && s.sourceId);
    const sys = systemText(body);
    if (agentSpan) {
      const src = inventory.sources.find((x) => x.id === agentSpan.sourceId);
      cls.label = `subagent: ${src ? src.name : 'custom'}`;
      cls.agent = src ? src.name : null;
    } else if (!/interactive agent|Claude Code/i.test(sys)) cls.label = 'subagent (built-in)';
  }
  const out: CountOptions['out'] = {};
  const counted = await countParts(parts, body, counter, { exact: opts.exact, out });
  const t = totals(parts, inventory, adhocSources);
  const u = (rec.response && rec.response.usage) || null;
  const promptTotal = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
  const framing = parts.find((p) => p.id === 'tools.framing');
  return {
    kind: cls.kind,
    label: cls.label,
    agent: cls.agent || null,
    parts,
    adhocSources,
    totals: t,
    counted,
    partCount: parts.length,
    exactTotal: counted === parts.length,
    toolsTotal: out.toolsTotal ?? null,
    systemTotal: out.systemTotal ?? null,
    toolsOverhead: out.toolsTotal != null ? framing?.tokens ?? null : null,
    toolFraming: out.toolFraming ?? null,
    promptTotalFromUsage: promptTotal,
    cache: u ? { read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, uncached: u.input_tokens || 0 } : null,
    diff: prevRec && prevRec.analysis ? diffParts(prevRec.analysis.parts, parts) : null,
    prevId: prevRec && prevRec.id ? prevRec.id : null,
    inventoryScannedAt: inventory.scannedAt,
  };
}

// Strip heavy text for list/summary transport; keep spans.
export function slimAnalysis(a: Analysis | null | undefined): SlimAnalysis | null {
  if (!a) return null;
  return { ...a, parts: a.parts.map(({ text: _t, raw: _r, ...p }) => p) };
}
