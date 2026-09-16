import test from 'node:test';
import assert from 'node:assert/strict';
import { buildFlowGraph, buildContextGraph, fmtK, callKind } from '../src/graph.js';
import { summarize, threadKey } from '../src/store.js';
import type { Analysis, CaptureRecord, Source } from '../src/types.js';

const analysis = (over: Partial<Analysis>): Analysis => ({
  kind: 'main', label: 'agent turn', agent: null, parts: [], adhocSources: [],
  totals: { chars: 0, tokens: 0, byKind: {}, byArea: {}, bySource: {}, sourceUsage: {} },
  counted: 0, partCount: 0, exactTotal: false, toolsTotal: null, systemTotal: null, toolsOverhead: null, toolFraming: null,
  promptTotalFromUsage: null, cache: null, diff: null, prevId: null, inventoryScannedAt: 0, ...over,
});
const rec = (over: Partial<CaptureRecord>): CaptureRecord => ({
  id: 'r', startedAt: 't', method: 'POST', path: '/v1/messages', agent: null, headers: {}, bytesIn: 0, body: null, bodyText: null,
  sessionId: 's1', meta: {}, model: 'claude-sonnet-5', stream: true, toolCount: 0, messageCount: 0, status: 200, response: null, ...over,
});

test('flow graph links turns, tool calls, results and side calls with token weights', () => {
  const side = rec({ id: 'a', seq: 1, kind: 'side:session title', response: { id: null, model: null, role: 'assistant', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 100, output_tokens: 5 }, context_management: null, error: null, eventCount: 0, firstTokenAt: null } });
  const t1 = rec({
    id: 'b', seq: 2, kind: 'main', userPreview: 'list files',
    response: { id: null, model: null, role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }, { type: 'tool_use', id: 'tu2', name: 'mcp__db__query', input: { q: 'x' } }, { type: 'tool_use', id: 'tu3', name: 'mcp__db__list', input: {} }], stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10, cache_read_input_tokens: 1000, output_tokens: 40 }, context_management: null, error: null, eventCount: 0, firstTokenAt: null },
    analysis: analysis({ totals: { chars: 0, tokens: 1010, byKind: { harness: { chars: 1, tokens: 900, spans: 1, exactTokens: 900 } }, byArea: {}, bySource: {}, sourceUsage: {} } }),
  });
  const t2 = rec({
    id: 'c', seq: 3, kind: 'main', userPreview: '[tool results]',
    response: { id: null, model: null, role: 'assistant', content: [{ type: 'text', text: 'done' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 5, cache_read_input_tokens: 1050, output_tokens: 3 }, context_management: null, error: null, eventCount: 0, firstTokenAt: null },
    analysis: analysis({
      parts: [{ id: 'msg.2.0', area: 'messages', index: 2, sub: 0, role: 'user', blockType: 'tool_result', toolUseId: 'tu1', label: 'r', text: 'a.txt', chars: 5, spans: [], tokens: 7 }],
      diff: { added: [], removed: [], changed: [], sameCount: 0, addedTokens: 55, removedTokens: 0, changedDelta: 0 },
    }),
  });
  const g = buildFlowGraph('s1', [side, t1, t2], new Set(['db']));
  const ids = new Set(g.nodes.map((n) => n.data.id));
  assert.ok(ids.has('req:a') && ids.has('req:b') && ids.has('req:c'));
  assert.equal(g.nodes.find((n) => n.data.id === 'req:b')!.data.tokens, 1010);
  assert.equal(g.nodes.find((n) => n.data.id === 'req:a')!.data.kind, 'side');
  assert.ok(ids.has('call:tu1') && ids.has('call:tu2') && ids.has('grp:b:db'));
  assert.equal(g.nodes.find((n) => n.data.id === 'call:tu2')!.data.parent, 'grp:b:db');
  assert.equal(g.nodes.find((n) => n.data.id === 'call:tu2')!.data.kind, 'mcp');
  assert.equal(g.nodes.find((n) => n.data.id === 'call:tu1')!.data.label, 'Bash: ls');
  const e = (s: string, t: string) => g.edges.find((x) => x.data.source === s && x.data.target === t)!;
  assert.equal(e('req:b', 'req:c').data.kind, 'next');
  assert.equal(e('req:b', 'req:c').data.label, '+55');
  assert.equal(e('call:tu1', 'req:c').data.tokens, 7);
  assert.equal(e('req:a', 'req:b').data.kind, 'side'); // orphan side call attached to the first turn
  assert.equal(g.stats.turns, 2);
  assert.equal(g.stats.calls, 3);
  assert.equal(g.stats.sideCalls, 1);
});

test('context graph routes source and kind tokens into request areas', () => {
  const src: Source = { id: 'cm1', kind: 'claude-md', name: 'CLAUDE.md', path: '/p/CLAUDE.md', scope: 'project', description: '', frontmatter: {}, content: '', body: '', size: 10, mtime: 0 };
  const r = rec({
    id: 'q', seq: 4, kind: 'main',
    response: { id: null, model: null, role: 'assistant', content: [], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 500 }, context_management: null, error: null, eventCount: 0, firstTokenAt: null },
    analysis: analysis({
      parts: [
        { id: 'sys.0', area: 'system', index: 0, role: 'system', blockType: 'text', label: 's', text: 'x', chars: 1, spans: [{ start: 0, end: 1, kind: 'harness', tokens: 300 }], tokens: 300 },
        { id: 'msg.0.0', area: 'messages', index: 0, sub: 0, role: 'user', blockType: 'text', label: 'm', text: 'xy', chars: 2, spans: [{ start: 0, end: 1, kind: 'claude-md', sourceId: 'cm1', tokens: 150 }, { start: 1, end: 2, kind: 'user', tokens: 50 }], tokens: 200 },
      ],
      totals: { chars: 3, tokens: 500, byKind: {}, byArea: { system: { chars: 1, tokens: 300, parts: 1 }, messages: { chars: 2, tokens: 200, parts: 1 } }, bySource: {}, sourceUsage: {} },
    }),
  });
  const g = buildContextGraph(r, [src]);
  const ids = new Set(g.nodes.map((n) => n.data.id));
  assert.ok(ids.has('req:q') && ids.has('area:system') && ids.has('area:messages') && ids.has('src:cm1') && ids.has('kind:harness') && ids.has('kind:user'));
  assert.equal(g.nodes.find((n) => n.data.id === 'src:cm1')!.data.label, 'p/CLAUDE.md');
  const e = (s: string, t: string) => g.edges.find((x) => x.data.source === s && x.data.target === t)!;
  assert.equal(e('src:cm1', 'area:messages').data.tokens, 150);
  assert.equal(e('kind:harness', 'area:system').data.tokens, 300);
  assert.equal(e('area:system', 'req:q').data.tokens, 300);
  assert.equal(g.stats.sources, 1);
  assert.equal(g.stats.tokens, 500);
});

test('helpers', () => {
  assert.equal(fmtK(999), '999');
  assert.equal(fmtK(1500), '1.5k');
  assert.equal(fmtK(86685), '86.7k');
  assert.deepEqual(callKind('mcp__db__q', {}, new Set(['db'])), { kind: 'mcp', server: 'db' });
  assert.equal(callKind('mcp__claude_ai_Gmail__send', {}, new Set()).kind, 'mcp-remote');
  assert.equal(callKind('Agent', {}, new Set()).kind, 'agent');
  assert.equal(callKind('Skill', {}, new Set()).kind, 'skill');
  assert.equal(callKind('Bash', {}, new Set()).kind, 'harness-tool');
});

test('Agent calls are linked to the subagent thread whose first message holds their prompt', () => {
  const resp = (content: unknown[]) => ({ id: null, model: null, role: 'assistant', content, stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 10 }, context_management: null, error: null, eventCount: 0, firstTokenAt: null }) as CaptureRecord['response'];
  const body = (first: string) => ({ model: 'm', messages: [{ role: 'user' as const, content: [{ type: 'text' as const, text: first }] }] });
  const main = rec({ id: 'm1', seq: 1, kind: 'main', body: body('hello'), response: resp([
    { type: 'tool_use', id: 'a1', name: 'Agent', input: { subagent_type: 'mapper', prompt: 'Refresh the SCOPE.md for project alpha' } },
    { type: 'tool_use', id: 'a2', name: 'Agent', input: { subagent_type: 'mapper', prompt: 'Refresh the SCOPE.md for project beta' } },
  ]) });
  const subA1 = rec({ id: 's1', seq: 2, kind: 'main:subagent: mapper', body: body('<system-reminder>ctx</system-reminder>\nRefresh the SCOPE.md for project beta') });
  const subB1 = rec({ id: 's2', seq: 3, kind: 'main:subagent: mapper', body: body('<system-reminder>ctx</system-reminder>\nRefresh the SCOPE.md for project alpha') });
  const subA2 = rec({ id: 's3', seq: 4, kind: 'main:subagent: mapper', body: { ...body('<system-reminder>ctx</system-reminder>\nRefresh the SCOPE.md for project beta'), messages: [...body('<system-reminder>ctx</system-reminder>\nRefresh the SCOPE.md for project beta').messages, { role: 'assistant' as const, content: 'ok' }] } });
  const g = buildFlowGraph('s1', [main, subA1, subB1, subA2]);
  const thread = (id: string) => g.nodes.find((n) => n.data.id === id)!.data.detail!.thread;
  assert.equal(thread('call:a1'), threadKey(subB1));
  assert.equal(thread('call:a2'), threadKey(subA1));
  assert.equal(threadKey(subA1), threadKey(subA2)); // later turns of one instance share the thread
  assert.notEqual(threadKey(subA1), threadKey(subB1));
  assert.equal(summarize(subA2)!.thread, threadKey(subA1));
});
