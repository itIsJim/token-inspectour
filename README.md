# token-inspectour

**See what Claude Code actually sends to the model.**

token-inspectour is a local proxy with a browser UI. It sits between Claude Code and the Anthropic API, captures every request, and maps each span of that request back to the file that produced it: your `CLAUDE.md` chain, rules, skills, slash commands, subagents, hooks, MCP servers, auto-memory, plugins, and the built-in harness. Every part carries an exact token count, so you can see where the context window goes, how it changes from step to step, and which of your project files are really reaching the model.

```
┌─────────────┐  ANTHROPIC_BASE_URL   ┌──────────────────┐  forwards   ┌──────────────────┐
│ claude code │ ───────────────────▶  │ token-inspectour │ ──────────▶ │ api.anthropic.com│
│             │ ◀─────────────────── │  proxy :4141     │ ◀────────── │                  │
└─────────────┘   streamed response   └────────┬─────────┘             └──────────────────┘
                                               │ captures request + response
                                               ▼
                                      ┌──────────────────┐
                                      │  UI :4142/<agent>│  anatomy · sources · step diff · response · raw
                                      └──────────────────┘
```

Written in TypeScript with no runtime dependencies beyond two vendored MIT graph libraries. One HTML page, a few hundred lines of Node.

## Why

Claude Code assembles a large prompt on your behalf: a harness system prompt, seventy-odd tool definitions, every `CLAUDE.md` up the directory tree, skill and agent listings, memory files, reminders, and then your conversation. When a session feels expensive or an instruction gets ignored, it is hard to tell what the model was actually shown. This tool answers that with numbers, per file, per turn.

## Install

Requires Node 18.17 or later and a working `claude` login.

```sh
git clone https://github.com/itIsJim/token-inspectour.git
cd token-inspectour
npm install       # installs the TypeScript compiler and builds dist/
npm link          # makes the `token-inspectour` command available
```

Or skip the link and run `node bin/token-inspectour.js` from the checkout after `npm install`.

## Quick start

```sh
token-inspectour ~/path/to/agent-project
```

This starts the proxy and the UI, opens the UI in your browser, and launches `claude` in that project through the proxy, all in the current terminal. Use Claude Code as normal. Each API call appears in the UI as it happens. When Claude Code exits, the inspector keeps serving the UI until you press Ctrl-C.

Anything after `--` is passed to `claude`:

```sh
token-inspectour ~/path/to/agent-project -- --continue
token-inspectour ~/path/to/agent-project -- -p "summarize the repo"
```

### Several agents at once

Run one inspector per agent, each in its own terminal:

```sh
# terminal 1
token-inspectour ~/projects/agent-a
# terminal 2
token-inspectour ~/projects/agent-b
```

Each instance takes the next free proxy and UI port pair (4141/4142, then 4143/4144, and so on) and is served under its agent's name, so the tabs read `http://127.0.0.1:4142/agent-a/` and `http://127.0.0.1:4144/agent-b/`. Each UI lists only its own agent's sessions. The name defaults to the project folder; override it with `--name`.

### Proxy-only mode (advanced)

If you want to attach Claude Code yourself, run a headless pipeline through a fixed port, or funnel several agents through one proxy:

```sh
token-inspectour --proxy-only -p 4141
```

Then, from any project, on one line:

```sh
cd ~/projects/agent-a && ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-a claude
cd ~/projects/agent-b && ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-b claude
```

The path segment after the port names the agent. The proxy strips it before forwarding and records it on every capture, so the sessions of both agents show up labelled in the hub's UI.

## What you see

**Anatomy.** The request split into its three areas, with a stacked bar of tokens by source kind.

- *System prompt*: the billing header, the Agent SDK preamble, and the harness prompt with its cache breakpoint.
- *Tools*: every tool definition, grouped into built-in tools and MCP servers, plus the tool-use framing the API adds once per request.
- *Messages*: every content block, with `<system-reminder>` blocks opened up. Inside them, each `Contents of <file>` section is attributed to that file, and the skill, agent, and MCP-instruction listings are attributed line by line. Tool results are attributed to the file a `Read` fetched or the skill a `Skill` call invoked.

Expand any part to read its text with each span tinted by kind. Hover a span for its token count. Click a span to open the source file beside it with the matched region highlighted.

**Sources.** The full inventory found for the session's project: which files are sent, how many tokens each costs in this request, how much of the file arrived verbatim, and which steps of the session include it. Unused files are listed too, so a skill that never gets pulled in stands out.

**Diff.** The change from the previous agent turn: added, removed, and changed parts with token deltas, beside the server's own cache-read, cache-write, and uncached numbers.

**Response.** The assembled streamed reply (text, thinking, tool calls), usage, stop reason, and timing.

**Raw.** Headers and bodies as captured, with credentials redacted.

**Flow-graph.** The `flow-graph` button in the header switches to an interactive diagram of the selected session, drawn with Cytoscape.js and laid out with dagre. Agent turns run left to right (or top to bottom), each turn fans out into the tool calls it made, grouped by MCP server where relevant, with the result flowing back into the next turn. Edge width follows tokens, the turn-to-turn edge carries the tokens added by that step, and subagent spawns and side calls (session titling, compaction) are drawn in their own styles. A second mode, *turn context*, shows one request as a flow from sources (CLAUDE.md files, skills, memory, harness, tools) into the system, tools, and messages areas and on into the request, so you can see at a glance what the context is made of. Hover highlights the neighbourhood, click opens the details panel, and the graph updates live as new calls arrive. The two library files are vendored under `ui/vendor/` with their MIT licenses; nothing is fetched from a CDN.

## Token counts

Counts are exact, not estimated. After the first captured request, the inspector reuses that session's own auth headers to call `/v1/messages/count_tokens` for each part. Results are cached by content hash, so a second turn only counts what changed. Parts that could not be counted fall back to a local estimate and are marked with `≈`.

Per-tool numbers are marginal costs. The API adds a fixed wrapper around any tool list; that wrapper is shown as its own part so the sum of parts matches the server's reported prompt total. On real runs the two agree to within about 0.05%. The remaining difference is shown as "unattributed" rather than hidden.

`--no-count` disables the count_tokens calls entirely.

## Works with any agent

The proxy is project-agnostic. Each session's project directory is read from the request itself (the harness tells the model its working directory, and the `CLAUDE.md` paths are the fallback). An inventory is scanned per detected project on first sight and rescanned when its config changes. A project with no `.claude/` of its own still gets a meaningful inventory: the parent `CLAUDE.md` chain, user-level skills, agents, settings, memory, and plugins.

Subagent turns made through the Agent tool are captured like any other call and labelled with the agent definition whose body appears in their system prompt.

## How attribution works

The scanner (`src/inventory.ts`) walks from the filesystem root down to the project and picks up every `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` on the way, then the project's and user's skills, commands (namespaced `a:b` like Claude Code does), agents, settings (hooks, permissions, enabled plugins), MCP config (`.mcp.json` and `~/.claude.json`), auto-memory for the project, and installed plugins.

The analyzer (`src/analyze.ts`) then matches request text against that inventory:

| match | how |
|---|---|
| `contents-of` | `Contents of <path> (…):` sections inside `<system-reminder>` blocks |
| `exact` | a file's body or full content appearing verbatim |
| `partial` | a file located by its first 120 chars and extended by longest common prefix, reported with coverage |
| `listing` | one line per skill, command, or agent in the harness listings; one section per server under `# MCP Server Instructions` |
| `tool-read` | a `Read` tool result, attributed to the file, or to the skill whose folder contains it |
| `skill-invoke` | a `Skill` tool result, attributed to the invoked skill or command |
| tool name | `mcp__<server>__<tool>` resolved to the MCP source; `claude_ai_*` servers are claude.ai connectors |

Anything left over inside a reminder is `reminder`, inside the system prompt is `harness`, in a user turn is `user`, and so on. Side calls Claude Code makes on its own (session-title generation, compaction) are captured and labelled separately from agent turns.

## CLI

```
token-inspectour [projectDir] [options] [-- claude args…]

  projectDir            Project to launch Claude Code in (default: cwd)
  -- <args…>            Passed to claude
  --name <slug>         Agent name used in the routes (default: the project folder name)
  --proxy-only          Do not launch claude; just run the proxy + UI
  -p, --port <n>        Proxy port (default: first free port from 4141)
  -u, --ui <n>          UI port    (default: the port after the proxy port)
  --upstream <url>      Real API base URL (default https://api.anthropic.com)
  --no-open             Do not open the UI in the browser
  --no-count            Estimates only; never call count_tokens
  --no-persist          Do not write captures to disk
  --clear               Delete previously captured sessions on start
```

## Privacy and data

Everything stays on your machine. The proxy listens on `127.0.0.1` only and forwards to the API you already use.

Captures are written to `~/.token-inspectour/captures/<session>/`, one JSON file per call. They contain your prompts, your files as the model saw them, and the model's replies, so treat that directory like a transcript. Authorization headers are redacted before anything is written; the live auth headers are held in memory only, to make count_tokens calls on your behalf. In launch mode the inspector's own log goes to `~/.token-inspectour/logs/`. Set `TOKEN_INSPECTOUR_HOME` to move all of it, or `--no-persist` to keep nothing.

## Compatibility and limitations

- Tested with Claude Code 2.1.x on macOS with both OAuth and API-key sessions. The attribution rules key off the harness's current wording (`Contents of …`, `The following skills are available`, `# MCP Server Instructions`, `Primary working directory:`). If a Claude Code release changes those strings, some spans will fall back to `harness` or `reminder` until the regexes in `src/analyze.ts` are updated.
- Claude Code must honour `ANTHROPIC_BASE_URL`, which it does in every mode we tried. Third-party gateways that Claude Code is already pointed at can be chained with `--upstream`.
- The UI is a single dependency-free page (`ui/index.html` + compiled `app.js`); it has been exercised against real sessions but not across many browsers.

## Development

```sh
npm run build       # tsc → dist/ (backend, tests) and dist/ui/app.js (browser)
npm test            # build, then node --test dist/test/
npm run typecheck   # strict type check without emitting
```

The code is strict TypeScript compiled to ES modules on `node:http`; the only dev dependency is the TypeScript compiler. `src/types.ts` holds the shared data model (requests, sources, parts, spans, analyses, summaries) that the backend and the browser UI both compile against. `src/proxy.ts` captures, `src/sse.ts` assembles streams, `src/inventory.ts` scans, `src/analyze.ts` attributes and counts, `src/tokens.ts` talks to count_tokens, `src/store.ts` persists, `src/server.ts` serves the UI and JSON API, `src/graph.ts` builds the flow-graph data, `src/cli.ts` wires it together. The UI is `ui/index.html` plus `ui/app.ts`; `ui/vendor/` holds Cytoscape.js, dagre, and cytoscape-dagre (all MIT).

Issues and pull requests are welcome. If you hit a request shape that is not attributed correctly, an anonymised capture (delete the message text, keep the structure) makes it easy to fix.

## License

MIT
