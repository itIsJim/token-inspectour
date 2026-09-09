// UI + JSON API + live event stream (SSE) for the inspector.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { publicSource } from './inventory.js';
import { slimAnalysis } from './analyze.js';
import { summarize } from './store.js';

const UI_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'ui');

export function startUiServer({ port, host = '127.0.0.1', ctx }) {
  const clients = new Set();
  const send = (event, data) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  ctx.store.on('session', (s) => send('session', { id: s.id, startedAt: s.startedAt, projectDir: s.projectDir }));
  ctx.store.on('request', (r) => send('request', summarize(r)));
  ctx.store.on('response', (r) => send('response', summarize(r)));
  ctx.store.on('analysis', (r) => send('analysis', summarize(r)));
  ctx.store.on('cleared', () => send('cleared', {}));
  ctx.onInventory((inv) => send('inventory', { scannedAt: inv.scannedAt, count: inv.sources.length }));
  ctx.onLog((line) => send('log', { line, at: Date.now() }));

  const json = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    try {
      if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
        const html = fs.readFileSync(path.join(UI_DIR, 'index.html'));
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        return res.end(html);
      }
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
        return json(res, 200, {
          projectDir: ctx.projectDir,
          proxyUrl: ctx.proxyUrl,
          upstream: ctx.upstream,
          counter: { ready: ctx.counter.ready, enabled: ctx.counter.enabled, stats: ctx.counter.stats, cacheSize: ctx.counter.cache.size, queue: ctx.counter.queue.length + ctx.counter.active },
          inventory: { scannedAt: ctx.inventory().scannedAt, sources: ctx.inventory().sources.map((s) => publicSource(s)) },
          projects: ctx.projects(),
          kinds: ctx.kinds,
          sessions: ctx.store.listSessions(),
          version: ctx.version,
        });
      }
      if (p === '/api/sessions') return json(res, 200, ctx.store.listSessions());
      let m;
      if ((m = /^\/api\/requests\/([A-Za-z0-9]+)$/.exec(p))) {
        const rec = ctx.store.get(m[1]);
        if (!rec) return json(res, 404, { error: 'not found' });
        const { _auth, body, ...rest } = rec;
        const full = url.searchParams.get('full') === '1';
        const inv = ctx.inventory(rec.projectDir);
        return json(res, 200, { ...rest, analysis: full ? rec.analysis : slimAnalysis(rec.analysis), bodySizes: sizes(body), adhocSources: rec.analysis ? rec.analysis.adhocSources : [], inventory: full ? { projectDir: inv.projectDir, scannedAt: inv.scannedAt, sources: inv.sources.map((s) => publicSource(s)) } : undefined });
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
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const b = JSON.parse(Buffer.concat(chunks).toString() || '{}');
        if (typeof b.enabled === 'boolean') ctx.counter.enabled = b.enabled;
        return json(res, 200, { enabled: ctx.counter.enabled, ready: ctx.counter.ready });
      }
      json(res, 404, { error: 'not found' });
    } catch (e) {
      json(res, 500, { error: e.message, stack: e.stack });
    }
  });
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

function sizes(body) {
  if (!body) return null;
  const j = (x) => (x == null ? 0 : JSON.stringify(x).length);
  return { total: j(body), system: j(body.system), tools: j(body.tools), messages: j(body.messages), other: j(body) - j(body.system) - j(body.tools) - j(body.messages) };
}
