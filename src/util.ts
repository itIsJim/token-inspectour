import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export const sha = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');
export const shortId = (): string => crypto.randomBytes(6).toString('hex');

export function readTextSafe(p: string, max = 4 * 1024 * 1024): string | null {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    if (st.size > max) return fs.readFileSync(p, 'utf8').slice(0, max);
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

/** Read a whole file. Capture records routinely exceed readTextSafe's cap, which truncates. */
export function readFileSafe(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

export function readJsonSafe<T = unknown>(p: string): T | null {
  const t = readTextSafe(p);
  if (t == null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export function exists(p: string): boolean {
  try {
    fs.accessSync(p);
    return true;
  } catch {
    return false;
  }
}

export function listDir(p: string): fs.Dirent[] {
  try {
    return fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return [];
  }
}

export interface WalkOptions {
  maxDepth?: number;
  filter?: (p: string) => boolean;
}

export function walk(dir: string, { maxDepth = 4, filter = () => true }: WalkOptions = {}, depth = 0, out: string[] = []): string[] {
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

export interface Frontmatter {
  frontmatter: Record<string, string>;
  body: string;
  raw: string;
}

// Split YAML-ish frontmatter from a markdown file (flat keys, quoted or folded scalars).
export function splitFrontmatter(text: string): Frontmatter {
  if (!text || !text.startsWith('---')) return { frontmatter: {}, body: text || '', raw: '' };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { frontmatter: {}, body: text, raw: '' };
  const raw = text.slice(3, end).trim();
  const afterEnd = text.indexOf('\n', end + 4);
  const body = afterEnd === -1 ? '' : text.slice(afterEnd + 1);
  const frontmatter: Record<string, string> = {};
  let curKey: string | null = null;
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

export const homeDir = (): string => process.env.HOME || os.homedir();
export const claudeDir = (): string => process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), '.claude');

export function dataDir(): string {
  const d = process.env.TOKEN_INSPECTOUR_HOME || path.join(homeDir(), '.token-inspectour');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Claude Code's project-dir sanitisation for ~/.claude/projects/<key>
export function projectKey(projectDir: string): string {
  return projectDir.replace(/[^A-Za-z0-9]/g, '-');
}

export type Headers = Record<string, string | string[] | undefined>;

export function redactHeaders(h: Headers | undefined): Headers {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^(authorization|x-api-key|cookie|proxy-authorization)$/i.test(k)) out[k] = '<redacted>';
    else out[k] = v;
  }
  return out;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
