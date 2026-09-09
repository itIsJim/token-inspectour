import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startProxy } from './proxy.js';
import { startUiServer } from './server.js';
import { Store } from './store.js';
import { TokenCounter } from './tokens.js';
import { scanInventory, watchRoots, KINDS } from './inventory.js';
import { analyzeRequest, classifyRequest } from './analyze.js';
import { readJsonSafe } from './util.js';

const HELP = `token-inspectour — see what Claude Code actually sends to the model

Usage: token-inspectour [projectDir] [options]

  projectDir            Agent project folder to inspect (default: cwd)
  -p, --port <n>        Proxy port Claude Code connects to        (default 4141)
  -u, --ui <n>          UI port                                   (default 4142)
  --upstream <url>      Real API base URL                         (default https://api.anthropic.com)
  --run [args…]         Launch \`claude\` in projectDir through the proxy (args after --run go to claude)
  --no-count            Skip exact token counting (estimates only; no count_tokens calls)
  --no-persist          Do not write captures to ~/.token-inspectour
  --clear               Delete previously captured sessions on start
  --open                Open the UI in the browser
  -h, --help            Show this help

Then, in another terminal:
  ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
`;

export function parseArgs(argv) {
  const o = { projectDir: process.cwd(), port: 4141, ui: 4142, upstream: 'https://api.anthropic.com', count: true, persist: true, clear: false, open: false, run: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a === '-u' || a === '--ui') o.ui = Number(argv[++i]);
    else if (a === '--upstream') o.upstream = argv[++i];
    else if (a === '--no-count') o.count = false;
    else if (a === '--no-persist') o.persist = false;
    else if (a === '--clear') o.clear = true;
    else if (a === '--open') o.open = true;
    else if (a === '--run') {
      o.run = argv.slice(i + 1);
      break;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.projectDir = path.resolve(a);
  }
  return o;
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!fs.existsSync(o.projectDir)) throw new Error(`project dir not found: ${o.projectDir}`);
  const pkg = readJsonSafe(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')) || {};
  const logLines = [];
  const logListeners = new Set();
  const log = (line) => {
    const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    logLines.push(s);
    process.stderr.write(s + '\n');
    for (const l of logListeners) l(s);
  };

  const store = new Store({ persist: o.persist });
  if (o.clear) store.clear();
  else store.load();
  const counter = new TokenCounter({ upstream: o.upstream, persist: o.persist, log });
  counter.enabled = o.count;

  let inventory = scanInventory(o.projectDir);
  const invListeners = new Set();
  const rescan = () => {
    inventory = scanInventory(o.projectDir);
    log(`inventory: ${inventory.sources.length} sources`);
    for (const l of invListeners) l(inventory);
    return inventory;
  };
  log(`inventory: ${inventory.sources.length} sources in ${o.projectDir}`);

  // watch config for changes
  let wt = null;
  for (const root of watchRoots(o.projectDir)) {
    try {
      fs.watch(root, { recursive: true }, () => {
        clearTimeout(wt);
        wt = setTimeout(rescan, 400);
      });
    } catch {}
  }

  const prevMain = (rec) => {
    const s = store.sessions.get(rec.sessionId);
    if (!s) return null;
    let prev = null;
    for (const rid of s.requests) {
      if (rid === rec.id) break;
      const r = store.get(rid);
      if (r && r.analysis && r.analysis.kind === 'main') prev = r;
    }
    return prev;
  };

  const analyze = async (rec, opts = {}) => {
    if (!rec.body) return;
    if (rec._analyzing && !opts.force) return rec._analyzing;
    rec._analyzing = (async () => {
      try {
        const a = await analyzeRequest(rec, inventory, counter, prevMain(rec), { exact: opts.exact !== false && counter.enabled });
        rec.analysis = a;
        rec.kind = a.kind + (a.kind === 'side' ? `:${a.label}` : '');
        store.update(rec, 'analysis');
      } catch (e) {
        log(`analysis failed for ${rec.id}: ${e.stack || e}`);
      } finally {
        rec._analyzing = null;
      }
    })();
    return rec._analyzing;
  };

  const onCapture = (phase, cap) => {
    if (phase === 'request') {
      counter.setAuthFromHeaders(cap._auth);
      cap.projectDir = o.projectDir;
      const cls = classifyRequest(cap.body);
      cap.kind = cls.kind + (cls.kind === 'side' ? `:${cls.label}` : '');
      cap.userPreview = preview(lastUserText(cap.body));
      store.addRequest(cap);
      log(`→ ${cap.kind} ${cap.model || ''} tools=${cap.toolCount} msgs=${cap.messageCount} ${(cap.bytesIn / 1024).toFixed(0)}KB`);
      analyze(cap);
    } else {
      const u = cap.response && cap.response.usage;
      cap.assistantPreview = preview((cap.response && cap.response.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' '));
      store.update(cap, 'response');
      log(`← ${cap.status} ${cap.durationMs}ms ${u ? `in=${u.input_tokens} cacheR=${u.cache_read_input_tokens || 0} cacheW=${u.cache_creation_input_tokens || 0} out=${u.output_tokens}` : ''}`);
      // refresh analysis (usage totals, diff) once counts are in
      (async () => {
        if (cap._analyzing) await cap._analyzing;
        await analyze(cap, { force: true });
      })();
    }
  };

  const proxy = await startProxy({ port: o.port, upstream: o.upstream, onCapture, log });
  const ctx = {
    projectDir: o.projectDir,
    proxyUrl: proxy.url,
    upstream: o.upstream,
    store,
    counter,
    kinds: KINDS,
    version: pkg.version,
    inventory: () => inventory,
    rescan,
    analyze,
    onInventory: (l) => invListeners.add(l),
    onLog: (l) => logListeners.add(l),
  };
  const ui = await startUiServer({ port: o.ui, ctx });

  process.stderr.write(`
  token-inspectour v${pkg.version}
  project   ${o.projectDir}
  proxy     ${proxy.url}  →  ${o.upstream}
  UI        ${ui.url}
  counting  ${o.count ? 'exact via count_tokens (after the first captured request)' : 'estimates only'}

  Run Claude Code through the proxy:
    cd ${o.projectDir}
    ANTHROPIC_BASE_URL=${proxy.url} claude

`);
  if (o.open) openBrowser(ui.url);
  if (o.run) {
    log(`launching claude ${o.run.join(' ')}`);
    const child = spawn('claude', o.run, { cwd: o.projectDir, stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: proxy.url } });
    child.on('exit', (code) => log(`claude exited (${code}); inspector still running — Ctrl-C to quit`));
  }
}

function lastUserText(body) {
  if (!body || !Array.isArray(body.messages)) return '';
  for (let i = body.messages.length - 1; i >= 0; i--) {
    const m = body.messages[i];
    if (m.role !== 'user') continue;
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content || [];
    const t = blocks.filter((b) => b.type === 'text').map((b) => b.text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()).filter(Boolean).join(' ');
    if (t) return t;
    if (blocks.some((b) => b.type === 'tool_result')) return '[tool results]';
  }
  return '';
}

function preview(s) {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 140);
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
  try {
    spawn(cmd, [url], { stdio: 'ignore', detached: true }).unref();
  } catch {}
}
