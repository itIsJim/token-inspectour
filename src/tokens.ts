// Token counting: exact via /v1/messages/count_tokens (using the auth headers of the
// captured Claude Code session), with an on-disk cache and a local estimate fallback.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { dataDir, sha, PRIVATE_FILE } from './util.js';
import type { Headers } from './util.js';
import type { ContentBlock, SystemBlock, ToolDef } from './types.js';

// Rough local estimate (English prose / markdown / JSON mix). Labelled "≈" in the UI.
export function estimateTokens(text: string): number {
  if (!text) return 0;
  const words = (text.match(/[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) || []).length;
  return Math.max(1, Math.round(Math.max(words * 1.15, text.length / 4.1)));
}

const FORWARD_HEADERS = [
  'authorization', 'x-api-key', 'anthropic-beta', 'anthropic-version', 'user-agent', 'x-app',
  'anthropic-dangerous-direct-browser-access',
];

const DUMMY_TOOL: ToolDef = { name: 'x', description: '', input_schema: { type: 'object', properties: {} } };
const DUMMY_TOOL_TOKENS = 12; // approximate size of DUMMY_TOOL itself, folded back into the marginal

export interface CounterStats {
  calls: number;
  hits: number;
  errors: number;
  lastError: string | null;
}

interface Job {
  body: unknown;
  key: string;
  resolve: (n: number | null) => void;
}

export interface TokenCounterOptions {
  upstream?: string;
  concurrency?: number;
  persist?: boolean;
  log?: (line: string) => void;
}

export class TokenCounter {
  readonly upstream: URL;
  readonly concurrency: number;
  private log: (line: string) => void;
  auth: Headers | null = null; // headers captured from the latest real request
  readonly cache = new Map<string, number>();
  private cachePath: string | null;
  readonly queue: Job[] = [];
  active = 0;
  private inflight = new Map<string, Promise<number | null>>();
  enabled = true;
  stats: CounterStats = { calls: 0, hits: 0, errors: 0, lastError: null };
  private saveTimer: NodeJS.Timeout | null = null;

  constructor({ upstream, concurrency = 2, persist = true, log = () => {} }: TokenCounterOptions = {}) {
    this.upstream = new URL(upstream || 'https://api.anthropic.com');
    this.concurrency = concurrency;
    this.log = log;
    this.cachePath = persist ? path.join(dataDir(), 'token-cache.json') : null;
    this.loadCache();
  }

  private loadCache(): void {
    if (!this.cachePath) return;
    try {
      const j = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Record<string, number>;
      for (const [k, v] of Object.entries(j)) this.cache.set(k, v);
    } catch {}
  }

  private saveCache(): void {
    if (!this.cachePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try {
        fs.writeFileSync(this.cachePath!, JSON.stringify(Object.fromEntries(this.cache)), { mode: PRIVATE_FILE });
      } catch {}
    }, 500);
  }

  setAuthFromHeaders(headers: Headers | undefined): void {
    if (!headers) return;
    const h: Headers = {};
    for (const k of FORWARD_HEADERS) if (headers[k]) h[k] = headers[k];
    if (h.authorization || h['x-api-key']) this.auth = h;
  }

  get ready(): boolean {
    return this.enabled && !!this.auth;
  }

  // Count a full request body (system/tools/messages/model). Returns input_tokens or null.
  async count(body: unknown): Promise<number | null> {
    const key = sha(JSON.stringify(body));
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.hits++;
      return cached;
    }
    if (!this.ready) return null;
    const pending = this.inflight.get(key);
    if (pending) return pending;
    const p = new Promise<number | null>((resolve) => {
      this.queue.push({ body, key, resolve });
      this.pump();
    });
    this.inflight.set(key, p);
    p.finally(() => this.inflight.delete(key));
    return p;
  }

  private pump(): void {
    while (this.active < this.concurrency && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      this.run(job)
        .then((n) => {
          if (n != null) {
            this.cache.set(job.key, n);
            this.saveCache();
          }
          job.resolve(n);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  private async run(job: Job, attempt = 0): Promise<number | null> {
    const payload = JSON.stringify(job.body);
    const res = await this.post('/v1/messages/count_tokens?beta=true', payload).catch((e: Error) => ({ status: 0, body: String(e) }));
    this.stats.calls++;
    if (res.status === 200) {
      try {
        return JSON.parse(res.body).input_tokens as number;
      } catch {
        return null;
      }
    }
    if ((res.status === 429 || res.status >= 500 || res.status === 0) && attempt < 4) {
      const wait = Math.min(8000, 500 * 2 ** attempt);
      await new Promise((r) => setTimeout(r, wait));
      return this.run(job, attempt + 1);
    }
    this.stats.errors++;
    this.stats.lastError = `${res.status} ${String(res.body).slice(0, 300)}`;
    this.log(`count_tokens failed: ${this.stats.lastError}`);
    if (res.status === 401 || res.status === 403) this.auth = null;
    return null;
  }

  private post(pathname: string, payload: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const mod = this.upstream.protocol === 'http:' ? http : https;
      const req = mod.request(
        {
          host: this.upstream.hostname,
          port: this.upstream.port || undefined,
          method: 'POST',
          path: pathname,
          headers: {
            ...(this.auth as Record<string, string>),
            host: this.upstream.host,
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(payload),
            'accept-encoding': 'identity',
          },
        },
        (r) => {
          const out: Buffer[] = [];
          r.on('data', (c: Buffer) => out.push(c));
          r.on('end', () => resolve({ status: r.statusCode || 0, body: Buffer.concat(out).toString('utf8') }));
        },
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  // --- helpers used by the analyzer ---------------------------------------
  baseline(model: string): Promise<number | null> {
    return this.count({ model, messages: [{ role: 'user', content: '.' }] });
  }

  async countText(model: string, text: string): Promise<number | null> {
    if (!text) return 0;
    const [b, t] = await Promise.all([this.baseline(model), this.count({ model, messages: [{ role: 'user', content: text }] })]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b + 1);
  }

  async countSystemBlocks(model: string, blocks: SystemBlock[]): Promise<number | null> {
    const [b, t] = await Promise.all([
      this.baseline(model),
      this.count({ model, system: blocks.map(stripCache), messages: [{ role: 'user', content: '.' }] }),
    ]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b);
  }

  // Tokens for a tool list including the tool-use framing the API adds once per request.
  async countTools(model: string, tools: ToolDef[]): Promise<number | null> {
    const [b, t] = await Promise.all([
      this.baseline(model),
      this.count({ model, tools: tools.map(stripCache), messages: [{ role: 'user', content: '.' }] }),
    ]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b);
  }

  // Framing cost: what a request with one (near-empty) tool costs beyond no tools at all.
  toolFraming(model: string): Promise<number | null> {
    return this.countTools(model, [DUMMY_TOOL]);
  }

  // Marginal cost of a single tool definition (framing removed).
  async countTool(model: string, tool: ToolDef): Promise<number | null> {
    const [f, t] = await Promise.all([this.toolFraming(model), this.countTools(model, [tool])]);
    if (f == null || t == null) return null;
    return Math.max(0, t - f + DUMMY_TOOL_TOKENS);
  }

  async countMessageBlock(model: string, role: 'user' | 'assistant', block: ContentBlock): Promise<number | null> {
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

  // A thinking block from an earlier assistant turn. Claude Code sends the text empty and keeps
  // only the encrypted signature, which still costs input tokens when the request keeps thinking
  // (context_management keep:"all"). Counted in place, with the request's own thinking settings,
  // as the difference against the same turn without the block.
  async countThinkingBlock(model: string, block: ContentBlock, settings: { thinking?: unknown; context_management?: unknown } = {}): Promise<number | null> {
    const req = (content: ContentBlock[]) => ({
      model, ...settings,
      messages: [{ role: 'user', content: '.' }, { role: 'assistant', content }, { role: 'user', content: '.' }],
    });
    const dot: ContentBlock = { type: 'text', text: '.' };
    const [b, t] = await Promise.all([this.count(req([dot])), this.count(req([stripCache(block) as ContentBlock, dot]))]);
    if (b == null || t == null) return null;
    return Math.max(0, t - b);
  }
}

// Local fallback for an encrypted thinking signature (base64, roughly 3.3 chars per token).
export const estimateSignatureTokens = (signatureChars: number): number => Math.round(signatureChars / 3.3);

/** The public surface the analyzer needs; lets tests substitute a fake counter. */
export type Counter = Pick<TokenCounter, 'ready' | 'countSystemBlocks' | 'countTools' | 'toolFraming' | 'countTool' | 'countText' | 'countMessageBlock' | 'countThinkingBlock'>;

export function stripCache<T extends object>(o: T): Omit<T, 'cache_control'> {
  if (!o || typeof o !== 'object') return o;
  const { cache_control: _cc, ...rest } = o as T & { cache_control?: unknown };
  return rest;
}
