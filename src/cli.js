import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { startProxy } from './proxy.js';
import { startUiServer } from './server.js';
import { Store } from './store.js';
import { TokenCounter } from './tokens.js';
import { scanInventory, watchRoots, KINDS } from './inventory.js';
import { analyzeRequest, classifyRequest, detectProjectDir } from './analyze.js';
import { readJsonSafe, exists, dataDir } from './util.js';

const HELP = `token-inspectour — see what Claude Code actually sends to the model

Usage: token-inspectour [projectDir] [options] [-- claude args…]

  By default this launches \`claude\` in projectDir through the inspector's proxy and opens
  the UI. Run it once per agent, each in its own terminal: every instance picks its own free
  proxy + UI ports, so each agent gets its own inspector window.

  projectDir            Project to launch Claude Code in (default: cwd). Sessions' projects are
                        also detected from the requests themselves.
  -- <args…>            Everything after -- is passed to claude (e.g. -- -p "summarize the repo")
  --name <slug>         Agent name used in the routes (default: the project folder name).
                        Proxy: http://127.0.0.1:<port>/<name>   UI: http://127.0.0.1:<ui>/<name>/
  --proxy-only          Do not launch claude; just run the proxy + UI. Attach any Claude Code
                        with ANTHROPIC_BASE_URL=http://127.0.0.1:<port>/<agent-name>; the path
                        segment labels that agent's sessions.
  -p, --port <n>        Proxy port (default: first free port from 4141)
  -u, --ui <n>          UI port    (default: the port after the proxy port)
  --upstream <url>      Real API base URL (default https://api.anthropic.com)
  --no-open             Do not open the UI in the browser
  --no-count            Skip exact token counting (estimates only; no count_tokens calls)
  --no-persist          Do not write captures to ~/.token-inspectour
  --clear               Delete previously captured sessions on start
  -h, --help            Show this help

Examples:
  token-inspectour ~/agents/growth                 # terminal 1: growth agent + its UI
  token-inspectour ~/agents/sales                  # terminal 2: sales agent + a second UI
  token-inspectour ~/agents/growth -- -p "status"  # one headless prompt through the proxy
  token-inspectour --proxy-only -p 4141            # plain proxy; attach agents manually:
      ANTHROPIC_BASE_URL=http://127.0.0.1:4141/growth claude
`;

export function parseArgs(argv) {
  const o = { projectDir: process.cwd(), name: null, port: null, ui: null, upstream: 'https://api.anthropic.com', count: true, persist: true, clear: false, open: true, run: [], proxyOnly: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-p' || a === '--port') o.port = Number(argv[++i]);
    else if (a === '-u' || a === '--ui') o.ui = Number(argv[++i]);
    else if (a === '--upstream') o.upstream = argv[++i];
    else if (a === '--name') o.name = argv[++i];
    else if (a === '--no-count') o.count = false;
    else if (a === '--no-persist') o.persist = false;
    else if (a === '--clear') o.clear = true;
    else if (a === '--open') o.open = true;
    else if (a === '--no-open') o.open = false;
    else if (a === '--proxy-only' || a === '--no-run') o.proxyOnly = true;
    else if (a === '--run' || a === '--') {
      // legacy --run and the -- separator both mean: the rest goes to claude
      o.run = argv.slice(i + 1);
      break;
    } else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else o.projectDir = path.resolve(a);
  }
  return o;
}

export function slugify(name) {
  const s = String(name || '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '');
  return s && !/^(v1|api)$/.test(s) ? s : 'agent';
}

// Find a free port at or after `start` (each inspector instance gets its own pair).
export function freePort(start, host = '127.0.0.1', taken = new Set()) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > 65000) return reject(new Error('no free port'));
      if (taken.has(p)) return tryPort(p + 1);
      const srv = net.createServer();
      srv.once('error', () => tryPort(p + 1));
      srv.listen(p, host, () => srv.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!fs.existsSync(o.projectDir)) throw new Error(`project dir not found: ${o.projectDir}`);
  const pkg = readJsonSafe(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json')) || {};
  const launching = !o.proxyOnly;
  o.name = slugify(o.name || path.basename(o.projectDir));
  if (o.port == null) o.port = await freePort(4141);
  if (o.ui == null) o.ui = await freePort(o.port + 1, '127.0.0.1', new Set([o.port]));

  // In launch mode claude owns the terminal, so the inspector logs to a file instead of stderr.
  const logLines = [];
  const logListeners = new Set();
  let logFile = null;
  if (launching && o.persist) {
    const ld = path.join(dataDir(), 'logs');
    fs.mkdirSync(ld, { recursive: true });
    logFile = path.join(ld, `inspector-${o.port}.log`);
  }
  const log = (line) => {
    const s = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
    logLines.push(s);
    if (launching) {
      if (logFile) fs.appendFileSync(logFile, s + '\n');
    } else process.stderr.write(s + '\n');
    for (const l of logListeners) l(s);
  };

  const store = new Store({ persist: o.persist });
  if (o.clear) store.clear();
  else store.load();
  const counter = new TokenCounter({ upstream: o.upstream, persist: o.persist, log });
  counter.enabled = o.count;

  // One inventory per project directory. Projects are discovered from the requests
  // themselves (environment reminder / CLAUDE.md paths), so a single proxy serves any agent.
  const inventories = new Map();
  const watched = new Set();
  const invListeners = new Set();
  let wt = null;
  const rescan = () => {
    for (const dir of inventories.keys()) inventories.set(dir, scanInventory(dir));
    const inv = inventories.get(o.projectDir) || [...inventories.values()][0];
    log(`inventory rescanned: ${[...inventories.entries()].map(([d, i]) => `${path.basename(d)}=${i.sources.length}`).join(', ')}`);
    for (const l of invListeners) l(inv);
    return inv;
  };
  const watchDir = (dir) => {
    for (const root of watchRoots(dir)) {
      if (watched.has(root)) continue;
      watched.add(root);
      try {
        fs.watch(root, { recursive: true }, () => {
          clearTimeout(wt);
          wt = setTimeout(rescan, 400);
        });
      } catch {}
    }
  };
  const getInventory = (dir) => {
    dir = path.resolve(dir || o.projectDir);
    let inv = inventories.get(dir);
    if (!inv) {
      inv = scanInventory(dir);
      inventories.set(dir, inv);
      watchDir(dir);
      log(`inventory: ${inv.sources.length} sources in ${dir}`);
    }
    return inv;
  };
  getInventory(o.projectDir);
  const findSource = (id) => {
    for (const inv of inventories.values()) {
      const s = inv.sources.find((x) => x.id === id);
      if (s) return s;
    }
    return null;
  };

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
        const a = await analyzeRequest(rec, getInventory(rec.projectDir), counter, prevMain(rec), { exact: opts.exact !== false && counter.enabled });
        rec.analysis = a;
        rec.kind = a.kind + (a.kind === 'side' ? `:${a.label}` : a.label && a.label !== 'agent turn' ? `:${a.label}` : '');
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
      if (!cap.agent) cap.agent = launching ? o.name : null;
      const detected = detectProjectDir(cap.body);
      const sess = store.sessions.get(cap.sessionId);
      const ok = detected && exists(detected);
      cap.projectDir = ok ? detected : sess && sess.projectDir ? sess.projectDir : o.projectDir;
      cap.projectDetected = ok;
      if (ok && !inventories.has(path.resolve(detected))) log(`detected project: ${detected}`);
      if (ok && sess && sess.projectDir !== detected) {
        // the session was opened by a side call (no environment info); re-point it and its earlier calls
        sess.projectDir = detected;
        for (const rid of sess.requests) {
          const r = store.get(rid);
          if (r && !r.projectDetected && r.projectDir !== detected) {
            r.projectDir = detected;
            store.save(r);
          }
        }
      }
      const cls = classifyRequest(cap.body);
      cap.kind = cls.kind + (cls.kind === 'side' ? `:${cls.label}` : '');
      cap.userPreview = preview(lastUserText(cap.body));
      store.addRequest(cap);
      log(`→ [${cap.agent || '-'}] ${cap.kind} ${cap.model || ''} tools=${cap.toolCount} msgs=${cap.messageCount} ${(cap.bytesIn / 1024).toFixed(0)}KB`);
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
  // A launched instance shows only its own agent's sessions (captures on disk are shared
  // between instances); a proxy-only hub shows everything it loaded or captured.
  const sessions = () => store.listSessions().filter((s) => !launching || s.agent === o.name);
  const ctx = {
    name: o.name,
    sessions,
    projectDir: o.projectDir,
    proxyUrl: proxy.url,
    upstream: o.upstream,
    store,
    counter,
    kinds: KINDS,
    version: pkg.version,
    inventory: (dir) => getInventory(dir),
    projects: () => [...inventories.keys()],
    findSource,
    rescan,
    analyze,
    onInventory: (l) => invListeners.add(l),
    onLog: (l) => logListeners.add(l),
  };
  const ui = await startUiServer({ port: o.ui, ctx });

  const baseUrl = `${proxy.url}/${o.name}`;
  process.stderr.write(`
  token-inspectour v${pkg.version}
  agent     ${o.name}
  project   ${o.projectDir}
  proxy     ${baseUrl}  →  ${o.upstream}
  UI        ${ui.uiUrl}
  counting  ${o.count ? 'exact via count_tokens (after the first captured request)' : 'estimates only'}
${launching ? `  log       ${logFile || '(not persisted)'}

  Launching claude here through the proxy. Open another terminal and run
  token-inspectour again for a second agent; it will take the next free ports.
` : `
  Attach agents manually; the path segment names the agent in the UI:
    cd ${o.projectDir} && ANTHROPIC_BASE_URL=${baseUrl} claude
    cd /other/agent && ANTHROPIC_BASE_URL=${proxy.url}/other-agent claude
`}
`);
  if (o.open) openBrowser(ui.uiUrl);
  if (launching) {
    log(`launching claude ${o.run.join(' ')} in ${o.projectDir}`);
    const child = spawn('claude', o.run, { cwd: o.projectDir, stdio: 'inherit', env: { ...process.env, ANTHROPIC_BASE_URL: baseUrl } });
    child.on('error', (e) => {
      process.stderr.write(`could not launch claude: ${e.message}\n`);
    });
    child.on('exit', (code) => {
      log(`claude exited (${code})`);
      process.stderr.write(`\n  claude exited (${code}). Inspector still serving ${ui.uiUrl} — press Ctrl-C to quit.\n`);
    });
    const stop = () => {
      try { child.kill('SIGTERM'); } catch {}
      process.exit(0);
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
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
