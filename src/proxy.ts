// Transparent HTTP proxy in front of the Anthropic API. Claude Code is pointed at it via
// ANTHROPIC_BASE_URL. Every /v1/messages call is captured (request body + assembled
// streamed response) and handed to the callback; everything else is forwarded untouched.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import type { Readable } from 'node:stream';
import { SseAssembler, fromJsonBody } from './sse.js';
import { redactHeaders, shortId, nowIso } from './util.js';
import type { AssembledResponse, CaptureRecord, RequestBody } from './types.js';

export type CapturePhase = 'request' | 'response';
export type CaptureHandler = (phase: CapturePhase, capture: CaptureRecord) => void;

export interface ProxyOptions {
  port: number;
  host?: string;
  upstream: string;
  onCapture: CaptureHandler;
  log?: (line: string) => void;
}

export interface ProxyHandle {
  server: http.Server;
  url: string;
}

// Claude Code is pointed at http://host:port/<agent> so the first path segment names the
// agent; it is stripped before forwarding and recorded on every capture for identification.
const RESERVED = new Set(['v1', 'api']);
export function splitAgentPrefix(url: string | undefined): { agent: string | null; path: string } {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)$/.exec(url || '');
  if (m && !RESERVED.has(m[1])) return { agent: m[1], path: m[2] };
  return { agent: null, path: url || '/' };
}

export function startProxy({ port, host = '127.0.0.1', upstream, onCapture, log = () => {} }: ProxyOptions): Promise<ProxyHandle> {
  const up = new URL(upstream);
  const mod = up.protocol === 'http:' ? http : https;

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const { agent, path: upPath } = splitAgentPrefix(req.url);
      const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(upPath);
      const capture = isMessages ? beginCapture(req, body, agent, upPath) : null;
      if (capture) onCapture('request', capture);

      const headers: Record<string, string | string[] | undefined> = { ...req.headers, host: up.host, 'accept-encoding': 'identity' };
      delete headers.connection;
      if (body.length) headers['content-length'] = String(body.length);

      const t0 = Date.now();
      const upReq = mod.request({ host: up.hostname, port: up.port || undefined, method: req.method, path: upPath, headers }, (upRes) => {
        const resHeaders = { ...upRes.headers };
        delete resHeaders['content-encoding'];
        delete resHeaders['content-length'];
        res.writeHead(upRes.statusCode || 502, resHeaders);
        const enc = upRes.headers['content-encoding'];
        let stream: Readable = upRes;
        if (enc === 'gzip') stream = upRes.pipe(zlib.createGunzip());
        else if (enc === 'br') stream = upRes.pipe(zlib.createBrotliDecompress());
        else if (enc === 'deflate') stream = upRes.pipe(zlib.createInflate());

        const isSse = /text\/event-stream/.test(upRes.headers['content-type'] || '');
        const asm = capture ? new SseAssembler() : null;
        const raw: Buffer[] = [];
        let bytes = 0;
        let first: number | null = null;
        stream.on('data', (c: Buffer) => {
          if (first === null) first = Date.now();
          bytes += c.length;
          res.write(c);
          if (capture) {
            if (isSse) asm!.feed(c);
            else raw.push(c);
          }
        });
        stream.on('end', () => {
          res.end();
          if (!capture) return;
          let result: AssembledResponse;
          if (isSse) {
            asm!.end();
            result = asm!.result();
          } else result = fromJsonBody(Buffer.concat(raw).toString('utf8'));
          capture.status = upRes.statusCode || 0;
          capture.responseHeaders = redactHeaders(upRes.headers);
          capture.endedAt = nowIso();
          capture.durationMs = Date.now() - t0;
          capture.ttfbMs = first ? first - t0 : null;
          capture.bytesOut = bytes;
          capture.response = result;
          if (result.firstTokenAt) capture.ttftMs = result.firstTokenAt - t0;
          onCapture('response', capture);
        });
        stream.on('error', (e: Error) => {
          log(`upstream stream error: ${e.message}`);
          try {
            res.end();
          } catch {}
        });
      });
      upReq.on('error', (e: Error) => {
        log(`upstream error: ${e.message}`);
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'proxy_error', message: e.message } }));
        if (capture) {
          capture.status = 502;
          capture.error = e.message;
          capture.endedAt = nowIso();
          capture.durationMs = Date.now() - t0;
          onCapture('response', capture);
        }
      });
      upReq.end(body);
    });
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const p = typeof addr === 'object' && addr ? addr.port : port;
      resolve({ server, url: `http://${host}:${p}` });
    });
  });
}

function beginCapture(req: http.IncomingMessage, body: Buffer, agent: string | null, upPath: string): CaptureRecord {
  let parsed: RequestBody | null = null;
  try {
    parsed = JSON.parse(body.toString('utf8')) as RequestBody;
  } catch {}
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse((parsed && parsed.metadata && parsed.metadata.user_id) || '{}');
  } catch {}
  return {
    id: shortId(),
    startedAt: nowIso(),
    method: req.method || 'POST',
    path: upPath,
    agent,
    headers: redactHeaders(req.headers),
    _auth: req.headers, // raw, in-memory only (never persisted)
    bytesIn: body.length,
    body: parsed,
    bodyText: parsed ? null : body.toString('utf8').slice(0, 20000),
    sessionId: typeof meta.session_id === 'string' ? meta.session_id : 'unknown',
    meta,
    model: parsed ? parsed.model : null,
    stream: parsed ? !!parsed.stream : false,
    toolCount: parsed && Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    messageCount: parsed && Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    status: null,
    response: null,
  };
}
