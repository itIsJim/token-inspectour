import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const sha = (s) => crypto.createHash('sha1').update(s).digest('hex');
export const shortId = () => crypto.randomBytes(6).toString('hex');

export function readTextSafe(p, max = 4 * 1024 * 1024) {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > max) return fs.readFileSync(p, 'utf8').slice(0, max);
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonSafe(p) {
  const t = readTextSafe(p);
  if (t == null) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

export function exists(p) {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDir(p) {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export function walk(dir, { maxDepth = 4, filter = () => true } = {}, depth = 0, out = []) {
  if (depth > maxDepth) return out;
  for (const e of listDir(dir)) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name.startsWith('.git')) continue;
      walk(full, { maxDepth, filter }, depth + 1, out);
    } else if (e.isFile() && filter(full)) out.push(full);
  }
  return out;
}

// Split YAML-ish frontmatter from a markdown file.
export function splitFrontmatter(text) {
  if (!text || !text.startsWith('---')) return { frontmatter: {}, body: text || '', raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text, raw: '' };
  const raw = text.slice(3, end).trim();
  const afterEnd = text.indexOf('\n', end + 4);
  const body = afterEnd === -1 ? '' : text.slice(afterEnd + 1);
  const frontmatter = {};
  let curKey = null;
  for (const line of raw.split('\n')) {
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (m) {
      curKey = m[1];
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (v === '|' || v === '>' || v === '|-' || v === '>-') v = '';
      frontmatter[curKey] = v;
    } else if (curKey && /^\s+/.test(line)) {
      frontmatter[curKey] = (frontmatter[curKey] ? frontmatter[curKey] + '\n' : '') + line.trim();
    }
  }
  return { frontmatter, body, raw };
}

export const homeDir = () => process.env.HOME || os.homedir();
export const claudeDir = () => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');

export function dataDir() {
  const d = process.env.TOKEN_INSPECTOUR_HOME || path.join(homeDir(), '.token-inspectour');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Claude Code's project-dir sanitisation for ~/.claude/projects/<key>
export function projectKey(projectDir) {
  return projectDir.replace(/[^A-Za-z0-9]/g, '-');
}

export function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)) out[k] = '<redacted>';
    else out[k] = v;
  }
  return out;
}

export function nowIso() {
  return new Date().toISOString();
}

export function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
