// In-memory + on-disk store of captured API calls, grouped by Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dataDir, readJsonSafe, listDir, nowIso } from './util.js';
import type { CaptureRecord, RequestSummary, Session, SessionSummary } from './types.js';

export type StoreEvent = 'session' | 'request' | 'response' | 'analysis' | 'update' | 'cleared';

interface SessionMeta {
  startedAt?: string;
  projectDir?: string | null;
  projectDetected?: boolean;
  agent?: string | null;
  label?: string | null;
}

export class Store extends EventEmitter {
  readonly persist: boolean;
  readonly sessions = new Map<string, Session>();
  readonly requests = new Map<string, CaptureRecord>();
  seq = 0;
  readonly dir: string | null;

  constructor({ persist = true }: { persist?: boolean } = {}) {
    super();
    this.persist = persist;
    this.dir = persist ? path.join(dataDir(), 'captures') : null;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  load(): void {
    if (!this.dir) return;
    const files: string[] = [];
    for (const s of listDir(this.dir)) {
      if (!s.isDirectory()) continue;
      for (const f of listDir(path.join(this.dir, s.name))) {
        if (f.isFile() && f.name.endsWith('.json')) files.push(path.join(this.dir, s.name, f.name));
      }
    }
    files.sort();
    for (const f of files) {
      const rec = readJsonSafe<CaptureRecord>(f);
      if (rec && rec.id) this.add(rec, false);
    }
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

  private add(rec: CaptureRecord, emit = true): CaptureRecord {
    const s = this.session(rec.sessionId, { startedAt: rec.startedAt, projectDir: rec.projectDir, projectDetected: rec.projectDetected, agent: rec.agent });
    if (!this.requests.has(rec.id)) {
      s.requests.push(rec.id);
      this.requests.set(rec.id, rec);
      this.seq = Math.max(this.seq, rec.seq || 0);
      if (emit) this.emit('request', rec);
    }
    return rec;
  }

  addRequest(rec: CaptureRecord): CaptureRecord {
    rec.seq = ++this.seq;
    return this.add(rec, true);
  }

  update(rec: CaptureRecord, event: StoreEvent = 'update'): void {
    this.emit(event, rec);
    this.save(rec);
  }

  save(rec: CaptureRecord): void {
    if (!this.dir) return;
    const d = path.join(this.dir, rec.sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `${String(rec.seq).padStart(5, '0')}-${rec.id}.json`);
    const { _auth: _a, _analyzing: _b, ...safe } = rec;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe));
    fs.renameSync(tmp, p);
  }

  get(id: string): CaptureRecord | null {
    return this.requests.get(id) || null;
  }

  listSessions(): SessionSummary[] {
    return [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        projectDir: s.projectDir,
        agent: s.agent,
        label: s.label,
        requests: s.requests.map((rid) => summarize(this.requests.get(rid))).filter((x): x is RequestSummary => x !== null),
      }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  clear(): void {
    this.sessions.clear();
    this.requests.clear();
    this.seq = 0;
    if (this.dir) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      fs.mkdirSync(this.dir, { recursive: true });
    }
    this.emit('cleared');
  }
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
    analysis: rec.analysis ? { totals: rec.analysis.totals, counted: rec.analysis.counted, exactTotal: rec.analysis.exactTotal } : null,
  };
}
