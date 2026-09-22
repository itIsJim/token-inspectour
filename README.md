# token-inspectour

**Inspect what Claude Code sends to the model.**

token-inspectour is a local proxy with a browser UI. It sits between Claude Code and the Anthropic API, captures every request, and maps each span of each request back to the file that produced it: the `CLAUDE.md` chain, rules, skills, slash commands, subagents, hooks, MCP servers, auto-memory, plugins, and the built-in harness. Every part carries an exact token count, which shows where the context window goes, how it changes from step to step, and which project files reach the model.

```
┌─────────────┐  ANTHROPIC_BASE_URL   ┌──────────────────┐  forwards   ┌──────────────────┐
│ claude code │ ───────────────────▶  │ token-inspectour │ ──────────▶ │ api.anthropic.com│
│             │ ◀─────────────────── │  proxy :4141     │ ◀────────── │                  │
└─────────────┘   streamed response   └────────┬─────────┘             └──────────────────┘
                                               │ captures request + response
                                               ▼
                                      ┌──────────────────┐
                                      │  UI :4142/<agent>│  anatomy · sources · session · diff · response · raw · flow-graph page
                                      └──────────────────┘
```

TypeScript on `node:http`, with no runtime dependencies. The browser UI vendors d3 and d3-sankey.

## Purpose

Claude Code assembles a large prompt for every call: a harness system prompt, dozens of tool definitions, every `CLAUDE.md` up the directory tree, skill and agent listings, memory files, reminders, and the conversation. token-inspectour breaks that prompt down per file and per turn, with token counts, to explain session cost and to confirm which instructions the model received.

## Requirements

- Node 18.17 or later
- A working `claude` installation and login (OAuth or API key)

## Install

```sh
git clone https://github.com/itIsJim/token-inspectour.git
cd token-inspectour
npm install       # installs the TypeScript compiler and builds dist/
```

Optionally, run `npm link` inside the checkout to install a global `token-inspectour` command. The examples below use `node bin/token-inspectour.js`, which works without linking.

## Quick start

Launch Claude Code in a project through the inspector:

```sh
node bin/token-inspectour.js path/to/project
```

This starts the proxy and the UI, opens the UI in the default browser, and runs `claude` in the project through the proxy, in the current terminal. Each API call appears in the UI as it happens. After Claude Code exits, the UI keeps serving until Ctrl-C.

Pass arguments to `claude` after `--`:

```sh
node bin/token-inspectour.js path/to/project -- --continue
node bin/token-inspectour.js path/to/project -- -p "summarize the repo"
```

### Several agents

Run one inspector per agent, each in its own terminal:

```sh
# terminal 1
node bin/token-inspectour.js path/to/agent-a
# terminal 2
node bin/token-inspectour.js path/to/agent-b
```

Each instance takes the next free proxy and UI port pair (4141/4142, then 4143/4144, and so on) and serves its UI under the agent name, for example `http://127.0.0.1:4142/agent-a/` and `http://127.0.0.1:4144/agent-b/`. Each UI lists only its own agent's sessions. The name defaults to the project folder name; set it with `--name`.

### Proxy-only mode

Run only the proxy and UI, then attach Claude Code manually. Use this for headless pipelines, a fixed port, or several agents behind one proxy:

```sh
node bin/token-inspectour.js --proxy-only -p 4141
```

Then, from each project directory:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-a claude
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-b claude
```

The path segment after the port names the agent. The proxy strips it before forwarding and records it on every capture, so one UI lists both agents' sessions, labelled.

## Views

### Inspector

**Anatomy.** Stat tiles compare the server-reported prompt total with the sum of attributed parts and show the cache split. A donut and a stacked bar break tokens down by request area and by source kind. The *request map* is a zoomable icicle of the whole request body: `system`, `tools` (grouped into built-in tools and MCP servers), `messages` (one cell per message, then one per content block), and any tokens the parts do not account for. Clicking a cell zooms into it and opens it in the details panel. Accordions list the same structure:

- *Request envelope*: fields outside the three areas (`model`, `max_tokens`, `thinking`, `context_management`, `output_config`, `metadata`), as JSON.
- *System prompt*: the billing header, the Agent SDK preamble, and the harness prompt with its cache breakpoint.
- *Tools*: every tool definition, grouped into built-in tools and MCP servers, plus the tool-use framing the API adds once per request.
- *Messages*: one row per message with its role, block types, and token share, expanding into its content blocks. `<system-reminder>` blocks are split: each `Contents of <file>` section is attributed to its file, and skill, agent, and MCP-instruction listings are attributed line by line. Tool results are attributed to the file a `Read` call fetched or the skill a `Skill` call invoked.
  - *Relation map*: an arc diagram with messages in order on one axis and each called tool beside them; calls arc above the axis, results arc below, and arc width follows tokens. Reorder by position or by tokens; hovering a tool highlights its arcs.
  - *Tool cost flow*: a Sankey from call input, through each tool, to the result tokens returned into context, with error results separated.

Selecting a part opens the details panel: JSON path (for example `messages[12].content[1]`), exact or estimated tokens, the matching tool call or result, the tool definition, attribution spans, and the content, either verbatim with spans tinted by kind or as collapsible JSON from the captured body. Clicking a span opens the source file with the matched region highlighted.

**Sources.**
- *Usage flow*: a Sankey from source kind to file to request area (system, tools, messages), width by tokens.
- *Presence over the session*: a heatmap with one row per source and one column per step, shaded by tokens, with compaction calls marked. Clicking a cell opens that step.
- *Inventory structure*: a collapsible tree (project → scope → kind → file). Branches that sent nothing start collapsed; unsent files are drawn hollow.
- *Inventory*: a filterable table with each file's size, tokens in the current request, share, verbatim coverage, match types, locations, and the session steps that include it.

**Session.** A stacked area of each agent turn's context by source kind, above a cache panel that separates cache reads from misses (cache writes plus uncached input) under the prompt total. Both panels share a zoomable x axis (wheel to zoom, drag to pan, double-click to reset). A crosshair reads out every layer at a step; clicking opens that step. Side calls appear as ticks under the axis. A model filter separates loops that run on different models. Clicking a session header in the left column opens the same view.

**Diff.** Added, removed, and changed parts relative to the previous agent turn, with token deltas and the server's cache-read, cache-write, and uncached counts.

**Response.** The assembled streamed reply (text, thinking, tool calls with input as JSON), usage, stop reason, and timing.

**Raw.** Headers and bodies as captured, with credentials redacted, in a lazy JSON viewer that handles multi-megabyte bodies. Supports jump to path, expand to depth, and copy.

Keyboard: `j` / `k` select the next or previous step; `Esc` closes the details panel.

### Flow-graph page

The `flow-graph` link in the inspector header opens `/<agent>/graph`. The page has its own session picker and stays in sync with the inspector through the URL (`?session=…&request=…&mode=…`). It updates live as calls arrive. Modes:

- *Session flow*: agent turns on one lane, left to right or top to bottom. Each turn's tool calls sit in a column before the next turn, boxed per MCP server, with a dotted result edge into the next turn. Edge width follows tokens; the turn-to-turn edge is labelled with the tokens added. Subagent spawns and side calls (session titles, compaction) have distinct styles. The layout is deterministic, so live updates never move existing nodes. *fit* shows the whole session; *selected step* returns to the selected turn.
- *Agents timeline*: swimlanes over wall-clock time for the main agent, loops on other models, each subagent type (one row per instance), and side calls. Each request is a bar from start to end, shaded by prompt tokens, with a dashed link from a spawning turn to the subagent's first turn. Idle gaps longer than five minutes are compressed.
- *Spawn tree*: a collapsible tree from each spawning turn, through the Agent call, to every turn of the subagent and the tool calls it made.
- *Turn context*: a Sankey of one request, from sources (CLAUDE.md files, skills, memory, harness, tools) into the system, tools, and messages areas and into the request.

Subagent linking is exact. Every turn of a conversation resends the same first message, so the server tags each request with a hash of that message (`thread`), and a subagent's first message contains the prompt of the Agent call that started it.

Hovering highlights a node's neighbourhood; clicking opens a details panel with a link to that step in the inspector.

## Token counts

After the first captured request, the inspector reuses that session's auth headers to call `/v1/messages/count_tokens` for each part. Results are cached by content hash, so later turns count only what changed. Parts that cannot be counted fall back to a local estimate, marked `≈`.

- **Thinking blocks.** Thinking blocks from earlier turns usually carry empty text and an encrypted signature, which still costs input tokens. They are counted in place with the request's `thinking` and `context_management` settings, or estimated from the signature length when counting is unavailable.
- **Tool definitions.** Per-tool numbers are marginal costs. The API adds a fixed wrapper around any tool list; the wrapper appears as its own part.
- **Unattributed.** Any difference between the sum of parts and the server-reported prompt total is shown as "unattributed".

`--no-count` disables count_tokens calls.

## Project detection

The proxy is project-agnostic. It reads each session's project directory from the request (the working directory in the environment reminder, with `CLAUDE.md` paths as the fallback). It scans an inventory for each detected project on first sight and rescans when that project's configuration changes. A project without its own `.claude/` directory still gets the parent `CLAUDE.md` chain, user-level skills, agents, settings, memory, and plugins.

Subagent turns are captured like any other call and labelled with the agent definition whose body appears in their system prompt.

## Attribution

The scanner (`src/inventory.ts`) walks from the filesystem root to the project and collects:

- **Instructions:** every `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` on the way.
- **Project and user config:**
  - skills;
  - commands, namespaced `a:b` as Claude Code does;
  - agents;
  - settings (hooks, permissions, enabled plugins);
  - MCP configuration (`.mcp.json` and `~/.claude.json`).
- **Per project:** auto-memory and installed plugins.

The analyzer (`src/analyze.ts`) matches request text against that inventory:

| match | rule |
|---|---|
| `contents-of` | `Contents of <path> (…):` sections inside `<system-reminder>` blocks |
| `exact` | a file's body or full content appears verbatim |
| `partial` | a file is located by its first 120 characters and extended by longest common prefix; coverage is reported |
| `listing` | one line per skill, command, or agent in the harness listings; one section per server under `# MCP Server Instructions` |
| `tool-read` | a `Read` tool result, attributed to the file, or to the skill whose folder contains it |
| `skill-invoke` | a `Skill` tool result, attributed to the invoked skill or command |
| tool name | `mcp__<server>__<tool>` resolved to the MCP source; `claude_ai_*` servers are claude.ai connectors |

Remaining text is labelled by position: `reminder` inside a reminder, `harness` in the system prompt, `user` in a user turn, and so on. Side calls that Claude Code makes on its own (session-title generation, compaction) are labelled separately from agent turns.

## CLI

```
token-inspectour [projectDir] [options] [-- claude args…]

  projectDir            Project to launch Claude Code in (default: cwd)
  -- <args…>            Passed to claude
  --name <slug>         Agent name used in the routes (default: the project folder name)
  --proxy-only          Do not launch claude; run only the proxy + UI
  -p, --port <n>        Proxy port (default: first free port from 4141)
  -u, --ui <n>          UI port    (default: the port after the proxy port)
  --upstream <url>      Upstream API base URL (default https://api.anthropic.com)
  --no-open             Do not open the UI in the browser
  --no-count            Estimates only; never call count_tokens
  --no-persist          Do not write captures to disk
  --clear               Delete previously captured sessions on start
  -h, --help            Show help
```

## Data and privacy

All data stays on the local machine. The proxy listens on `127.0.0.1` only and forwards to the configured upstream API.

- **Captures:** stored in `~/.token-inspectour/captures/<session>/`, one JSON file per call, alongside an `index.jsonl` of their summaries. They contain prompts, file contents as sent to the model, and model replies; treat the directory as a transcript.
- **Credentials:** authorization headers are redacted before anything is written. Live auth headers are held in memory only, for count_tokens calls.
- **Logs:** in launch mode, the inspector's log goes to `~/.token-inspectour/logs/`.

Set `TOKEN_INSPECTOUR_HOME` to relocate all stored data. Use `--no-persist` to store nothing.

Captures accumulate: each turn of a session resends the whole conversation, so a long session
costs more on disk than a short one. Resident memory does not follow. Start-up reads each
session's `index.jsonl`, keeping one summary per call; full records are read back from their
capture files on demand and held in a cache bounded by `TOKEN_INSPECTOUR_CACHE_MB` (default
128). Deleting a session directory, or all of `captures/`, is safe at any time; `--clear` does
it on start. An `index.jsonl` that is missing, stale, or truncated is rebuilt from the capture
files next to it.

With `--no-persist` there are no capture files to read back from, so every record stays in
memory for as long as the process runs.

## Compatibility and limitations

- Developed against Claude Code 2.1.x on macOS. Attribution rules key off the harness's current wording (`Contents of …`, `The following skills are available`, `# MCP Server Instructions`, `Primary working directory:`). If a Claude Code release changes those strings, affected spans fall back to `harness` or `reminder` until the patterns in `src/analyze.ts` are updated.
- Claude Code must honour `ANTHROPIC_BASE_URL`. To chain an existing gateway, pass it with `--upstream`.
- The UI is two framework-free pages (`ui/index.html`, `ui/graph.html`) with compiled modules and vendored libraries. Browser coverage beyond recent Chromium-based browsers is untested.

## Development

```sh
npm run build       # tsc → dist/ (server, tests) and dist/ui/*.js (browser modules)
npm test            # build, then node --test dist/test/
npm run typecheck   # strict type check without emitting
```

Strict TypeScript compiled to ES modules. Dev dependencies are the TypeScript compiler and type packages.

| path | role |
|---|---|
| `src/types.ts` | shared data model (requests, sources, parts, spans, analyses, summaries, graph data) |
| `src/proxy.ts` | capture proxy |
| `src/sse.ts` | streaming response assembly |
| `src/inventory.ts` | source scanner |
| `src/analyze.ts` | attribution and counting |
| `src/tokens.ts` | count_tokens client and cache |
| `src/store.ts` | capture store and summaries |
| `src/server.ts` | UI server, JSON API, event stream |
| `src/graph.ts` | flow-graph data |
| `src/cli.ts` | command-line entry point |
| `ui/app.ts`, `ui/index.html` | inspector page |
| `ui/charts.ts` | shared d3 charts |
| `ui/json.ts` | JSON viewer |
| `ui/graph.ts`, `ui/graph.html` | flow-graph page |
| `ui/flow.ts` | session-flow renderer |
| `ui/agents.ts` | agents timeline and spawn tree |
| `ui/common.ts`, `ui/base.css` | shared helpers and styles |
| `ui/vendor/` | d3 (ISC) and d3-sankey (BSD-3-Clause) |

## Contributing

Report requests that are attributed incorrectly with an anonymised capture: remove message text and keep the structure.

## License

MIT
