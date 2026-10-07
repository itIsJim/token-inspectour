import test from 'node:test';
import assert from 'node:assert/strict';
import { attributeText, buildParts, classifyRequest, diffParts, countParts, totals, detectProjectDir, analyzeRequest, isClaudeCode } from '../src/analyze.js';
import type { Counter } from '../src/tokens.js';
import type { AdhocSource, Inventory, RequestBody, Source } from '../src/types.js';

const src = (s: Partial<Source> & Pick<Source, 'id' | 'kind' | 'name' | 'path' | 'body' | 'content' | 'size'>): Source => ({
  scope: 'project', description: '', frontmatter: {}, mtime: 0, ...s,
});

const inventory: Inventory = {
  projectDir: '/p',
  scannedAt: 1,
  sources: [
    src({ id: 'cm1', kind: 'claude-md', name: 'CLAUDE.md', path: '/p/CLAUDE.md', body: '# Project rules\n\nAlways be terse.\nNever push to remote branches.', content: '# Project rules\n\nAlways be terse.\nNever push to remote branches.', size: 60 }),
    src({ id: 'sk1', kind: 'skill', name: 'deploy', path: '/p/.claude/skills/deploy/SKILL.md', description: 'Deploy the app', body: 'Run the deploy script and check the health endpoint afterwards. Report the version.', content: '---\nname: deploy\n---\nRun the deploy script and check the health endpoint afterwards. Report the version.', size: 110 }),
    src({ id: 'ag1', kind: 'agent', name: 'researcher', path: '/p/.claude/agents/researcher.md', body: 'You research things carefully and report back with sources and confidence levels.', content: 'You research things carefully and report back with sources and confidence levels.', size: 80 }),
    src({ id: 'cmd1', kind: 'command', name: 'ship', path: '/p/.claude/commands/ship.md', body: 'Ship it now please and thank you very much indeed.', content: 'Ship it now please and thank you very much indeed.', size: 50 }),
    src({ id: 'mcp1', kind: 'mcp', name: '.mcp.json', path: '/p/.mcp.json', body: '{}', content: '{}', size: 2, servers: [{ name: 'my-db', sanitized: 'my-db', config: {} }] }),
  ],
};

const noAdhoc = (file: string, desc: string): AdhocSource => ({ id: 'x', kind: 'file', path: file, name: file, scope: 'external', description: desc, size: 0, adhoc: true });

test('attributes "Contents of" sections inside system reminders to the right file', () => {
  const text = "<system-reminder>\nCodebase and user instructions are shown below.\n\nContents of /p/CLAUDE.md (project instructions, checked into the codebase):\n\n# Project rules\n\nAlways be terse.\nNever push to remote branches.\n\nContents of /elsewhere/MEMORY.md (user's auto-memory, persists across conversations):\n\n# Memory\n- nothing\n</system-reminder>";
  const adhoc = (file: string, desc: string): AdhocSource => ({ id: 'x1', kind: /memory/.test(desc) ? 'memory' : 'file', path: file, name: 'MEMORY.md', scope: 'external', description: desc, size: 0, adhoc: true });
  const spans = attributeText(text, { defaultKind: 'user', defaultLabel: 'user', inventory, adhoc });
  assert.deepEqual(spans.map((s) => s.kind), ['reminder', 'claude-md', 'memory', 'reminder']);
  assert.equal(spans[1].sourceId, 'cm1');
  assert.equal(spans[1].match, 'contents-of');
  assert.equal(spans[0].start, 0);
  assert.equal(spans[spans.length - 1].end, text.length);
  for (let i = 1; i < spans.length; i++) assert.equal(spans[i].start, spans[i - 1].end);
});

test('attributes listings of skills, agents and MCP instructions', () => {
  const text = '<system-reminder>\nAvailable agent types for the Agent tool:\n- general-purpose: does everything\n- researcher: You research things.\n\nThe following skills are available for use with the Skill tool:\n\n- deploy: Deploy the app\n- ship\n- builtin-thing: bundled\n</system-reminder>\n\n# MCP Server Instructions\n\n## my-db\nUse the db.\n\n## claude_ai_Gmail\nMail things.\n';
  const spans = attributeText(text, { defaultKind: 'harness', defaultLabel: 'h', inventory, adhoc: noAdhoc });
  const bySrc = (id: string) => spans.filter((s) => s.sourceId === id);
  assert.equal(bySrc('ag1').length, 1);
  assert.match(text.slice(bySrc('ag1')[0].start, bySrc('ag1')[0].end), /^- researcher: You research things\.\n$/);
  assert.equal(bySrc('sk1').length, 1);
  assert.equal(bySrc('cmd1').length, 1);
  assert.match(text.slice(bySrc('cmd1')[0].start, bySrc('cmd1')[0].end), /^- ship\n$/);
  const mcp = spans.find((s) => s.kind === 'mcp')!;
  assert.equal(mcp.sourceId, 'mcp1');
  assert.match(text.slice(mcp.start, mcp.end), /^## my-db\nUse the db\.\n\n$/);
  assert.ok(spans.some((s) => s.kind === 'mcp-remote' && /Gmail/.test(s.label || '')));
  assert.ok(spans.some((s) => s.kind === 'harness' && /general-purpose/.test(s.label || '')));
});

test('matches skill bodies injected verbatim and partially', () => {
  const full = 'Here is the skill:\n\n' + inventory.sources[1].body + '\n\nGo.';
  let spans = attributeText(full, { defaultKind: 'user', defaultLabel: 'u', inventory, adhoc: noAdhoc });
  assert.ok(spans.some((s) => s.sourceId === 'sk1' && s.match === 'exact'));
  const long: Source = { ...inventory.sources[1], body: 'x'.repeat(600) + 'TAIL-THAT-DIFFERS', content: '' };
  spans = attributeText('prefix ' + 'x'.repeat(600) + 'something else entirely', { defaultKind: 'user', defaultLabel: 'u', inventory: { sources: [long] }, adhoc: noAdhoc });
  const p = spans.find((s) => s.sourceId === 'sk1')!;
  assert.equal(p.match, 'partial');
  assert.ok((p.coverage || 0) > 0.9);
});

const body: RequestBody = {
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
  assert.equal(classifyRequest({ model: 'm', metadata: { user_id: JSON.stringify({ session_id: 's1' }) }, system: 'You are naming a coding session', tools: [] }).label, 'session title');
  const { parts, adhocSources } = buildParts(body, inventory);
  const tool = (n: string) => parts.find((p) => p.area === 'tools' && p.name === n)!;
  assert.equal(tool('Bash').kind, 'harness-tool');
  assert.equal(tool('mcp__my-db__query').kind, 'mcp');
  assert.equal(tool('mcp__my-db__query').sourceId, 'mcp1');
  assert.equal(tool('mcp__claude_ai_Gmail__send').kind, 'mcp-remote');
  assert.equal(parts.find((p) => p.blockType === 'tool_result')!.spans[0].kind, 'tool-result');
  assert.equal(parts.find((p) => p.blockType === 'tool_use')!.spans[0].kind, 'model');
  const counted = await countParts(parts, body, null, {});
  assert.equal(counted, 0);
  assert.ok(parts.every((p) => typeof p.tokens === 'number' && !p.exact));
  const t = totals(parts, inventory, adhocSources);
  assert.equal(t.tokens, parts.reduce((a, p) => a + (p.tokens || 0), 0));
  assert.ok(t.sourceUsage.cm1.used);
  assert.ok(!t.sourceUsage.sk1.used);
  assert.equal(t.byArea.tools?.parts, 4); // 3 tools + framing
  const framing = parts.find((p) => p.id === 'tools.framing')!;
  assert.ok(framing.tokens! > 0);

  const body2: RequestBody = { ...body, messages: [...body.messages!, { role: 'user', content: 'next' }] };
  const { parts: parts2 } = buildParts(body2, inventory);
  await countParts(parts2, body2, null, {});
  const d = diffParts(parts, parts2);
  assert.equal(d.added.length, 1);
  assert.equal(d.added[0].key, 'msg:3.0');
  assert.equal(d.removed.length, 0);
  assert.equal(d.sameCount, parts.length);
});

test('exact counting uses the counter and distributes tokens to spans', async () => {
  const fakeCounter: Counter = {
    ready: true,
    async countSystemBlocks(_m, blocks) { return blocks.reduce((a, b) => a + b.text.length, 0) / 4; },
    async countTools(_m, tools) { return 100 + tools.length * 50; },
    async toolFraming() { return 150; },
    async countTool() { return 50; },
    async countText(_m, text) { return Math.ceil(text.length / 4); },
    async countMessageBlock(_m, _r, block) { return Math.ceil(((block as { text?: string }).text || '').length / 4); },
    async countThinkingBlock() { return 0; },
  };
  const { parts } = buildParts(body, inventory);
  const counted = await countParts(parts, body, fakeCounter, {});
  assert.equal(counted, parts.length);
  assert.ok(parts.every((p) => p.exact));
  assert.equal(parts.find((p) => p.id === 'tools.framing')!.tokens, 250 - 150);
  const reminderPart = parts.find((p) => p.id === 'msg.0.0')!;
  const sum = reminderPart.spans.reduce((a, s) => a + (s.tokens || 0), 0);
  assert.ok(Math.abs(sum - reminderPart.tokens!) <= reminderPart.spans.length);
});

test('thinking blocks sent as signature only are counted, not reported as empty', async () => {
  const b: RequestBody = {
    model: 'm', thinking: { type: 'adaptive' }, context_management: { edits: [{ type: 'clear_thinking_20251015', keep: 'all' }] },
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: 'x'.repeat(3300) }, { type: 'text', text: 'ok' }] },
      { role: 'user', content: 'next' },
    ],
  };
  const { parts } = buildParts(b, inventory);
  const th = parts.find((p) => p.id === 'msg.1.0')!;
  assert.equal(th.signatureChars, 3300);
  assert.equal(th.label, 'model thinking (encrypted signature only)');
  await countParts(parts, b, null, {});
  assert.equal(th.tokens, 1000); // local estimate from the signature
  assert.equal(th.exact, false);

  let seen: unknown;
  const counter: Counter = {
    ready: true,
    async countSystemBlocks() { return 0; }, async countTools() { return 0; }, async toolFraming() { return 0; }, async countTool() { return 0; },
    async countText(_m, text) { return text.length; }, async countMessageBlock(_m, _r, block) { return ((block as { text?: string }).text || '').length; },
    async countThinkingBlock(_m, _block, settings) { seen = settings; return 777; },
  };
  const { parts: p2 } = buildParts(b, inventory);
  await countParts(p2, b, counter, {});
  assert.equal(p2.find((p) => p.id === 'msg.1.0')!.tokens, 777);
  assert.deepEqual(seen, { thinking: b.thinking, context_management: b.context_management });
});

test('detects the project directory from the environment reminder or the CLAUDE.md chain', () => {
  const env: RequestBody = { model: 'm', system: 'x', messages: [{ role: 'system', content: [{ type: 'text', text: '<system-reminder>\n# Environment\n - Primary working directory: /Users/me/proj/sub\n - Is a git repository: true\n</system-reminder>' }] }] };
  assert.equal(detectProjectDir(env), '/Users/me/proj/sub');
  const chain: RequestBody = { model: 'm', system: 'x', messages: [{ role: 'user', content: '<system-reminder>\nContents of /a/CLAUDE.md (project instructions, checked into the codebase):\n\nA\n\nContents of /a/b/c/CLAUDE.md (project instructions, checked into the codebase):\n\nC\n</system-reminder>' }] };
  assert.equal(detectProjectDir(chain), '/a/b/c');
  assert.equal(detectProjectDir({ model: 'm', system: 'nothing', messages: [] }), null);
});

test('attributes Read and Skill tool results to their files; labels subagent turns', async () => {
  const skill = inventory.sources[1];
  const b: RequestBody = {
    model: 'm',
    metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
    system: [{ type: 'text', text: inventory.sources[2].body + '\n\nExtra instructions from the harness for this subagent.' }],
    tools: [{ name: 'Read', description: 'r', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'go' },
      { role: 'assistant', content: [
        { type: 'tool_use', id: 'r1', name: 'Read', input: { file_path: '/p/CLAUDE.md' } },
        { type: 'tool_use', id: 'r2', name: 'Read', input: { file_path: '/p/.claude/skills/deploy/reference.md' } },
        { type: 'tool_use', id: 's1', name: 'Skill', input: { skill: 'deploy' } },
        { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'ls' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'r1', content: '     1\t# Project rules\n     2\t' },
        { type: 'tool_result', tool_use_id: 'r2', content: 'reference material' },
        { type: 'tool_result', tool_use_id: 's1', content: 'Launching skill: deploy\n\n' + skill.body },
        { type: 'tool_result', tool_use_id: 'b1', content: 'a\nb' },
      ] },
    ],
  };
  const invWithDir: Inventory = { ...inventory, sources: inventory.sources.map((s) => (s.id === 'sk1' ? { ...s, dir: '/p/.claude/skills/deploy' } : s)) };
  const a = (await analyzeRequest({ body: b, response: null }, invWithDir, null, null, {}))!;
  assert.equal(a.kind, 'main');
  assert.equal(a.label, 'subagent: researcher');
  assert.equal(a.agent, 'researcher');
  const res = (i: number) => a.parts.find((p) => p.id === `msg.2.${i}`)!;
  assert.equal(res(0).spans[0].sourceId, 'cm1');
  assert.equal(res(0).spans[0].match, 'tool-read');
  assert.equal(res(0).label, 'CLAUDE.md read: CLAUDE.md');
  assert.equal(res(1).spans[0].sourceId, 'sk1');
  assert.equal(res(1).spans[0].kind, 'file');
  const inv = res(2);
  assert.ok(inv.spans.every((s) => s.sourceId === 'sk1'));
  assert.ok(inv.spans.some((s) => s.match === 'exact'));
  assert.ok(inv.spans.some((s) => s.match === 'skill-invoke'));
  assert.equal(res(3).spans[0].kind, 'tool-result');
  assert.equal(res(3).label, 'tool result: Bash: ls');
  assert.equal(a.parts.find((p) => p.id === 'msg.1.0')!.label, 'tool call: Read: /p/CLAUDE.md');
  assert.ok(a.totals.sourceUsage.ag1.used);
});

test('requests from plain API clients are turns, not side calls', () => {
  const sdk: RequestBody = { model: 'm', system: 'Classify the commit message.', messages: [{ role: 'user', content: 'fix typo' }] };
  assert.equal(isClaudeCode(sdk), false);
  assert.deepEqual(classifyRequest(sdk), { kind: 'main', label: 'agent turn' });
  assert.equal(classifyRequest({ model: 'm', messages: [{ role: 'user', content: 'hello' }] }).kind, 'main');
  const cc: RequestBody = { model: 'm', metadata: { user_id: JSON.stringify({ session_id: 's1' }) }, messages: [{ role: 'user', content: 'hi' }] };
  assert.equal(isClaudeCode(cc), true);
  assert.equal(isClaudeCode({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: '<system-reminder>\nx\n</system-reminder>' }] }] }), true);
  const { parts } = buildParts({ ...sdk, tools: [{ name: 'lookup', description: 'look up', input_schema: { type: 'object' } }] }, inventory);
  const sys = parts.find((p) => p.id === 'sys.0')!;
  assert.equal(sys.label, 'system prompt');
  assert.equal(sys.spans[0].kind, 'user');
  assert.equal(parts.find((p) => p.id === 'tool.0')!.kind, 'user');
});

test('compaction is detected from the appended summary instruction, with tools present', () => {
  const b: RequestBody = {
    model: 'm',
    metadata: { user_id: JSON.stringify({ session_id: 's1' }) },
    system: [{ type: 'text', text: 'You are Claude Code.' }],
    tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'refactor the parser' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: [{ type: 'text', text: 'Your task is to create a detailed summary of the conversation so far.' }] },
    ],
  };
  assert.deepEqual(classifyRequest(b), { kind: 'side', label: 'compaction' });
  b.messages![2] = { role: 'user', content: 'summarize what changed' };
  assert.equal(classifyRequest(b).kind, 'main');
});

test('image and document blocks are counted as blocks, not as placeholder text', async () => {
  const pdf = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0x' } };
  const png = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0K' } };
  const b = {
    model: 'm',
    messages: [
      { role: 'user', content: [pdf, { type: 'text', text: 'Summarise the attached file.' }] },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.png' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'image follows' }, png] }] },
    ],
  } as unknown as RequestBody;
  const blocks: string[] = [];
  const fakeCounter: Counter = {
    ready: true,
    async countSystemBlocks() { return 0; },
    async countTools() { return 0; },
    async toolFraming() { return 0; },
    async countTool() { return 0; },
    async countText(_m, text) { return Math.ceil(text.length / 4); },
    async countMessageBlock(_m, _r, block) { blocks.push(block.type); return block.type === 'document' ? 1500 : block.type === 'image' ? 800 : 5; },
    async countThinkingBlock() { return 0; },
  };
  const { parts } = buildParts(b, { projectDir: '/p', scannedAt: 1, sources: [] });
  await countParts(parts, b, fakeCounter, {});
  assert.equal(parts.find((p) => p.id === 'msg.0.0')!.tokens, 1500);
  assert.ok(parts.find((p) => p.id === 'msg.2.0')!.tokens! >= 800);
  assert.ok(blocks.includes('document') && blocks.includes('image'));
});
