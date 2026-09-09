// Turn a captured request into an attributed anatomy: every system block, tool and
// message block becomes a "part"; text parts are split into spans that point back to
// the inventory source (CLAUDE.md, skill, command, agent, MCP, memory, harness…) that
// produced them. Token counts are exact when the counter is available, estimated otherwise.
import path from 'node:path';
import { estimateTokens } from './tokens.js';
import { sanitizeMcp, KINDS } from './inventory.js';
import { sha } from './util.js';

const MIN_MATCH = 40;

export function classifyRequest(body) {
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

function systemText(body) {
  const s = body.system;
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.map((b) => b.text || '').join('\n');
}

function blockText(block) {
  if (block == null) return '';
  if (typeof block === 'string') return block;
  switch (block.type) {
    case 'text':
      return block.text || '';
    case 'thinking':
      return block.thinking || '';
    case 'redacted_thinking':
      return '[redacted thinking]';
    case 'tool_use':
    case 'server_tool_use':
      return JSON.stringify({ name: block.name, input: block.input }, null, 1);
    case 'tool_result': {
      const c = block.content;
      if (typeof c === 'string') return c;
      if (Array.isArray(c)) return c.map(blockText).join('\n');
      return '';
    }
    case 'image':
      return `[image ${(block.source && block.source.media_type) || ''}]`;
    case 'document':
      return '[document]';
    default:
      return JSON.stringify(block);
  }
}

function toolText(tool) {
  return (tool.description || '') + '\n' + JSON.stringify(tool.input_schema || tool.parameters || {});
}

// ---------------------------------------------------------------------------
// Span attribution inside one text
// ---------------------------------------------------------------------------
class Spanner {
  constructor(text, defaultKind, defaultLabel) {
    this.text = text;
    this.spans = []; // {start,end,kind,sourceId,label,match}
    this.defaultKind = defaultKind;
    this.defaultLabel = defaultLabel;
  }

  overlaps(s, e) {
    return this.spans.some((x) => s < x.end && e > x.start);
  }

  add(start, end, kind, extra = {}) {
    if (end <= start) return false;
    if (this.overlaps(start, end)) return false;
    this.spans.push({ start, end, kind, ...extra });
    return true;
  }

  // Fill in gaps with the given base kind, optionally per region.
  finalize(regions = []) {
    const out = [];
    const spans = this.spans.sort((a, b) => a.start - b.start);
    let pos = 0;
    const kindAt = (p) => {
      for (const r of regions) if (p >= r.start && p < r.end) return r;
      return null;
    };
    const pushGap = (s, e) => {
      let cur = s;
      while (cur < e) {
        const r = kindAt(cur);
        const next = r ? Math.min(e, r.end) : Math.min(e, ...regions.filter((x) => x.start > cur).map((x) => x.start));
        out.push({ start: cur, end: next, kind: r ? r.kind : this.defaultKind, label: r ? r.label : this.defaultLabel, sourceId: r ? r.sourceId : undefined });
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

function findAll(hay, needle, from = 0) {
  const res = [];
  if (!needle) return res;
  let i = hay.indexOf(needle, from);
  while (i !== -1) {
    res.push(i);
    i = hay.indexOf(needle, i + needle.length);
  }
  return res;
}

function commonPrefixLen(a, b) {
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a.charCodeAt(i) === b.charCodeAt(i)) i++;
  return i;
}

export function attributeText(text, { defaultKind, defaultLabel, inventory, adhoc }) {
  const sp = new Spanner(text, defaultKind, defaultLabel);
  const regions = [];
  const byPath = new Map(inventory.sources.map((s) => [s.path, s]));
  const byName = (kind, name) => inventory.sources.find((s) => s.kind === kind && s.name === name);

  // 1. <system-reminder> regions, "Contents of <path>" sections, hook output
  const remRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
  let m;
  while ((m = remRe.exec(text))) {
    const rs = m.index;
    const re = m.index + m[0].length;
    const inner = m[1];
    const isHook = /\bhook\b/i.test(inner.slice(0, 400)) && !/Codebase and user instructions/.test(inner);
    regions.push({ start: rs, end: re, kind: isHook ? 'hook' : 'reminder', label: isHook ? 'hook output' : 'system reminder' });
    const secRe = /Contents of ([^\n]+?) \(([^)]*)\):\n/g;
    const secs = [];
    let sm;
    while ((sm = secRe.exec(inner))) secs.push({ at: sm.index, len: sm[0].length, file: sm[1], desc: sm[2] });
    for (let i = 0; i < secs.length; i++) {
      const s = secs[i];
      const start = rs + '<system-reminder>'.length + s.at;
      const end = i + 1 < secs.length ? rs + '<system-reminder>'.length + secs[i + 1].at : re - '</system-reminder>'.length;
      let src = byPath.get(s.file);
      if (!src) src = adhoc(s.file, s.desc);
      sp.add(start, end, src.kind, { sourceId: src.id, label: `${KINDS[src.kind]?.label || src.kind}: ${path.basename(s.file)}`, match: 'contents-of', file: s.file, desc: s.desc });
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
    const candidates = [];
    if (src.body && src.body.trim().length >= MIN_MATCH) candidates.push(src.body.trim());
    if (src.content && src.content.trim().length >= MIN_MATCH && src.content.trim() !== (src.body || '').trim()) candidates.push(src.content.trim());
    for (const needle of candidates) {
      let hit = false;
      for (const at of findAll(text, needle)) {
        if (sp.add(at, at + needle.length, src.kind, { sourceId: src.id, label: `${KINDS[src.kind]?.label || src.kind}: ${src.name}`, match: 'exact' })) hit = true;
      }
      if (hit) break;
      // partial: locate by prefix, extend by common prefix
      const head = needle.slice(0, Math.min(120, needle.length));
      for (const at of findAll(text, head)) {
        const len = commonPrefixLen(text.slice(at), needle);
        if (len >= Math.max(200, needle.length * 0.5)) {
          if (sp.add(at, at + len, src.kind, { sourceId: src.id, label: `${KINDS[src.kind]?.label || src.kind}: ${src.name} (partial ${Math.round((100 * len) / needle.length)}%)`, match: 'partial', coverage: len / needle.length })) hit = true;
        }
      }
      if (hit) break;
    }
  }

  // 4. listings: skills, agents, MCP instructions
  const listBlock = (headerRe, onLine) => {
    const hm = headerRe.exec(text);
    if (!hm) return;
    let pos = hm.index + hm[0].length;
    const lineRe = /^- ([^:\n]+)(?::|\n)/gm;
    lineRe.lastIndex = pos;
    let lm;
    while ((lm = lineRe.exec(text))) {
      // stop at the first blank-line-separated non-list paragraph
      const between = text.slice(pos, lm.index);
      if (/\n\n(?!- )/.test(between) && between.trim() && !/^- /.test(between.trim())) break;
      const lineEnd = (() => {
        // a list item continues until the next "\n- " or blank line
        const nx = text.indexOf('\n- ', lm.index + 1);
        const bl = text.indexOf('\n\n', lm.index + 1);
        const tag = text.indexOf('\n<', lm.index + 1);
        const cands = [nx, bl, tag].filter((x) => x !== -1);
        return cands.length ? Math.min(...cands) + 1 : text.length;
      })();
      onLine(lm[1].trim(), lm.index, lineEnd);
      pos = lineEnd;
      lineRe.lastIndex = lineEnd;
      if (text.slice(lineEnd, lineEnd + 2) === '\n' + '\n') break;
    }
  };
  listBlock(/The following skills are available[^\n]*\n\n?/, (name, s, e) => {
    const bare = name.split(' ')[0];
    const src = byName('skill', bare) || byName('command', bare) || byName('skill', bare.split(':').pop()) || byName('command', bare.split(':').pop());
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
    const secs = [];
    let sm;
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
export function buildParts(body, inventory) {
  const parts = [];
  const adhocSources = [];
  const adhoc = (file, desc) => {
    let s = adhocSources.find((x) => x.path === file);
    if (s) return s;
    const kind = /project instructions|instructions/i.test(desc) ? 'claude-md' : /memory/i.test(desc) ? 'memory' : 'file';
    s = { id: 'x' + sha(file).slice(0, 11), kind, path: file, name: path.basename(file), scope: 'external', description: desc, size: 0, adhoc: true };
    adhocSources.push(s);
    return s;
  };
  const inv = { sources: inventory.sources };

  const sys = Array.isArray(body.system) ? body.system : body.system ? [{ type: 'text', text: body.system }] : [];
  sys.forEach((b, i) => {
    const text = b.text || '';
    parts.push({
      id: `sys.${i}`, area: 'system', index: i, role: 'system', blockType: 'text', cache: !!b.cache_control,
      label: i === 0 && /billing-header/.test(text) ? 'billing header' : text.length < 200 ? 'system preamble' : 'harness system prompt',
      text, chars: text.length, spans: attributeText(text, { defaultKind: 'harness', defaultLabel: 'harness system prompt', inventory: inv, adhoc }),
    });
  });

  (body.tools || []).forEach((t, i) => {
    const text = toolText(t);
    let kind = 'harness-tool';
    let sourceId;
    let label = `tool: ${t.name}`;
    const mm = /^mcp__(.+?)__(.+)$/.exec(t.name || '');
    if (mm) {
      const server = mm[1];
      const src = inventory.sources.find((x) => x.kind === 'mcp' && x.servers && x.servers.some((v) => v.sanitized === server));
      if (src) {
        kind = 'mcp';
        sourceId = src.id;
        label = `MCP ${server}: ${mm[2]}`;
      } else {
        kind = 'mcp-remote';
        label = `MCP ${server}: ${mm[2]}`;
      }
    } else if (t.type && !t.description) {
      label = `server tool: ${t.type}`;
    }
    parts.push({
      id: `tool.${i}`, area: 'tools', index: i, role: 'tools', blockType: 'tool', name: t.name, cache: !!t.cache_control,
      label, text, chars: text.length, spans: [{ start: 0, end: text.length, kind, sourceId, label }], kind, sourceId,
    });
  });

  (body.messages || []).forEach((msg, mi) => {
    const blocks = typeof msg.content === 'string' ? [{ type: 'text', text: msg.content }] : Array.isArray(msg.content) ? msg.content : [];
    blocks.forEach((b, bi) => {
      const text = blockText(b);
      const bt = b.type || 'text';
      let defaultKind = msg.role === 'assistant' ? 'model' : msg.role === 'system' ? 'harness' : bt === 'tool_result' ? 'tool-result' : 'user';
      let defaultLabel = msg.role === 'assistant' ? (bt === 'thinking' ? 'model thinking' : bt === 'tool_use' ? `tool call: ${b.name}` : 'model reply') : msg.role === 'system' ? 'mid-conversation system message' : bt === 'tool_result' ? 'tool result' : 'user message';
      const spans = bt === 'text' || bt === 'tool_result' || msg.role === 'system'
        ? attributeText(text, { defaultKind, defaultLabel, inventory: inv, adhoc })
        : [{ start: 0, end: text.length, kind: defaultKind, label: defaultLabel }];
      parts.push({
        id: `msg.${mi}.${bi}`, area: 'messages', index: mi, sub: bi, role: msg.role, blockType: bt, cache: !!b.cache_control,
        name: b.name, toolUseId: b.tool_use_id || b.id, isError: b.is_error || false,
        label: defaultLabel, text, chars: text.length, spans, raw: bt === 'text' || bt === 'thinking' ? undefined : b,
      });
    });
  });

  return { parts, adhocSources };
}

// Assign token counts to parts and spans. Uses exact counts where available.
export async function countParts(parts, body, counter, opts = {}) {
  opts.out = opts.out || {};
  const model = body.model;
  const exactOk = counter && counter.ready && opts.exact !== false;
  let counted = 0;
  const jobs = [];

  const sysParts = parts.filter((p) => p.area === 'system');
  const toolParts = parts.filter((p) => p.area === 'tools');
  const msgParts = parts.filter((p) => p.area === 'messages');

  const setTokens = (p, n) => {
    if (n != null) {
      p.tokens = n;
      p.exact = true;
      counted++;
    } else {
      p.tokens = estimateTokens(p.text);
      p.exact = false;
    }
  };

  if (exactOk) {
    const sys = Array.isArray(body.system) ? body.system : body.system ? [{ type: 'text', text: body.system }] : [];
    sysParts.forEach((p, i) => jobs.push(counter.countSystemBlocks(model, [sys[i]]).then((n) => setTokens(p, n))));
    (body.tools || []).forEach((t, i) => jobs.push(counter.countTool(model, t).then((n) => setTokens(toolParts[i], n))));
    for (const p of msgParts) {
      const msg = body.messages[p.index];
      const block = typeof msg.content === 'string' ? { type: 'text', text: msg.content } : msg.content[p.sub];
      const role = msg.role === 'assistant' ? 'assistant' : 'user';
      let job;
      if (msg.role === 'system' || block.type === 'tool_result' || block.type === 'tool_use' || block.type === 'thinking' || block.type === 'redacted_thinking' || block.type === 'image' || block.type === 'document') {
        // count as plain text (structure-agnostic; tool_result/use wrappers add a few tokens)
        job = counter.countText(model, p.text).then((n) => setTokens(p, n));
      } else job = counter.countMessageBlock(model, role, block).then((n) => setTokens(p, n));
      jobs.push(job);
    }
    // Tools overhead: everything vs sum of individual
    if (body.tools && body.tools.length) {
      jobs.push(counter.countTools(model, body.tools).then((n) => { opts.out && (opts.out.toolsTotal = n); }));
      jobs.push(counter.toolFraming(model).then((n) => { opts.out && (opts.out.toolFraming = n); }));
    }
    if (sys.length) jobs.push(counter.countSystemBlocks(model, sys).then((n) => { opts.out && (opts.out.systemTotal = n); }));
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
    const overhead = opts.out && opts.out.toolsTotal != null ? Math.max(0, opts.out.toolsTotal - sumTools) : 400;
    const exact = !!(opts.out && opts.out.toolsTotal != null);
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
    const exactTok = exactSpans.reduce((a, s) => a + s.tokens, 0);
    const exactChars = exactSpans.reduce((a, s) => a + (s.end - s.start), 0);
    const restTok = Math.max(0, total - exactTok);
    const restChars = Math.max(1, chars - exactChars);
    for (const s of p.spans) {
      if (s.exact) continue;
      s.tokens = p.spans.length === 1 ? total : Math.round((restTok * (s.end - s.start)) / restChars);
      s.exact = p.spans.length === 1 ? p.exact : false;
    }
  }
  return counted;
}

export function totals(parts, inventory, adhocSources) {
  const byKind = {};
  const bySource = {};
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
        const b = bySource[s.sourceId] || (bySource[s.sourceId] = { chars: 0, tokens: 0, spans: 0, parts: new Set(), matches: {} });
        b.chars += s.end - s.start;
        b.tokens += s.tokens || 0;
        b.spans++;
        b.parts.add(p.id);
        b.matches[s.match || 'x'] = (b.matches[s.match || 'x'] || 0) + 1;
      }
    }
  }
  const byArea = {};
  for (const p of parts) {
    const a = byArea[p.area] || (byArea[p.area] = { chars: 0, tokens: 0, parts: 0 });
    a.chars += p.chars;
    a.tokens += p.tokens || 0;
    a.parts++;
  }
  for (const v of Object.values(bySource)) v.parts = [...v.parts];
  const sourceUsage = {};
  for (const s of [...inventory.sources, ...adhocSources]) {
    const b = bySource[s.id];
    sourceUsage[s.id] = { used: !!b, tokens: b ? b.tokens : 0, chars: b ? b.chars : 0, spans: b ? b.spans : 0, parts: b ? b.parts : [], matches: b ? b.matches : {}, coverage: b && s.size ? Math.min(1, b.chars / s.size) : 0 };
  }
  return { chars, tokens, byKind, byArea, bySource, sourceUsage };
}

// Diff two analyses (same session, consecutive main requests).
export function diffParts(prevParts, parts) {
  const key = (p) => (p.area === 'tools' ? `tool:${p.name}` : p.area === 'system' ? `sys:${p.index}` : `msg:${p.index}.${p.sub}`);
  const prev = new Map(prevParts.map((p) => [key(p), p]));
  const cur = new Map(parts.map((p) => [key(p), p]));
  const added = [];
  const removed = [];
  const changed = [];
  const same = [];
  for (const [k, p] of cur) {
    const q = prev.get(k);
    if (!q) added.push({ id: p.id, key: k, label: p.label, tokens: p.tokens, chars: p.chars, role: p.role, blockType: p.blockType });
    else if (sha(q.text) !== sha(p.text)) changed.push({ id: p.id, prevId: q.id, key: k, label: p.label, tokens: p.tokens, prevTokens: q.tokens, chars: p.chars, prevChars: q.chars });
    else same.push(p.id);
  }
  for (const [k, q] of prev) if (!cur.has(k)) removed.push({ id: q.id, key: k, label: q.label, tokens: q.tokens, chars: q.chars });
  const addedTokens = added.reduce((a, x) => a + (x.tokens || 0), 0);
  const removedTokens = removed.reduce((a, x) => a + (x.tokens || 0), 0);
  const changedDelta = changed.reduce((a, x) => a + ((x.tokens || 0) - (x.prevTokens || 0)), 0);
  return { added, removed, changed, sameCount: same.length, addedTokens, removedTokens, changedDelta };
}

export async function analyzeRequest(rec, inventory, counter, prevRec, opts = {}) {
  const body = rec.body;
  if (!body) return null;
  const cls = classifyRequest(body);
  const { parts, adhocSources } = buildParts(body, inventory);
  const out = {};
  const counted = await countParts(parts, body, counter, { exact: opts.exact, out });
  const t = totals(parts, inventory, adhocSources);
  const u = (rec.response && rec.response.usage) || null;
  const promptTotal = u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : null;
  const analysis = {
    kind: cls.kind,
    label: cls.label,
    parts,
    adhocSources,
    totals: { ...t, bySource: t.bySource },
    counted,
    partCount: parts.length,
    exactTotal: counted === parts.length,
    toolsTotal: out.toolsTotal ?? null,
    systemTotal: out.systemTotal ?? null,
    toolsOverhead: out.toolsTotal != null ? (parts.find((p) => p.id === 'tools.framing') || {}).tokens ?? null : null,
    toolFraming: out.toolFraming ?? null,
    promptTotalFromUsage: promptTotal,
    cache: u ? { read: u.cache_read_input_tokens || 0, write: u.cache_creation_input_tokens || 0, uncached: u.input_tokens || 0 } : null,
    diff: prevRec && prevRec.analysis ? diffParts(prevRec.analysis.parts, parts) : null,
    prevId: prevRec ? prevRec.id : null,
    inventoryScannedAt: inventory.scannedAt,
  };
  return analysis;
}

// Strip heavy text for list/summary transport; keep spans.
export function slimAnalysis(a) {
  if (!a) return null;
  return { ...a, parts: a.parts.map(({ text, raw, ...p }) => p) };
}
