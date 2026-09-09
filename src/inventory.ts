// Scan a project (and the user's global Claude config) for every file Claude Code
// may inject into a request: CLAUDE.md chain, rules, skills, commands, agents,
// settings (hooks/permissions), MCP config, auto-memory, plugins.
import fs from 'node:fs';
import path from 'node:path';
import { readTextSafe, readJsonSafe, exists, walk, splitFrontmatter, claudeDir, homeDir, projectKey, sha } from './util.js';
import type { HookDef, Inventory, PublicSource, Scope, Source, SourceKind } from './types.js';

export interface KindInfo {
  label: string;
  color: string;
}

export const KINDS: Record<SourceKind, KindInfo> = {
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

function mkSource(kind: SourceKind, p: string, scope: Scope, extra: Partial<Source> = {}): Source | null {
  const content = readTextSafe(p);
  if (content == null) return null;
  const isMd = /\.md$/i.test(p);
  const { frontmatter, body } = isMd ? splitFrontmatter(content) : { frontmatter: {} as Record<string, string>, body: content };
  let mtime = 0;
  try {
    mtime = fs.statSync(p).mtimeMs;
  } catch {}
  return {
    id: sha(p).slice(0, 12),
    kind,
    path: p,
    scope,
    name: extra.name || path.basename(p),
    description: frontmatter.description || '',
    frontmatter,
    content,
    body,
    size: content.length,
    mtime,
    ...extra,
  };
}

const skillName = (skillMdPath: string): string => path.basename(path.dirname(skillMdPath));

// .claude/commands/a/b.md → a:b (Claude Code namespacing)
function commandName(baseDir: string, file: string): string {
  const rel = path.relative(baseDir, file).replace(/\.md$/i, '');
  return rel.split(path.sep).join(':');
}

function scanSkills(dir: string, scope: Scope, sources: Source[], prefix = ''): void {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 4, filter: (p) => path.basename(p) === 'SKILL.md' })) {
    const s = mkSource('skill', f, scope, { name: prefix + skillName(f), dir: path.dirname(f) });
    if (s) sources.push(s);
  }
}

function scanCommands(dir: string, scope: Scope, sources: Source[], prefix = ''): void {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 4, filter: (p) => /\.md$/i.test(p) })) {
    const s = mkSource('command', f, scope, { name: prefix + commandName(dir, f) });
    if (s) sources.push(s);
  }
}

function scanAgents(dir: string, scope: Scope, sources: Source[], prefix = ''): void {
  if (!exists(dir)) return;
  for (const f of walk(dir, { maxDepth: 3, filter: (p) => /\.md$/i.test(p) })) {
    const s = mkSource('agent', f, scope);
    if (s) {
      s.name = prefix + (s.frontmatter.name || path.basename(f, '.md'));
      sources.push(s);
    }
  }
}

interface SettingsJson {
  hooks?: Record<string, Array<{ matcher?: string; hooks?: Array<{ type?: string; command?: string; prompt?: string }> }>>;
  permissions?: unknown;
  enabledPlugins?: Record<string, boolean>;
  model?: string;
}

export function extractHooks(json: SettingsJson | null | undefined): HookDef[] {
  const hooks: HookDef[] = [];
  for (const [event, groups] of Object.entries((json && json.hooks) || {})) {
    for (const g of Array.isArray(groups) ? groups : []) {
      for (const h of g.hooks || []) {
        hooks.push({ event, matcher: g.matcher || '', type: h.type, command: h.command || h.prompt || '' });
      }
    }
  }
  return hooks;
}

function scanSettings(p: string, scope: Scope, sources: Source[]): void {
  if (!exists(p)) return;
  const s = mkSource('settings', p, scope);
  if (!s) return;
  const j = readJsonSafe<SettingsJson>(p) || {};
  s.hooks = extractHooks(j);
  s.permissions = j.permissions || null;
  s.enabledPlugins = j.enabledPlugins || null;
  s.model = j.model || null;
  sources.push(s);
}

// Claude Code turns an MCP server name into a tool prefix: mcp__<server>__<tool>
export function sanitizeMcp(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_');
}

function addMcp(p: string, scope: Scope, servers: unknown, sources: Source[], label?: string): void {
  if (!servers || typeof servers !== 'object') return;
  const rec = servers as Record<string, unknown>;
  const names = Object.keys(rec);
  if (!names.length) return;
  const s = mkSource('mcp', p, scope, { name: label || path.basename(p) });
  if (!s) return;
  s.servers = names.map((n) => ({ name: n, sanitized: sanitizeMcp(n), config: rec[n] }));
  sources.push(s);
}

interface PluginInstall {
  scope?: string;
  projectPath?: string;
  installPath?: string;
  version?: string;
}
interface PluginRegistry {
  plugins?: Record<string, PluginInstall | PluginInstall[]>;
}

function scanPlugins(projectDir: string, sources: Source[], enabledFromSettings: Record<string, boolean>): void {
  const cd = claudeDir();
  const reg = readJsonSafe<PluginRegistry>(path.join(cd, 'plugins', 'installed_plugins.json'));
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
      const mcp = readJsonSafe<{ mcpServers?: unknown }>(path.join(root, '.mcp.json'));
      if (mcp) addMcp(path.join(root, '.mcp.json'), 'plugin', mcp.mcpServers || mcp, sources, `${shortName} .mcp.json`);
    }
  }
}

export function scanInventory(projectDir: string): Inventory {
  projectDir = path.resolve(projectDir);
  const sources: Source[] = [];
  const cd = claudeDir();
  const home = homeDir();

  // CLAUDE.md chain: from filesystem root down to the project (Claude Code loads all of them)
  const chain: string[] = [];
  let cur = projectDir;
  for (;;) {
    chain.unshift(cur);
    const parent = path.dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  for (const dir of chain) {
    const scope: Scope = dir === projectDir ? 'project' : dir === home ? 'user' : 'parent';
    for (const name of ['CLAUDE.md', 'CLAUDE.local.md', path.join('.claude', 'CLAUDE.md')]) {
      const p = path.join(dir, name);
      if (exists(p)) {
        const s = mkSource('claude-md', p, scope);
        if (s) sources.push(s);
      }
    }
    const rulesDir = path.join(dir, '.claude', 'rules');
    if (exists(rulesDir)) {
      for (const f of walk(rulesDir, { maxDepth: 4, filter: (p) => /\.md$/i.test(p) })) {
        const s = mkSource('rules', f, scope);
        if (s) sources.push(s);
      }
    }
  }
  const userClaudeMd = path.join(cd, 'CLAUDE.md');
  if (exists(userClaudeMd)) {
    const s = mkSource('claude-md', userClaudeMd, 'user');
    if (s) sources.push(s);
  }

  scanSkills(path.join(projectDir, '.claude', 'skills'), 'project', sources);
  scanSkills(path.join(cd, 'skills'), 'user', sources);
  scanCommands(path.join(projectDir, '.claude', 'commands'), 'project', sources);
  scanCommands(path.join(cd, 'commands'), 'user', sources);
  scanAgents(path.join(projectDir, '.claude', 'agents'), 'project', sources);
  scanAgents(path.join(cd, 'agents'), 'user', sources);

  scanSettings(path.join(projectDir, '.claude', 'settings.json'), 'project', sources);
  scanSettings(path.join(projectDir, '.claude', 'settings.local.json'), 'project', sources);
  scanSettings(path.join(cd, 'settings.json'), 'user', sources);
  scanSettings(path.join(cd, 'settings.local.json'), 'user', sources);
  const enabledPlugins: Record<string, boolean> = {};
  for (const s of sources.filter((x) => x.kind === 'settings')) Object.assign(enabledPlugins, s.enabledPlugins || {});

  const projMcp = readJsonSafe<{ mcpServers?: unknown }>(path.join(projectDir, '.mcp.json'));
  if (projMcp) addMcp(path.join(projectDir, '.mcp.json'), 'project', projMcp.mcpServers || projMcp, sources, '.mcp.json');
  const globalJson = readJsonSafe<{ mcpServers?: unknown; projects?: Record<string, { mcpServers?: unknown }> }>(path.join(home, '.claude.json'));
  if (globalJson) {
    addMcp(path.join(home, '.claude.json'), 'user', globalJson.mcpServers, sources, '~/.claude.json mcpServers');
    const proj = globalJson.projects && globalJson.projects[projectDir];
    if (proj && proj.mcpServers) addMcp(path.join(home, '.claude.json'), 'project', proj.mcpServers, sources, '~/.claude.json projects[…].mcpServers');
  }

  const memDir = path.join(cd, 'projects', projectKey(projectDir), 'memory');
  if (exists(memDir)) {
    for (const f of walk(memDir, { maxDepth: 2, filter: (p) => /\.md$/i.test(p) })) {
      const s = mkSource('memory', f, 'user');
      if (s) sources.push(s);
    }
  }

  scanPlugins(projectDir, sources, enabledPlugins);

  const seen = new Set<string>();
  const out: Source[] = [];
  for (const s of sources) {
    const key = `${s.path}|${s.kind}|${s.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return { projectDir, scannedAt: Date.now(), sources: out };
}

// Paths that should trigger a rescan when they change.
export function watchRoots(projectDir: string): string[] {
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
export function publicSource(s: Source, { withContent = false }: { withContent?: boolean } = {}): PublicSource {
  const { content, body, ...rest } = s;
  return withContent ? { ...rest, content, body } : { ...rest, hasContent: true };
}
