// Index of captured API calls, grouped by Claude Code session, backed by the capture files.
//
// Resident memory is bounded and does not grow with how much history is on disk. The index
// holds one small RequestSummary per captured call; the full record (request body, assembled
// response, analysis) stays in its capture file and is read back on demand into a
// byte-bounded LRU cache. Each session directory carries an index.jsonl of those summaries,
// so start-up reads summaries instead of parsing every capture file.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dataDir, readFileSafe, listDir, nowIso, sha } from './util.js';
import type { CaptureRecord, RequestSummary, Session, SessionSummary } from './types.js';

export type StoreEvent = 'session' | 'request' | 'response' | 'analysis' | 'update' | 'cleared';

const INDEX_FILE = 'index.jsonl';
const DEFAULT_CACHE_MB = 128;

interface SessionMeta {
  startedAt?: string;
  projectDir?: string | null;
  projectDetected?: boolean;
  agent?: string | null;
  label?: string | null;
}

/** One call's resident state: its summary, where the full record lives, and what it costs to hold. */
interface IndexEntry {
  summary: RequestSummary;
  /** Capture file name inside the session directory; null until the record is first saved. */
  file: string | null;
  projectDetected: boolean;
  /** Serialized size of the record, used as the cache budget unit. */
  bytes: number;
}

/** One line of index.jsonl. */
interface IndexLine {
  s: RequestSummary;
  f: string | null;
  d?: boolean;
  b?: number;
}

export const sessionKey = (sessionId: string): string => sessionId.replace(/[^A-Za-z0-9_-]/g, '_');

const captureFile = (rec: Pick<CaptureRecord, 'id' | 'seq'>): string => `${String(rec.seq).padStart(5, '0')}-${rec.id}.json`;

function cacheBudget(): number {
  const mb = Number(process.env.TOKEN_INSPECTOUR_CACHE_MB);
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_CACHE_MB) * 1024 * 1024;
}

function readRecord(p: string): CaptureRecord | null {
  const text = readFileSafe(p);
  if (text == null) return null;
  try {
    const rec = JSON.parse(text) as CaptureRecord;
    return rec && rec.id ? rec : null;
  } catch {
    return null;
  }
}

function writeAtomic(p: string, text: string): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, p);
}

const indexLine = (e: IndexEntry): string => JSON.stringify({ s: e.summary, f: e.file, d: e.projectDetected, b: e.bytes } satisfies IndexLine) + '\n';

export class Store extends EventEmitter {
  readonly persist: boolean;
  readonly sessions = new Map<string, Session>();
  /** Summaries of every known call, in capture order. */
  readonly index = new Map<string, IndexEntry>();
  /** Full records, most recently used last; bounded by `cacheBytes` when there is a disk to reload from. */
  private readonly cache = new Map<string, CaptureRecord>();
  /** Calls captured by this process that are still in flight, and must not be evicted. */
  private readonly live = new Set<string>();
  readonly cacheBytes: number;
  seq = 0;
  readonly dir: string | null;

  constructor({ persist = true, cacheBytes = cacheBudget() }: { persist?: boolean; cacheBytes?: number } = {}) {
    super();
    this.persist = persist;
    this.cacheBytes = cacheBytes;
    this.dir = persist ? path.join(dataDir(), 'captures') : null;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  load(): void {
    if (!this.dir) return;
    for (const d of listDir(this.dir)) {
      if (d.isDirectory()) this.loadSession(path.join(this.dir, d.name));
    }
  }

  /** Read one session directory's index, pick up any capture file the index does not cover. */
  private loadSession(dir: string): void {
    const entries = new Map<string, IndexEntry>();
    const text = readFileSafe(path.join(dir, INDEX_FILE));
    let lines = 0;
    for (const line of text ? text.split('\n') : []) {
      if (!line) continue;
      lines++;
      try {
        const v = JSON.parse(line) as IndexLine;
        // later lines supersede earlier ones: a call is appended again on every update
        if (v && v.s && v.s.id) entries.set(v.s.id, { summary: v.s, file: v.f ?? null, projectDetected: !!v.d, bytes: v.b || 0 });
      } catch {
        // a torn trailing line from an interrupted append: the capture file scan recovers it
      }
    }
    const known = new Set<string>();
    for (const e of entries.values()) if (e.file) known.add(e.file);
    let recovered = 0;
    for (const f of listDir(dir)) {
      if (!f.isFile() || !f.name.endsWith('.json') || known.has(f.name)) continue;
      const p = path.join(dir, f.name);
      const rec = readRecord(p);
      const summary = summarize(rec);
      if (!rec || !summary) continue;
      recovered++;
      let bytes = 0;
      try {
        bytes = fs.statSync(p).size;
      } catch {}
      entries.set(rec.id, { summary, file: f.name, projectDetected: !!rec.projectDetected, bytes });
    }
    const ordered = [...entries.values()].sort((a, b) => (a.summary.seq || 0) - (b.summary.seq || 0) || (a.file || '').localeCompare(b.file || ''));
    for (const e of ordered) this.addEntry(e);
    // one line per call again, dropping superseded lines and adding recovered ones
    if (recovered || lines > entries.size) this.writeIndex(dir, ordered);
  }

  private writeIndex(dir: string, entries: IndexEntry[]): void {
    try {
      writeAtomic(path.join(dir, INDEX_FILE), entries.map(indexLine).join(''));
    } catch {}
  }

  private addEntry(e: IndexEntry): void {
    const s = e.summary;
    const sess = this.session(s.sessionId, { startedAt: s.startedAt, projectDir: s.projectDir, projectDetected: e.projectDetected, agent: s.agent });
    if (this.index.has(s.id)) return;
    this.index.set(s.id, e);
    sess.requests.push(s.id);
    this.seq = Math.max(this.seq, s.seq || 0);
  }

  session(id: string, meta: SessionMeta = {}): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { id, startedAt: meta.startedAt || nowIso(), projectDir: meta.projectDir || null, agent: meta.agent || null, requests: [], label: meta.label || null };
      this.sessions.set(id, s);
      this.emit('session', s);
    }
    if (meta.projectDir && (!s.projectDir || meta.projectDetected)) s.projectDir = meta.projectDir;
    if (meta.agent && !s.agent) s.agent = meta.agent;
    return s;
  }

  addRequest(rec: CaptureRecord): CaptureRecord {
    rec.seq = ++this.seq;
    this.session(rec.sessionId, { startedAt: rec.startedAt, projectDir: rec.projectDir, projectDetected: rec.projectDetected, agent: rec.agent });
    if (!this.index.has(rec.id)) {
      this.sessions.get(rec.sessionId)!.requests.push(rec.id);
      this.live.add(rec.id);
      this.reindex(rec, null, rec.bytesIn || 0);
      this.hold(rec);
      this.emit('request', rec);
    }
    return rec;
  }

  update(rec: CaptureRecord, event: StoreEvent = 'update'): void {
    this.hold(rec);
    this.emit(event, rec);
    this.save(rec);
  }

  save(rec: CaptureRecord): void {
    const { _auth: _a, _analyzing: _b, ...safe } = rec;
    const text = JSON.stringify(safe);
    if (!this.dir) {
      this.reindex(rec, null, text.length);
      return;
    }
    const dir = path.join(this.dir, sessionKey(rec.sessionId));
    fs.mkdirSync(dir, { recursive: true });
    const name = captureFile(rec);
    writeAtomic(path.join(dir, name), text);
    const e = this.reindex(rec, name, text.length);
    try {
      fs.appendFileSync(path.join(dir, INDEX_FILE), indexLine(e));
    } catch {}
  }

  /** Refresh a call's resident summary from the full record. */
  private reindex(rec: CaptureRecord, file: string | null, bytes: number): IndexEntry {
    const e = this.index.get(rec.id);
    const summary = summarize(rec)!;
    if (e) {
      e.summary = summary;
      e.projectDetected = !!rec.projectDetected;
      e.bytes = bytes;
      if (file) e.file = file;
      return e;
    }
    const added: IndexEntry = { summary, file, projectDetected: !!rec.projectDetected, bytes };
    this.index.set(rec.id, added);
    return added;
  }

  get(id: string): CaptureRecord | null {
    const hit = this.cache.get(id);
    if (hit) {
      this.cache.delete(id);
      this.cache.set(id, hit);
      return hit;
    }
    const e = this.index.get(id);
    if (!e || !e.file || !this.dir) return null;
    const p = path.join(this.dir, sessionKey(e.summary.sessionId), e.file);
    const rec = readRecord(p);
    if (!rec) return null;
    try {
      e.bytes = fs.statSync(p).size;
    } catch {}
    // the index carries the current project, which a later call in the session can change
    rec.projectDir = e.summary.projectDir || undefined;
    rec.projectDetected = e.projectDetected;
    this.hold(rec);
    return rec;
  }

  /** Resident summaries of one session's calls, in capture order. */
  summaries(sessionId: string): RequestSummary[] {
    const s = this.sessions.get(sessionId);
    if (!s) return [];
    return s.requests.map((id) => this.index.get(id)?.summary).filter((x): x is RequestSummary => !!x);
  }

  /** One session's full records, read back one at a time so a long session never has to fit in memory.
   *  `filter` selects on the resident summary, so unwanted records are never read. */
  *records(sessionId: string, filter?: (s: RequestSummary) => boolean): Generator<CaptureRecord> {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    for (const id of [...s.requests]) {
      const e = this.index.get(id);
      if (!e || (filter && !filter(e.summary))) continue;
      const rec = this.get(id);
      if (rec) yield rec;
    }
  }

  /** Point a session and the calls captured before its project was known at `dir`. */
  repointProject(sessionId: string, dir: string): void {
    const s = this.sessions.get(sessionId);
    if (!s) return;
    s.projectDir = dir;
    const entries: IndexEntry[] = [];
    let changed = false;
    for (const id of s.requests) {
      const e = this.index.get(id);
      if (!e) continue;
      entries.push(e);
      if (e.projectDetected || e.summary.projectDir === dir) continue;
      e.summary.projectDir = dir;
      const held = this.cache.get(id);
      if (held) held.projectDir = dir;
      changed = true;
    }
    if (changed && this.dir) this.writeIndex(path.join(this.dir, sessionKey(sessionId)), entries);
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        projectDir: s.projectDir,
        agent: s.agent,
        label: s.label,
        requests: s.requests.map((rid) => this.index.get(rid)?.summary).filter((x): x is RequestSummary => !!x),
      }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  clear(): void {
    this.sessions.clear();
    this.index.clear();
    this.cache.clear();
    this.live.clear();
    this.seq = 0;
    if (this.dir) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.emit('cleared');
  }

  /** Bytes of full records currently held. */
  get heldBytes(): number {
    let used = 0;
    for (const id of this.cache.keys()) used += this.index.get(id)?.bytes || 0;
    return used;
  }

  get heldCount(): number {
    return this.cache.size;
  }

  private hold(rec: CaptureRecord): void {
    this.cache.delete(rec.id);
    this.cache.set(rec.id, rec);
    this.evict();
  }

  /** A call being captured or analysed right now is still being written to: keep it. */
  private pinned(rec: CaptureRecord): boolean {
    if (rec._analyzing) return true;
    if (!this.live.has(rec.id)) return false;
    if (rec.status == null) return true;
    this.live.delete(rec.id);
    return false;
  }

  private evict(): void {
    // without a disk to read back from, the cache is the only copy
    if (!this.dir) return;
    let used = this.heldBytes;
    if (used <= this.cacheBytes) return;
    for (const [id, rec] of this.cache) {
      if (used <= this.cacheBytes || this.cache.size <= 1) break;
      if (this.pinned(rec)) continue;
      this.cache.delete(id);
      used -= this.index.get(id)?.bytes || 0;
    }
  }
}

/** Text of a request's first message (cache_control and non-text blocks ignored). */
export function firstMessageText(rec: Pick<CaptureRecord, 'body'>): string {
  const m = rec.body?.messages?.[0];
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  return (m.content || []).map((b) => (b.type === 'text' ? (b as { text?: string }).text || '' : '')).join('\n');
}

/** Every turn of one conversation (main agent, a parallel loop, one subagent instance) resends the
 *  same first message, so its hash identifies the thread. Cached on the record. */
export function threadKey(rec: CaptureRecord): string | null {
  if (rec.thread !== undefined) return rec.thread;
  const text = firstMessageText(rec);
  rec.thread = text ? sha(text).slice(0, 12) : null;
  return rec.thread;
}

export function summarize(rec: CaptureRecord | undefined | null): RequestSummary | null {
  if (!rec) return null;
  const u = (rec.response && rec.response.usage) || {};
  return {
    id: rec.id,
    seq: rec.seq,
    sessionId: rec.sessionId,
    agent: rec.agent || null,
    projectDir: rec.projectDir || null,
    startedAt: rec.startedAt,
    endedAt: rec.endedAt,
    durationMs: rec.durationMs,
    ttfbMs: rec.ttfbMs,
    status: rec.status,
    kind: rec.kind,
    model: rec.model,
    stream: rec.stream,
    path: rec.path,
    bytesIn: rec.bytesIn,
    bytesOut: rec.bytesOut,
    toolCount: rec.toolCount,
    messageCount: rec.messageCount,
    stopReason: rec.response ? rec.response.stop_reason : null,
    error: rec.error || (rec.response && rec.response.error) || null,
    usage: {
      input: u.input_tokens ?? null,
      cacheRead: u.cache_read_input_tokens ?? null,
      cacheWrite: u.cache_creation_input_tokens ?? null,
      output: u.output_tokens ?? null,
    },
    userPreview: rec.userPreview || '',
    assistantPreview: rec.assistantPreview || '',
    thread: threadKey(rec),
    analysis: rec.analysis ? { totals: rec.analysis.totals, counted: rec.analysis.counted, exactTotal: rec.analysis.exactTotal } : null,
  };
}
