// Build flow-graph data (nodes + edges for the d3 flow graph and Sankey) from captured requests.
//
//  flow    — one session: agent turns in order, the tool calls each turn made (built-in,
//            MCP, skills, subagent spawns), side calls, with token weights on every edge.
//  context — one request: which sources (CLAUDE.md, skills, harness, …) feed which area of
//            the request (system / tools / messages), edge width by tokens.
import { KINDS } from './inventory.js';
import { firstMessageText, threadKey } from './store.js';
import type { AnySource, CaptureRecord, GraphData, GraphEdge, GraphNode, GraphNodeKind, Part, SourceKind, ToolUseBlock } from './types.js';

const promptTotal = (rec: CaptureRecord): number | undefined => {
  const u = rec.response?.usage;
  if (!u) return rec.analysis?.totals.tokens;
  return (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
};

const describeInput = (name: string, input: Record<string, unknown>): string => {
  const i = input || {};
  const pick = (k: string): string | null => (typeof i[k] === 'string' && (i[k] as string).trim() ? (i[k] as string).trim() : null);
  const arg = pick('file_path') || pick('path') || pick('skill') || pick('subagent_type') || pick('command') || pick('pattern') || pick('url') || pick('description') || pick('query') || pick('prompt');
  if (!arg) return name;
  const short = arg.replace(/^\/Users\/[^/]+/, '~').replace(/\s+/g, ' ');
  return `${name}: ${short.length > 48 ? short.slice(0, 46) + '…' : short}`;
};

export function callKind(name: string, input: Record<string, unknown>, mcpServers: Set<string>): { kind: GraphNodeKind; server?: string } {
  const m = /^mcp__(.+?)__(.+)$/.exec(name || '');
  if (m) return { kind: mcpServers.has(m[1]) ? 'mcp' : 'mcp-remote', server: m[1] };
  if (name === 'Skill') return { kind: 'skill' };
  if (name === 'Agent' || name === 'Task') return { kind: 'agent' };
  if (name === 'Read' || name === 'NotebookRead') return { kind: 'file' };
  void input;
  return { kind: 'harness-tool' };
}

export function buildFlowGraph(sessionId: string, records: CaptureRecord[], mcpServers: Set<string> = new Set()): GraphData {
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const stats = { turns: 0, sideCalls: 0, calls: 0, promptTokens: 0, outputTokens: 0 };
  let prevTurn: string | null = null;
  let pendingCalls: Array<{ id: string; toolUseId: string }> = [];
  let firstTurn: string | null = null;
  const orphanSides: string[] = [];
  // a subagent instance's first message contains the prompt its Agent call was given
  const subagentThreads = records.filter((r) => /^main:subagent/.test(r.kind || '')).map((r) => ({ text: firstMessageText(r), thread: threadKey(r) }));
  const threadForPrompt = (prompt: unknown): string | undefined => {
    const p = typeof prompt === 'string' ? prompt.trim().slice(0, 400) : '';
    return p ? subagentThreads.find((t) => t.thread && t.text.includes(p))?.thread || undefined : undefined;
  };

  for (const rec of records) {
    const a = rec.analysis;
    const isMain = (rec.kind || '').startsWith('main');
    const nodeId = `req:${rec.id}`;
    const tokens = promptTotal(rec);
    const out = rec.response?.usage?.output_tokens;

    if (!isMain) {
      stats.sideCalls++;
      const label = (rec.kind || 'side').replace(/^side:/, '');
      nodes.push({ data: { id: nodeId, label, kind: 'side', sub: rec.model || '', tokens, tokensOut: out, ref: { type: 'request', id: rec.id }, detail: { seq: rec.seq, status: rec.status, durationMs: rec.durationMs } } });
      if (prevTurn) edges.push({ data: { id: `e:${prevTurn}>${nodeId}`, source: prevTurn, target: nodeId, kind: 'side', tokens } });
      else orphanSides.push(nodeId);
      continue;
    }

    stats.turns++;
    stats.promptTokens += tokens || 0;
    stats.outputTokens += out || 0;
    const isSub = !!a && /^subagent/.test(a.label);
    const label = isSub ? `#${rec.seq} ${a!.label}` : `#${rec.seq} turn`;
    const u = rec.response?.usage;
    nodes.push({
      data: {
        id: nodeId, label, kind: isSub ? 'agent' : 'turn',
        sub: [rec.model || '', rec.response?.stop_reason || (rec.status == null ? 'in flight' : ''), rec.userPreview ? `“${rec.userPreview.slice(0, 60)}${rec.userPreview.length > 60 ? '…' : ''}”` : ''].filter(Boolean).join(' · '),
        tokens, tokensOut: out, ref: { type: 'request', id: rec.id },
        detail: {
          seq: rec.seq, model: rec.model, status: rec.status, durationMs: rec.durationMs, stopReason: rec.response?.stop_reason,
          cacheRead: u?.cache_read_input_tokens || 0, cacheWrite: u?.cache_creation_input_tokens || 0, uncached: u?.input_tokens || 0,
          byKind: a ? Object.fromEntries(Object.entries(a.totals.byKind).map(([k, v]) => [k, v!.tokens])) : {},
          userPreview: rec.userPreview, assistantPreview: rec.assistantPreview,
        },
      },
    });
    if (!firstTurn) firstTurn = nodeId;

    // results of the previous turn's calls land in this request as tool_result parts
    const parts: Part[] = a ? a.parts : [];
    for (const c of pendingCalls) {
      const resPart = parts.find((p) => p.blockType === 'tool_result' && p.toolUseId === c.toolUseId);
      const t = resPart?.tokens;
      edges.push({ data: { id: `e:${c.id}>${nodeId}`, source: c.id, target: nodeId, kind: 'result', tokens: t, label: t != null ? `${fmtK(t)} back` : undefined } });
      if (resPart) {
        const n = nodes.find((x) => x.data.id === c.id);
        if (n) n.data.detail = { ...n.data.detail, resultTokens: t, resultPreview: resPart.text.slice(0, 400), isError: resPart.isError };
      }
    }
    pendingCalls = [];
    if (prevTurn) {
      const added = a?.diff?.addedTokens;
      edges.push({ data: { id: `e:${prevTurn}>${nodeId}`, source: prevTurn, target: nodeId, kind: 'next', tokens: added, label: added != null ? `+${fmtK(added)}` : undefined } });
    }
    prevTurn = nodeId;

    // tool calls this turn made (from the assembled response)
    const calls = ((rec.response?.content || []).filter((b) => b.type === 'tool_use') as ToolUseBlock[]);
    const byServer = new Map<string, number>();
    for (const c of calls) {
      const { server } = callKind(c.name, c.input, mcpServers);
      if (server) byServer.set(server, (byServer.get(server) || 0) + 1);
    }
    for (const c of calls) {
      stats.calls++;
      const { kind, server } = callKind(c.name, c.input, mcpServers);
      const callId = `call:${c.id}`;
      let parent: string | undefined;
      if (server && (byServer.get(server) || 0) > 1) {
        parent = `grp:${rec.id}:${server}`;
        if (!nodes.some((n) => n.data.id === parent)) nodes.push({ data: { id: parent, label: `MCP · ${server}`, kind: 'group' } });
      }
      const tokens = estimateJson(c.input);
      nodes.push({
        data: {
          id: callId, label: describeInput(c.name, c.input), kind, parent, tokens,
          sub: server ? `mcp · ${server}` : KINDS[kind as SourceKind]?.label || kind,
          ref: { type: 'call', id: c.id, requestId: rec.id },
          detail: { tool: c.name, input: c.input, turn: rec.seq, ...(kind === 'agent' ? { thread: threadForPrompt(c.input?.prompt) } : {}) },
        },
      });
      edges.push({ data: { id: `e:${nodeId}>${callId}`, source: nodeId, target: callId, kind: kind === 'agent' ? 'spawn' : 'call', tokens } });
      pendingCalls.push({ id: callId, toolUseId: c.id });
    }
  }
  for (const s of orphanSides) if (firstTurn) edges.push({ data: { id: `e:${s}>${firstTurn}`, source: s, target: firstTurn, kind: 'side' } });
  // calls still waiting for a result (turn in flight or session ended after a tool call)
  return { mode: 'flow', sessionId, nodes, edges, stats };
}

export function buildContextGraph(rec: CaptureRecord, sources: AnySource[]): GraphData {
  const a = rec.analysis;
  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const stats = { sources: 0, tokens: 0 };
  if (!a) return { mode: 'context', sessionId: rec.sessionId, requestId: rec.id, nodes, edges, stats };
  const reqId = `req:${rec.id}`;
  const total = promptTotal(rec) ?? a.totals.tokens;
  stats.tokens = total;
  nodes.push({ data: { id: reqId, label: `#${rec.seq} request`, kind: 'request', sub: `${fmtK(total)} tokens · ${rec.model || ''}`, tokens: total, ref: { type: 'request', id: rec.id } } });
  const areaLabel: Record<string, string> = { system: 'System prompt', tools: 'Tools', messages: 'Messages' };
  for (const [area, t] of Object.entries(a.totals.byArea)) {
    const id = `area:${area}`;
    nodes.push({ data: { id, label: areaLabel[area] || area, kind: 'area', sub: `${t!.parts} parts`, tokens: t!.tokens, ref: { type: 'area', id: area, requestId: rec.id } } });
    edges.push({ data: { id: `e:${id}>${reqId}`, source: id, target: reqId, kind: 'feeds', tokens: t!.tokens, label: fmtK(t!.tokens) } });
  }
  // (source or kind) → area token sums
  const sums = new Map<string, { key: string; area: string; tokens: number; sourceId?: string; kind: SourceKind; chars: number }>();
  for (const p of a.parts) {
    for (const s of p.spans) {
      const key = s.sourceId ? `src:${s.sourceId}` : `kind:${s.kind}`;
      const k = `${key}|${p.area}`;
      const cur = sums.get(k) || { key, area: p.area, tokens: 0, sourceId: s.sourceId, kind: s.kind, chars: 0 };
      cur.tokens += s.tokens || 0;
      cur.chars += s.end - s.start;
      sums.set(k, cur);
    }
  }
  const srcById = new Map(sources.map((s) => [s.id, s]));
  const nodeTokens = new Map<string, number>();
  for (const v of sums.values()) nodeTokens.set(v.key, (nodeTokens.get(v.key) || 0) + v.tokens);
  const kindCounts = new Map<SourceKind, number>();
  for (const v of sums.values()) if (v.sourceId) kindCounts.set(v.kind, (kindCounts.get(v.kind) || 0) + 1);
  const seen = new Set<string>();
  for (const v of sums.values()) {
    if (!seen.has(v.key)) {
      seen.add(v.key);
      const tokens = nodeTokens.get(v.key) || 0;
      if (v.sourceId) {
        const src = srcById.get(v.sourceId);
        stats.sources++;
        const groupId = `k:${v.kind}`;
        const grouped = (kindCounts.get(v.kind) || 0) > 1;
        if (grouped && !nodes.some((n) => n.data.id === groupId)) nodes.push({ data: { id: groupId, label: KINDS[v.kind]?.label || v.kind, kind: 'group' } });
        const label = src ? (/^CLAUDE(\.local)?\.md$/i.test(src.name) ? `${src.path.split('/').slice(-2, -1)[0] || ''}/${src.name}` : src.name) : v.sourceId;
        nodes.push({ data: { id: v.key, label, kind: v.kind, parent: grouped ? groupId : undefined, tokens, sub: src ? `${src.scope} · ${fmtK(tokens)} tokens` : '', ref: { type: 'source', id: v.sourceId }, detail: { path: src?.path, size: src?.size } } });
      } else {
        nodes.push({ data: { id: v.key, label: KINDS[v.kind]?.label || v.kind, kind: v.kind, tokens, sub: `${fmtK(tokens)} tokens` } });
      }
    }
    if (v.tokens > 0) edges.push({ data: { id: `e:${v.key}>${v.area}`, source: v.key, target: `area:${v.area}`, kind: 'feeds', tokens: v.tokens, label: v.tokens >= 200 ? fmtK(v.tokens) : undefined } });
  }
  return { mode: 'context', sessionId: rec.sessionId, requestId: rec.id, nodes, edges, stats };
}

function estimateJson(v: unknown): number {
  const s = JSON.stringify(v ?? {});
  return Math.max(1, Math.round(s.length / 4));
}

export function fmtK(n: number): string {
  if (n >= 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(2).replace(/\.?0+$/, '')}k`;
  return String(n);
}
