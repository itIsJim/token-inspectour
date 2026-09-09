// Transparent HTTP proxy in front of the Anthropic API. Claude Code is pointed at it via
// ANTHROPIC_BASE_URL. Every /v1/messages call is captured (request body + assembled
// streamed response) and handed to the callbacks; everything else is forwarded untouched.
import http from 'node:http';
import https from 'node:https';
import zlib from 'node:zlib';
import { SseAssembler, fromJsonBody } from './sse.js';
import { redactHeaders, shortId, nowIso } from './util.js';

// Claude Code is pointed at http://host:port/<agent> so the first path segment names the
// agent; it is stripped before forwarding and recorded on every capture for identification.
const RESERVED = new Set(['v1', 'api']);
export function splitAgentPrefix(url) {
  const m = /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(\/.*)$/.exec(url || '');
  if (m && !RESERVED.has(m[1])) return { agent: m[1], path: m[2] };
  return { agent: null, path: url };
}

export function startProxy({ port, host = '127.0.0.1', upstream, onCapture, log = () => {} }) {
  const up = new URL(upstream);
  const mod = up.protocol === 'http:' ? http : https;

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const { agent, path: upPath } = splitAgentPrefix(req.url);
      const isMessages = req.method === 'POST' && /^\/v1\/messages(\?|$)/.test(upPath);
      const capture = isMessages ? beginCapture(req, body, agent, upPath) : null;
      if (capture) onCapture('request', capture);

      const headers = { ...req.headers, host: up.host, 'accept-encoding': 'identity' };
      delete headers.connection;
      if (body.length) headers['content-length'] = String(body.length);

      const t0 = Date.now();
      const upReq = mod.request(
        { host: up.hostname, port: up.port || undefined, method: req.method, path: upPath, headers },
        (upRes) => {
          const resHeaders = { ...upRes.headers };
          delete resHeaders['content-encoding'];
          delete resHeaders['content-length'];
          res.writeHead(upRes.statusCode, resHeaders);
          const enc = upRes.headers['content-encoding'];
          let stream = upRes;
          if (enc === 'gzip') stream = upRes.pipe(zlib.createGunzip());
          else if (enc === 'br') stream = upRes.pipe(zlib.createBrotliDecompress());
          else if (enc === 'deflate') stream = upRes.pipe(zlib.createInflate());

          const isSse = /text\/event-stream/.test(upRes.headers['content-type'] || '');
          const asm = capture ? new SseAssembler() : null;
          const raw = [];
          let bytes = 0;
          let first = null;
          stream.on('data', (c) => {
            if (first === null) first = Date.now();
            bytes += c.length;
            res.write(c);
            if (capture) {
              if (isSse) asm.feed(c);
              else raw.push(c);
            }
          });
          stream.on('end', () => {
            res.end();
            if (!capture) return;
            let result;
            if (isSse) {
              asm.end();
              result = asm.result();
            } else result = fromJsonBody(Buffer.concat(raw).toString('utf8'));
            capture.status = upRes.statusCode;
            capture.responseHeaders = redactHeaders(upRes.headers);
            capture.endedAt = nowIso();
            capture.durationMs = Date.now() - t0;
            capture.ttfbMs = first ? first - t0 : null;
            capture.bytesOut = bytes;
            capture.response = result;
            if (result.firstTokenAt) capture.ttftMs = result.firstTokenAt - t0;
            onCapture('response', capture);
          });
          stream.on('error', (e) => {
            log(`upstream stream error: ${e.message}`);
            try { res.end(); } catch {}
          });
        },
      );
      upReq.on('error', (e) => {
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
    server.listen(port, host, () => resolve({ server, url: `http://${host}:${server.address().port}` }));
  });
}

function beginCapture(req, body, agent, upPath) {
  let parsed = null;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {}
  let meta = {};
  try {
    meta = JSON.parse((parsed && parsed.metadata && parsed.metadata.user_id) || '{}');
  } catch {}
  return {
    id: shortId(),
    startedAt: nowIso(),
    method: req.method,
    path: upPath,
    agent: agent || null,
    headers: redactHeaders(req.headers),
    _auth: req.headers, // raw, in-memory only (never persisted)
    bytesIn: body.length,
    body: parsed,
    bodyText: parsed ? null : body.toString('utf8').slice(0, 20000),
    sessionId: meta.session_id || 'unknown',
    meta,
    model: parsed ? parsed.model : null,
    stream: parsed ? !!parsed.stream : false,
    toolCount: parsed && Array.isArray(parsed.tools) ? parsed.tools.length : 0,
    messageCount: parsed && Array.isArray(parsed.messages) ? parsed.messages.length : 0,
    status: null,
    response: null,
  };
}
