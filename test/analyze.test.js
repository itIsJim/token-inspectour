import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeText, buildParts, classifyRequest, diffParts, countParts, totals } from '../src/analyze.js';

const inventory = {
  scannedAt: 1,
  sources: [
    { id: 'cm1', kind: 'claude-md', name: 'CLAUDE.md', path: '/p/CLAUDE.md', scope: 'project', body: '# Project rules\n\nAlways be terse.\nNever push to remote branches.', content: '# Project rules\n\nAlways be terse.\nNever push to remote branches.', size: 60 },
    { id: 'sk1', kind: 'skill', name: 'deploy', path: '/p/.claude/skills/deploy/SKILL.md', scope: 'project', description: 'Deploy the app', body: 'Run the deploy script and check the health endpoint afterwards. Report the version.', content: '---\nname: deploy\n---\nRun the deploy script and check the health endpoint afterwards. Report the version.', size: 110 },
    { id: 'ag1', kind: 'agent', name: 'researcher', path: '/p/.claude/agents/researcher.md', scope: 'project', body: 'You research things.', content: 'You research things.', size: 20 },
    { id: 'cmd1', kind: 'command', name: 'ship', path: '/p/.claude/commands/ship.md', scope: 'project', body: 'Ship it now please and thank you very much indeed.', content: 'Ship it now please and thank you very much indeed.', size: 50 },
    { id: 'mcp1', kind: 'mcp', name: '.mcp.json', path: '/p/.mcp.json', scope: 'project', body: '{}', content: '{}', size: 2, servers: [{ name: 'my-db', sanitized: 'my-db', config: {} }] },
  ],
};

test('attributes "Contents of" sections inside system reminders to the right file', () => {
  const text = '<system-reminder>\nCodebase and user instructions are shown below.\n\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project rules\n\nAlways be terse.\nNever push to remote branches.\n\nContents of /elsewhere/MEMORY.md (user\'s auto-memory, persists across conversations):\n\n# Memory\n- nothing\n</system-reminder>';
  const adhoc = (file, desc) => ({ id: 'x1', kind: /memory/.test(desc) ? 'memory' : 'file', path: file, name: 'MEMORY.md' });
  const spans = attributeText(text, { defaultKind: 'user', defaultLabel: 'user', inventory, adhoc });
  const kinds = spans.map((s) => s.kind);
  assert.deepEqual(kinds, ['reminder', 'claude-md', 'memory', 'reminder']);
  assert.equal(spans[1].sourceId, 'cm1');
  assert.equal(spans[1].match, 'contents-of');
  // spans tile the whole text
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, text.length);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i].start, spans[i - 1].end);
});

test('attributes listings of skills, agents and MCP instructions', () => {
  const text = '<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: does everything\n- researcher: You research things.\n\nThe following skills are available for use with the Skill tool:\n\n- deploy: Deploy the app\n- ship\n- builtin-thing: bundled\n</system-reminder>\n\n# MCP Server Instructions\n\n## my-db\nUse the db.\n\n## claude_ai_Gmail\nMail things.\n';
  const spans = attributeText(text, { defaultKind: 'harness', defaultLabel: 'h', inventory, adhoc: () => ({ id: 'x', kind: 'file' }) });
  const bySrc = (id) => spans.filter((s) => s.sourceId === id);
  assert.equal(bySrc('ag1').length, 1);
  assert.match(text.slice(bySrc('ag1')[0].start, bySrc('ag1')[0].end), /^- researcher: You research things\.\n$/);
  assert.equal(bySrc('sk1').length, 1);
  assert.equal(bySrc('cmd1').length, 1);
  assert.match(text.slice(bySrc('cmd1')[0].start, bySrc('cmd1')[0].end), /^- ship\n$/);
  const mcp = spans.find((s) => s.kind === 'mcp');
  assert.equal(mcp.sourceId, 'mcp1');
  assert.match(text.slice(mcp.start, mcp.end), /^## my-db\nUse the db\.\n\n$/);
  assert.ok(spans.some((s) => s.kind === 'mcp-remote' && /Gmail/.test(s.label)));
  assert.ok(spans.some((s) => s.kind === 'harness' && /general-purpose/.test(s.label)));
});

test('matches skill bodies injected verbatim and partially', () => {
  const full = 'Here is the skill:\n\n' + inventory.sources[1].body + '\n\nGo.';
  let spans = attributeText(full, { defaultKind: 'user', defaultLabel: 'u', inventory, adhoc: () => ({}) });
  assert.ok(spans.some((s) => s.sourceId === 'sk1' && s.match === 'exact'));
  const long = { ...inventory.sources[1], body: 'x'.repeat(600) + 'TAIL-THAT-DIFFERS', content: '' };
  const inv2 = { sources: [long] };
  spans = attributeText('prefix ' + 'x'.repeat(600) + 'something else entirely', { defaultKind: 'user', defaultLabel: 'u', inventory: inv2, adhoc: () => ({}) });
  const p = spans.find((s) => s.sourceId === 'sk1');
  assert.equal(p.match, 'partial');
  assert.ok(p.coverage > 0.9);
});

const body = {
  model: 'claude-sonnet-5',
  system: [{ type: 'text', text: 'x-anthropic-billing-header: cc_version=1' }, { type: 'text', text: 'You are an interactive agent that helps users with software engineering tasks. '.repeat(3), cache_control: { type: 'ephemeral' } }],
  tools: [
    { name: 'Bash', description: 'Run a command', input_schema: { type: 'object' } },
    { name: 'mcp__my-db__query', description: 'Query', input_schema: { type: 'object' } },
    { name: 'mcp__claude_ai_Gmail__send', description: 'Send', input_schema: { type: 'object' } },
  ],
  messages: [
    { role: 'user', content: [{ type: 'text', text: '<system-reminder>\nContents of /p/CLAUDE.md (project instructions):\n\n# Project rules\n\nAlways be terse.\nNever push to remote branches.\n</system-reminder>' }, { type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'a.txt\nb.txt' }] },
  ],
};

test('buildParts classifies tools and message blocks; totals and diff line up', async () => {
  assert.equal(classifyRequest(body).kind, 'main');
  assert.equal(classifyRequest({ system: 'You are naming a coding session', tools: [] }).label, 'session title');
  const { parts, adhocSources } = buildParts(body, inventory);
  const tool = (n) => parts.find((p) => p.area === 'tools' && p.name === n);
  assert.equal(tool('Bash').kind, 'harness-tool');
  assert.equal(tool('mcp__my-db__query').kind, 'mcp');
  assert.equal(tool('mcp__my-db__query').sourceId, 'mcp1');
  assert.equal(tool('mcp__claude_ai_Gmail__send').kind, 'mcp-remote');
  const tr = parts.find((p) => p.blockType === 'tool_result');
  assert.equal(tr.spans[0].kind, 'tool-result');
  const tu = parts.find((p) => p.blockType === 'tool_use');
  assert.equal(tu.spans[0].kind, 'model');
  const counted = await countParts(parts, body, null, {});
  assert.equal(counted, 0); // no counter → estimates
  assert.ok(parts.every((p) => typeof p.tokens === 'number' && !p.exact));
  const t = totals(parts, inventory, adhocSources);
  assert.equal(t.tokens, parts.reduce((a, p) => a + p.tokens, 0));
  assert.ok(t.sourceUsage.cm1.used);
  assert.ok(!t.sourceUsage.sk1.used);
  assert.equal(t.byArea.tools.parts, 4); // 3 tools + framing
  const framing = parts.find((p) => p.id === 'tools.framing');
  assert.ok(framing && framing.tokens > 0);

  // diff: append a user message
  const body2 = { ...body, messages: [...body.messages, { role: 'user', content: 'next' }] };
  const { parts: parts2 } = buildParts(body2, inventory);
  await countParts(parts2, body2, null, {});
  const d = diffParts(parts, parts2);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].key, 'msg:3.0');
  assert.equal(d.removed.length, 0);
  assert.equal(d.sameCount, parts.length);
});

test('exact counting uses the counter and distributes tokens to spans', async () => {
  const calls = [];
  const fakeCounter = {
    ready: true,
    async countSystemBlocks(_m, blocks) { calls.push('sys'); return blocks.reduce((a, b) => a + b.text.length, 0) / 4; },
    async countTools(_m, tools) { calls.push('tools'); return 100 + tools.length * 50; },
    async toolFraming() { return 100 + 50; },
    async countTool(_m) { calls.push('tool'); return 50; },
    async countText(_m, text) { calls.push('text'); return Math.ceil(text.length / 4); },
    async countMessageBlock(_m, _r, block) { calls.push('msg'); return Math.ceil((block.text || '').length / 4); },
  };
  const { parts } = buildParts(body, inventory);
  const counted = await countParts(parts, body, fakeCounter, {});
  assert.equal(counted, parts.length);
  assert.ok(parts.every((p) => p.exact));
  const framing = parts.find((p) => p.id === 'tools.framing');
  assert.equal(framing.tokens, 250 - 150); // total(100+3*50) - 3*50
  const reminderPart = parts.find((p) => p.id === 'msg.0.0');
  const sum = reminderPart.spans.reduce((a, s) => a + s.tokens, 0);
  assert.ok(Math.abs(sum - reminderPart.tokens) <= reminderPart.spans.length);
});
