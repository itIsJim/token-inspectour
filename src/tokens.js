// Token counting: exact via /v1/messages/count_tokens (using the auth headers of the
// captured Claude Code session), with an on-disk cache and a local estimate fallback.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { dataDir, sha } from './util.js';

// Rough local estimate (English prose / markdown / JSON mix). Labelled "≈" in the UI.
export function estimateTokens(text) {
  if (!text) return 0;
  const words = (text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || []).length;
  return Math.max(1, Math.round(Math.max(words * 1.15, text.length / 4.1)));
}

const FORWARD_HEADERS = [
  'authorization', 'x-api-key', 'anthropic-beta', 'anthropic-version', 'user-agent', 'x-app',
  'anthropic-dangerous-direct-browser-access',
];

export class TokenCounter {
  constructor({ upstream, concurrency = 2, persist = true, log = () => {} } = {}) {
    this.upstream = new URL(upstream || 'https://api.anthropic.com');
    this.concurrency = concurrency;
    this.log = log;
    this.auth = null; // headers captured from the latest real request
    this.cache = new Map();
    this.cachePath = persist ? path.join(dataDir(), 'token-cache.json') : null;
    this.queue = [];
    this.active = 0;
    this.inflight = new Map();
    this.enabled = true;
    this.stats = { calls: 0, hits: 0, errors: 0, lastError: null };
    this.#loadCache();
  }

  #loadCache() {
    if (!this.cachePath) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.cachePath, 'utf8'));
      for (const [k, v] of Object.entries(j)) this.cache.set(k, v);
    } catch {}
  }

  #saveCache() {
    if (!this.cachePath) return;
    clearTimeout(this._saveT);
    this._saveT = setTimeout(() => {
      try {
        fs.writeFileSync(this.cachePath, JSON.stringify(Object.fromEntries(this.cache)));
      } catch {}
    }, 500);
  }

  setAuthFromHeaders(headers) {
    const h = {};
    for (const k of FORWARD_HEADERS) if (headers[k]) h[k] = headers[k];
    if (h.authorization || h['x-api-key']) this.auth = h;
  }

  get ready() {
    return this.enabled && !!this.auth;
  }

  // Count a full request body (system/tools/messages/model). Returns input_tokens or null.
  async count(body) {
    const key = sha(JSON.stringify(body));
    if (this.cache.has(key)) {
      this.stats.hits++;
      return this.cache.get(key);
    }
    if (!this.ready) return null;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = new Promise((resolve) => {
      this.queue.push({ body, key, resolve });
      this.#pump();
    });
    this.inflight.set(key, p);
    p.finally(() => this.inflight.delete(key));
    return p;
  }

  #pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.#run(job)
        .then((n) => {
          if (n != null) {
            this.cache.set(job.key, n);
            this.#saveCache();
          }
          job.resolve(n);
        })
        .finally(() => {
          this.active--;
          this.#pump();
        });
    }
  }

  async #run(job, attempt = 0) {
    const payload = JSON.stringify(job.body);
    const res = await this.#post('/v1/messages/count_tokens?beta=true', payload).catch((e) => ({ status: 0, body: String(e) }));
    this.stats.calls++;
    if (res.status === 200) {
      try {
        return JSON.parse(res.body).input_tokens;
      } catch {
        return null;
      }
    }
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 4) {
      const wait = Math.min(8000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      return this.#run(job, attempt + 1);
    }
    this.stats.errors++;
    this.stats.lastError = `${res.status} ${String(res.body).slice(0, 300)}`;
    this.log(`count_tokens failed: ${this.stats.lastError}`);
    if (res.status === 401 || res.status === 403) this.auth = null;
    return null;
  }

  #post(pathname, payload) {
    return new Promise((resolve, reject) => {
      const mod = this.upstream.protocol === 'http:' ? http : https;
      const req = mod.request(
        {
          host: this.upstream.hostname,
          port: this.upstream.port || undefined,
          method: 'POST',
          path: pathname,
          headers: {
            ...this.auth,
            host: this.upstream.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'accept-encoding': 'identity',
          },
        },
        (r) => {
          const out = [];
          r.on('data', (c) => out.push(c));
          r.on('end', () => resolve({ status: r.statusCode, body: Buffer.concat(out).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  // --- helpers used by the analyzer ---------------------------------------
  async baseline(model) {
    return this.count({ model, messages: [{ role: 'user', content: '.' }] });
  }

  async countText(model, text) {
    if (!text) return 0;
    const [b, t] = await Promise.all([
      this.baseline(model),
      this.count({ model, messages: [{ role: 'user', content: text }] }),
    ]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b + 1);
  }

  async countSystemBlocks(model, blocks) {
    const [b, t] = await Promise.all([
      this.baseline(model),
      this.count({ model, system: blocks.map(stripCache), messages: [{ role: 'user', content: '.' }] }),
    ]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b);
  }

  // Tokens for a tool list including the tool-use framing the API adds once per request.
  async countTools(model, tools) {
    const [b, t] = await Promise.all([
      this.baseline(model),
      this.count({ model, tools: tools.map(stripCache), messages: [{ role: 'user', content: '.' }] }),
    ]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b);
  }

  // Framing cost: what a request with one (near-empty) tool costs beyond no tools at all.
  async toolFraming(model) {
    return this.countTools(model, [DUMMY_TOOL]);
  }

  // Marginal cost of a single tool definition (framing removed).
  async countTool(model, tool) {
    const [f, t] = await Promise.all([this.toolFraming(model), this.countTools(model, [tool])]);
    if (f == null || t == null) return null;
    return Math.max(0, t - f + DUMMY_TOOL_TOKENS);
  }

  async countMessageBlock(model, role, block) {
    // A lone assistant message is not a valid conversation start; wrap in a user turn.
    const msgs = role === 'assistant'
      ? [{ role: 'user', content: '.' }, { role: 'assistant', content: [stripCache(block)] }]
      : [{ role: 'user', content: [stripCache(block)] }];
    const base = role === 'assistant'
      ? this.count({ model, messages: [{ role: 'user', content: '.' }, { role: 'assistant', content: '.' }] })
      : this.baseline(model);
    const [b, t] = await Promise.all([base, this.count({ model, messages: msgs })]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b + 1);
  }
}

const DUMMY_TOOL = { name: 'x', description: '', input_schema: { type: 'object', properties: {} } };
const DUMMY_TOOL_TOKENS = 12; // approximate size of DUMMY_TOOL itself, folded back into the marginal

export function stripCache(o) {
  if (!o || typeof o !== 'object') return o;
  const { cache_control, ...rest } = o;
  return rest;
}
