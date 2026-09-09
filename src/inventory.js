// Scan a project (and the user's global Claude config) for every file Claude Code
// may inject into a request: CLAUDE.md chain, rules, skills, commands, agents,
// settings (hooks/permissions), MCP config, auto-memory, plugins.
import fs from 'node:fs';
import path from 'node:path';
import {
  readTextSafe, readJsonSafe, exists, walk, splitFrontmatter,
  claudeDir, homeDir, projectKey, sha,
} from './util.js';

export const KINDS = {
  'claude-md': { label: 'CLAUDE.md', color: '#d97706' },
  rules: { label: 'Rules', color: '#b45309' },
  skill: { label: 'Skill', color: '#7c3aed' },
  command: { label: 'Command', color: '#9333ea' },
  agent: { label: 'Agent', color: '#0891b2' },
  settings: { label: 'Settings / hooks', color: '#dc2626' },
  hook: { label: 'Hook output', color: '#e11d48' },
  mcp: { label: 'MCP', color: '#059669' },
  'mcp-remote': { label: 'MCP (claude.ai connector)', color: '#10b981' },
  memory: { label: 'Auto-memory', color: '#ca8a04' },
  plugin: { label: 'Plugin', color: '#4f46e5' },
  harness: { label: 'Harness (built-in)', color: '#64748b' },
  'harness-tool': { label: 'Built-in tool', color: '#475569' },
  reminder: { label: 'System reminder', color: '#f97316' },
  user: { label: 'User', color: '#2563eb' },
  model: { label: 'Model output', color: '#16a34a' },
  'tool-result': { label: 'Tool result', color: '#0d9488' },
  file: { label: 'Project file', color: '#94a3b8' },
};

function mkSource(kind, p, scope, extra = {}) {
  const content = readTextSafe(p);
  if (content == null) return null;
  const isMd = /\.md$/i.test(p);
  const { frontmatter, body } = isMd ? splitFrontmatter(content) : { frontmatter: {}, body: content };
  let st = null;
  try {
    st = fs.statSync(p);
  } catch {}
  return {
    id: sha(p).slice(0, 12),
    kind,
    path: p,
    scope, // project | parent | user | plugin | remote
    name: extra.name || path.basename(p),
    description: frontmatter.description || '',
    frontmatter,
    content,
    body,
    size: content.length,
    mtime: st ? st.mtimeMs : 0,
    ...extra,
  };
}

function skillName(skillMdPath) {
  return path.basename(path.dirname(skillMdPath));
}

function commandName(baseDir, file) {
  // .claude/commands/a/b.md → a:b   (Claude Code namespacing)
  const rel = path.relative(baseDir, file).replace(/\.md$/i, '');
  return rel.split(path.sep).join(':');
}

function scanSkills(dir, scope, sources, prefix = '') {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 4, filter: (p) => path.basename(p) === 'SKILL.md' })) {
    const s = mkSource('skill', f, scope, { name: prefix + skillName(f), dir: path.dirname(f) });
    if (s) sources.push(s);
  }
}

function scanCommands(dir, scope, sources, prefix = '') {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 4, filter: (p) => /\.md$/i.test(p) })) {
    const s = mkSource('command', f, scope, { name: prefix + commandName(dir, f) });
    if (s) sources.push(s);
  }
}

function scanAgents(dir, scope, sources, prefix = '') {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 3, filter: (p) => /\.md$/i.test(p) })) {
    const s = mkSource('agent', f, scope, {});
    if (s) {
      s.name = prefix + (s.frontmatter.name || path.basename(f, '.md'));
      sources.push(s);
    }
  }
}

export function extractHooks(json) {
  const hooks = [];
  for (const [event, groups] of Object.entries((json && json.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) {
        hooks.push({ event, matcher: g.matcher || '', type: h.type, command: h.command || h.prompt || '' });
      }
    }
  }
  return hooks;
}

function scanSettings(p, scope, sources) {
  if (!exists(p)) return;
  const s = mkSource('settings', p, scope, {});
  if (!s) return;
  const j = readJsonSafe(p) || {};
  s.hooks = extractHooks(j);
  s.permissions = j.permissions || null;
  s.enabledPlugins = j.enabledPlugins || null;
  s.model = j.model || null;
  sources.push(s);
}

function addMcp(p, scope, servers, sources, label) {
  if (!servers || typeof servers !== 'object') return;
  const names = Object.keys(servers);
  if (!names.length) return;
  const s = mkSource('mcp', p, scope, { name: label || path.basename(p) });
  if (!s) return;
  s.servers = names.map((n) => ({ name: n, sanitized: sanitizeMcp(n), config: servers[n] }));
  sources.push(s);
}

// Claude Code turns an MCP server name into a tool prefix: mcp__<server>__<tool>
export function sanitizeMcp(name) {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function scanPlugins(projectDir, sources, enabledFromSettings) {
  const cd = claudeDir();
  const reg = readJsonSafe(path.join(cd, 'plugins', 'installed_plugins.json'));
  if (!reg || !reg.plugins) return;
  for (const [fullName, installs] of Object.entries(reg.plugins)) {
    for (const inst of Array.isArray(installs) ? installs : [installs]) {
      const scopedToOther = inst.scope === 'local' && inst.projectPath && path.resolve(inst.projectPath) !== path.resolve(projectDir);
      if (scopedToOther) continue;
      const enabled = enabledFromSettings[fullName];
      if (enabled === false) continue;
      const root = inst.installPath;
      if (!root || !exists(root)) continue;
      const shortName = fullName.split('@')[0];
      const prefix = `${shortName}:`;
      const manifest = path.join(root, '.claude-plugin', 'plugin.json');
      const m = mkSource('plugin', exists(manifest) ? manifest : root, 'plugin', { name: shortName, plugin: fullName, version: inst.version, enabled: enabled === true });
      if (m) sources.push(m);
      scanSkills(path.join(root, 'skills'), 'plugin', sources, prefix);
      scanCommands(path.join(root, 'commands'), 'plugin', sources, prefix);
      scanAgents(path.join(root, 'agents'), 'plugin', sources, prefix);
      const hooksFile = path.join(root, 'hooks', 'hooks.json');
      if (exists(hooksFile)) scanSettings(hooksFile, 'plugin', sources);
      const mcp = readJsonSafe(path.join(root, '.mcp.json'));
      if (mcp) addMcp(path.join(root, '.mcp.json'), 'plugin', mcp.mcpServers || mcp, sources, `${shortName} .mcp.json`);
    }
  }
}

export function scanInventory(projectDir) {
  projectDir = path.resolve(projectDir);
  const sources = [];
  const cd = claudeDir();
  const home = homeDir();

  // --- CLAUDE.md chain: from filesystem root down to project (Claude Code loads all of them)
  const chain = [];
  let cur = projectDir;
  while (true) {
    chain.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const dir of chain) {
    const scope = dir === projectDir ? 'project' : dir === home ? 'user' : 'parent';
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
      const p = path.join(dir, name);
      if (exists(p)) {
        const s = mkSource('claude-md', p, scope, {});
        if (s) sources.push(s);
      }
    }
    const rulesDir = path.join(dir, '.claude', 'rules');
    if (exists(rulesDir)) {
      for (const f of walk(rulesDir, { maxDepth: 4, filter: (p) => /\.md$/i.test(p) })) {
        const s = mkSource('rules', f, scope, {});
        if (s) sources.push(s);
      }
    }
  }
  const userClaudeMd = path.join(cd, 'CLAUDE.md');
  if (exists(userClaudeMd)) {
    const s = mkSource('claude-md', userClaudeMd, 'user', {});
    if (s) sources.push(s);
  }

  // --- skills / commands / agents (project + user)
  scanSkills(path.join(projectDir, '.claude', 'skills'), 'project', sources);
  scanSkills(path.join(cd, 'skills'), 'user', sources);
  scanCommands(path.join(projectDir, '.claude', 'commands'), 'project', sources);
  scanCommands(path.join(cd, 'commands'), 'user', sources);
  scanAgents(path.join(projectDir, '.claude', 'agents'), 'project', sources);
  scanAgents(path.join(cd, 'agents'), 'user', sources);

  // --- settings (hooks, permissions, plugins)
  scanSettings(path.join(projectDir, '.claude', 'settings.json'), 'project', sources);
  scanSettings(path.join(projectDir, '.claude', 'settings.local.json'), 'project', sources);
  scanSettings(path.join(cd, 'settings.json'), 'user', sources);
  scanSettings(path.join(cd, 'settings.local.json'), 'user', sources);
  const enabledPlugins = {};
  for (const s of sources.filter((x) => x.kind === 'settings')) Object.assign(enabledPlugins, s.enabledPlugins || {});

  // --- MCP config
  const projMcp = readJsonSafe(path.join(projectDir, '.mcp.json'));
  if (projMcp) addMcp(path.join(projectDir, '.mcp.json'), 'project', projMcp.mcpServers || projMcp, sources, '.mcp.json');
  const globalJson = readJsonSafe(path.join(home, '.claude.json'));
  if (globalJson) {
    addMcp(path.join(home, '.claude.json'), 'user', globalJson.mcpServers, sources, '~/.claude.json mcpServers');
    const proj = globalJson.projects && globalJson.projects[projectDir];
    if (proj && proj.mcpServers) addMcp(path.join(home, '.claude.json'), 'project', proj.mcpServers, sources, '~/.claude.json projects[…].mcpServers');
  }

  // --- auto-memory
  const memDir = path.join(cd, 'projects', projectKey(projectDir), 'memory');
  if (exists(memDir)) {
    for (const f of walk(memDir, { maxDepth: 2, filter: (p) => /\.md$/i.test(p) })) {
      const s = mkSource('memory', f, 'user', {});
      if (s) sources.push(s);
    }
  }

  // --- plugins
  scanPlugins(projectDir, sources, enabledPlugins);

  // de-dup by path (a plugin may be listed twice)
  const seen = new Set();
  const out = [];
  for (const s of sources) {
    const key = s.path + '|' + s.kind + '|' + s.name;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return { projectDir, scannedAt: Date.now(), sources: out };
}

// Paths that should trigger a rescan when they change.
export function watchRoots(projectDir) {
  const cd = claudeDir();
  const roots = [
    path.join(projectDir, '.claude'),
    path.join(projectDir, 'CLAUDE.md'),
    path.join(projectDir, 'CLAUDE.local.md'),
    path.join(projectDir, '.mcp.json'),
    path.join(cd, 'skills'),
    path.join(cd, 'commands'),
    path.join(cd, 'agents'),
    path.join(cd, 'CLAUDE.md'),
    path.join(cd, 'settings.json'),
    path.join(cd, 'projects', projectKey(projectDir), 'memory'),
  ];
  return roots.filter(exists);
}

// Public view: strip bulky content unless withContent is set.
export function publicSource(s, { withContent = false } = {}) {
  const { content, body, ...rest } = s;
  return withContent ? { ...rest, content, body } : { ...rest, hasContent: true };
}
