// UI + JSON API + live event stream (SSE) for the inspector.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicSource } from './inventory.js';
import type { KindInfo } from './inventory.js';
import { slimAnalysis } from './analyze.js';
import { summarize } from './store.js';
import { buildFlowGraph, buildContextGraph } from './graph.js';
import type { Store } from './store.js';
import type { TokenCounter } from './tokens.js';
import type { CaptureRecord, Inventory, RequestBody, Session, SessionSummary, Source, SourceKind } from './types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url)); // dist/src
const UI_DIR = path.join(HERE, '..', '..', 'ui'); // source html
const UI_BUILD = path.join(HERE, '..', 'ui'); // compiled app.js / graph.js / common.js

export interface ServerContext {
  name: string;
  projectDir: string;
  proxyUrl: string;
  upstream: string;
  store: Store;
  counter: TokenCounter;
  kinds: Record<SourceKind, KindInfo>;
  version: string | undefined;
  inventory: (dir?: string) => Inventory;
  projects: () => string[];
  findSource: (id: string) => Source | null;
  sessions: () => SessionSummary[];
  rescan: () => Inventory;
  analyze: (rec: CaptureRecord, opts?: { exact?: boolean; force?: boolean }) => Promise<void>;
  onInventory: (l: (inv: Inventory) => void) => void;
  onLog: (l: (line: string) => void) => void;
}

export interface UiHandle {
  server: http.Server;
  url: string;
  uiUrl: string;
}

export function startUiServer({ port, host = '127.0.0.1', ctx }: { port: number; host?: string; ctx: ServerContext }): Promise<UiHandle> {
  const clients = new Set<http.ServerResponse>();
  const send = (event: string, data: unknown): void => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  ctx.store.on('session', (s: Session) => send('session', { id: s.id, startedAt: s.startedAt, projectDir: s.projectDir, agent: s.agent }));
  ctx.store.on('request', (r: CaptureRecord) => send('request', summarize(r)));
  ctx.store.on('response', (r: CaptureRecord) => send('response', summarize(r)));
  ctx.store.on('analysis', (r: CaptureRecord) => send('analysis', summarize(r)));
  ctx.store.on('cleared', () => send('cleared', {}));
  ctx.onInventory((inv) => send('inventory', { scannedAt: inv.scannedAt, count: inv.sources.length }));
  ctx.onLog((line) => send('log', { line, at: Date.now() }));

  const json = (res: http.ServerResponse, code: number, obj: unknown): void => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(obj));
  };
  const file = (res: http.ServerResponse, dir: string, name: string, type: string, transform?: (s: string) => string): void => {
    let text = fs.readFileSync(path.join(dir, name), 'utf8');
    if (transform) text = transform(text);
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(text);
  };

  const base = `/${ctx.name}`;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://x');
    let p = url.pathname;
    try {
      // Everything is served under /<agent-name>/ so tabs and logs identify the instance.
      if (p === '/' || p === base) {
        res.writeHead(302, { location: `${base}/` });
        return res.end();
      }
      if (p.startsWith(base + '/')) p = p.slice(base.length);
      else if (!p.startsWith('/api/') && p !== '/events') return json(res, 404, { error: `not found; this instance is served at ${base}/` });

      const page = (name: string) => file(res, UI_DIR, name, 'text/html; charset=utf-8', (s) => s.replace('__INSPECTOUR_BASE__', base).replace('__INSPECTOUR_NAME__', ctx.name));
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) return page('index.html');
      if (req.method === 'GET' && (p === '/graph' || p === '/graph.html')) return page('graph.html');
      if (req.method === 'GET' && /^\/[a-z]+\.js$/.test(p) && fs.existsSync(path.join(UI_BUILD, p.slice(1)))) return file(res, UI_BUILD, p.slice(1), 'text/javascript; charset=utf-8');
      if (req.method === 'GET' && p === '/base.css') return file(res, UI_DIR, 'base.css', 'text/css; charset=utf-8');
      let vm: RegExpExecArray | null;
      if (req.method === 'GET' && (vm = /^\/vendor\/([A-Za-z0-9._-]+\.js)$/.exec(p))) return file(res, path.join(UI_DIR, 'vendor'), vm[1], 'text/javascript; charset=utf-8');
      if (p === '/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
        res.write(': hi\n\n');
        clients.add(res);
        const ka = setInterval(() => res.write(': ka\n\n'), 20000);
        req.on('close', () => {
          clearInterval(ka);
          clients.delete(res);
        });
        return;
      }
      if (p === '/api/state') {
        const inv = ctx.inventory();
        return json(res, 200, {
          name: ctx.name,
          base,
          projectDir: ctx.projectDir,
          proxyUrl: ctx.proxyUrl,
          upstream: ctx.upstream,
          counter: { ready: ctx.counter.ready, enabled: ctx.counter.enabled, stats: ctx.counter.stats, cacheSize: ctx.counter.cache.size, queue: ctx.counter.queue.length + ctx.counter.active },
          inventory: { scannedAt: inv.scannedAt, sources: inv.sources.map((s) => publicSource(s)) },
          projects: ctx.projects(),
          kinds: ctx.kinds,
          sessions: ctx.sessions(),
          version: ctx.version,
        });
      }
      if (p === '/api/sessions') return json(res, 200, ctx.sessions());
      let m: RegExpExecArray | null;
      if ((m = /^\/api\/sessions\/([A-Za-z0-9_-]+)\/graph$/.exec(p))) {
        const sess = ctx.store.sessions.get(m[1]);
        if (!sess) return json(res, 404, { error: 'not found' });
        const recs = sess.requests.map((id) => ctx.store.get(id)).filter((r): r is CaptureRecord => !!r);
        const inv = ctx.inventory(sess.projectDir || undefined);
        const servers = new Set<string>();
        for (const s of inv.sources) for (const v of s.servers || []) servers.add(v.sanitized);
        return json(res, 200, buildFlowGraph(sess.id, recs, servers));
      }
      if ((m = /^\/api\/requests\/([A-Za-z0-9]+)\/graph$/.exec(p))) {
        const rec = ctx.store.get(m[1]);
        if (!rec) return json(res, 404, { error: 'not found' });
        const inv = ctx.inventory(rec.projectDir);
        return json(res, 200, buildContextGraph(rec, [...inv.sources, ...(rec.analysis?.adhocSources || [])]));
      }
      if ((m = /^\/api\/requests\/([A-Za-z0-9]+)$/.exec(p))) {
        const rec = ctx.store.get(m[1]);
        if (!rec) return json(res, 404, { error: 'not found' });
        const { _auth: _a, _analyzing: _b, body, ...rest } = rec;
        const full = url.searchParams.get('full') === '1';
        const inv = ctx.inventory(rec.projectDir);
        return json(res, 200, {
          ...rest,
          analysis: full ? rec.analysis : slimAnalysis(rec.analysis),
          bodySizes: sizes(body),
          adhocSources: rec.analysis ? rec.analysis.adhocSources : [],
          inventory: full ? { projectDir: inv.projectDir, scannedAt: inv.scannedAt, sources: inv.sources.map((s) => publicSource(s)) } : undefined,
        });
      }
      if ((m = /^\/api\/requests\/([A-Za-z0-9]+)\/raw$/.exec(p))) {
        const rec = ctx.store.get(m[1]);
        if (!rec) return json(res, 404, { error: 'not found' });
        return json(res, 200, { request: rec.body || rec.bodyText, response: rec.response, headers: rec.headers, responseHeaders: rec.responseHeaders });
      }
      if ((m = /^\/api\/requests\/([A-Za-z0-9]+)\/recount$/.exec(p)) && req.method === 'POST') {
        const rec = ctx.store.get(m[1]);
        if (!rec) return json(res, 404, { error: 'not found' });
        await ctx.analyze(rec, { exact: true, force: true });
        return json(res, 200, summarize(rec));
      }
      if ((m = /^\/api\/sources\/([A-Za-z0-9]+)$/.exec(p))) {
        const src = ctx.findSource(m[1]);
        if (!src) return json(res, 404, { error: 'not found' });
        return json(res, 200, publicSource(src, { withContent: true }));
      }
      if (p === '/api/rescan' && req.method === 'POST') {
        const inv = ctx.rescan();
        return json(res, 200, { scannedAt: inv.scannedAt, count: inv.sources.length });
      }
      if (p === '/api/clear' && req.method === 'POST') {
        ctx.store.clear();
        return json(res, 200, { ok: true });
      }
      if (p === '/api/counter' && req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(c as Buffer);
        const b = JSON.parse(Buffer.concat(chunks).toString() || '{}') as { enabled?: boolean };
        if (typeof b.enabled === 'boolean') ctx.counter.enabled = b.enabled;
        return json(res, 200, { enabled: ctx.counter.enabled, ready: ctx.counter.ready });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      const err = e as Error;
      json(res, 500, { error: err.message, stack: err.stack });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const pt = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${pt}`, uiUrl: `http://${host}:${pt}${base}/` });
    });
  });
}

function sizes(body: RequestBody | null): Record<string, number> | null {
  if (!body) return null;
  const j = (x: unknown): number => (x == null ? 0 : JSON.stringify(x).length);
  const total = j(body);
  return { total, system: j(body.system), tools: j(body.tools), messages: j(body.messages), other: total - j(body.system) - j(body.tools) - j(body.messages) };
}
