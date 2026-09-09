import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { scanInventory, sanitizeMcp, extractHooks } from '../src/inventory.js';
import { splitFrontmatter, projectKey } from '../src/util.js';

function tmpProject() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-'));
  const proj = path.join(root, 'parent', 'proj');
  fs.mkdirSync(path.join(proj, '.claude', 'skills', 'deploy'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'commands', 'ops'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'agents'), { recursive: true });
  fs.mkdirSync(path.join(proj, '.claude', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(root, 'parent', 'CLAUDE.md'), '# parent rules');
  fs.writeFileSync(path.join(proj, 'CLAUDE.md'), '# project rules');
  fs.writeFileSync(path.join(proj, '.claude', 'rules', 'style.md'), 'be nice');
  fs.writeFileSync(path.join(proj, '.claude', 'skills', 'deploy', 'SKILL.md'), '---\nname: deploy\ndescription: Deploy the app\n---\nDo the deploy.');
  fs.writeFileSync(path.join(proj, '.claude', 'commands', 'ops', 'restart.md'), 'restart things');
  fs.writeFileSync(path.join(proj, '.claude', 'agents', 'researcher.md'), '---\nname: researcher\ndescription: researches\n---\nYou research.');
  fs.writeFileSync(path.join(proj, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] }, permissions: { allow: ['Bash(ls:*)'] } }));
  fs.writeFileSync(path.join(proj, '.mcp.json'), JSON.stringify({ mcpServers: { 'my db': { command: 'x' } } }));
  return { root, proj };
}

test('scans the CLAUDE.md chain, rules, skills, namespaced commands, agents, hooks and MCP', () => {
  const { root, proj } = tmpProject();
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const prevHome = process.env.HOME;
  const prevCfg = process.env.CLAUDE_CONFIG_DIR;
  process.env.HOME = home;
  process.env.CLAUDE_CONFIG_DIR = path.join(home, '.claude');
  try {
    const inv = scanInventory(proj);
    const by = (kind) => inv.sources.filter((s) => s.kind === kind);
    assert.deepEqual(by('claude-md').map((s) => s.scope), ['parent', 'project']);
    assert.equal(by('rules').length, 1);
    const sk = by('skill')[0];
    assert.equal(sk.name, 'deploy');
    assert.equal(sk.description, 'Deploy the app');
    assert.equal(sk.body, 'Do the deploy.');
    assert.equal(by('command')[0].name, 'ops:restart');
    assert.equal(by('agent')[0].name, 'researcher');
    const st = by('settings')[0];
    assert.equal(st.hooks[0].event, 'PreToolUse');
    assert.equal(st.hooks[0].matcher, 'Bash');
    const mcp = by('mcp')[0];
    assert.equal(mcp.servers[0].sanitized, 'my_db');
  } finally {
    process.env.HOME = prevHome;
    if (prevCfg === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prevCfg;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('helpers', () => {
  assert.equal(sanitizeMcp('claude.ai Gmail'), 'claude_ai_Gmail');
  assert.equal(projectKey('/Users/x/Desktop/my proj'), '-Users-x-Desktop-my-proj');
  const fm = splitFrontmatter('---\nname: a\ndescription: "quoted"\n---\nbody here');
  assert.equal(fm.frontmatter.description, 'quoted');
  assert.equal(fm.body, 'body here');
  assert.deepEqual(extractHooks({}), []);
});
