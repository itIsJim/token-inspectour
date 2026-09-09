// In-memory + on-disk store of captured API calls, grouped by Claude Code session.
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { dataDir, readJsonSafe, listDir, nowIso } from './util.js';

export class Store extends EventEmitter {
  constructor({ persist = true } = {}) {
    super();
    this.persist = persist;
    this.sessions = new Map(); // sessionId -> { id, startedAt, requests: [] }
    this.requests = new Map(); // requestId -> request record
    this.seq = 0;
    this.dir = persist ? path.join(dataDir(), 'captures') : null;
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
  }

  load() {
    if (!this.dir) return;
    const files = [];
    for (const s of listDir(this.dir)) {
      if (!s.isDirectory()) continue;
      for (const f of listDir(path.join(this.dir, s.name))) {
        if (f.isFile() && f.name.endsWith('.json')) files.push(path.join(this.dir, s.name, f.name));
      }
    }
    files.sort();
    for (const f of files) {
      const rec = readJsonSafe(f);
      if (rec && rec.id) this.#add(rec, false);
    }
  }

  session(id, meta = {}) {
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

  #add(rec, emit = true) {
    const s = this.session(rec.sessionId, { startedAt: rec.startedAt, projectDir: rec.projectDir, projectDetected: rec.projectDetected, agent: rec.agent });
    if (!this.requests.has(rec.id)) {
      s.requests.push(rec.id);
      this.requests.set(rec.id, rec);
      this.seq = Math.max(this.seq, rec.seq || 0);
      if (emit) this.emit('request', rec);
    }
    return rec;
  }

  addRequest(rec) {
    rec.seq = ++this.seq;
    return this.#add(rec, true);
  }

  update(rec, event = 'update') {
    this.emit(event, rec);
    this.save(rec);
  }

  save(rec) {
    if (!this.dir) return;
    const d = path.join(this.dir, rec.sessionId.replace(/[^A-Za-z0-9_-]/g, '_'));
    fs.mkdirSync(d, { recursive: true });
    const p = path.join(d, `${String(rec.seq).padStart(5, '0')}-${rec.id}.json`);
    const { _auth, ...safe } = rec;
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(safe));
    fs.renameSync(tmp, p);
  }

  get(id) {
    return this.requests.get(id) || null;
  }

  listSessions() {
    return [...this.sessions.values()]
      .map((s) => ({
        id: s.id,
        startedAt: s.startedAt,
        projectDir: s.projectDir,
        agent: s.agent,
        label: s.label,
        requests: s.requests.map((rid) => summarize(this.requests.get(rid))).filter(Boolean),
      }))
      .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  clear() {
    this.sessions.clear();
    this.requests.clear();
    this.seq = 0;
    if (this.dir) fs.rmSync(this.dir, { recursive: true, force: true });
    if (this.dir) fs.mkdirSync(this.dir, { recursive: true });
    this.emit('cleared');
  }
}

export function summarize(rec) {
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
