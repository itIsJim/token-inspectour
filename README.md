# token-inspectour

**Inspect what Claude Code sends to the model.**

token-inspectour is a local proxy with a browser UI. It sits between Claude Code and the Anthropic API, captures every request, and maps each span of each request back to the file that produced it: the `CLAUDE.md` chain, rules, skills, slash commands, subagents, hooks, MCP servers, auto-memory, plugins, and the built-in harness. Every part carries a token count from the API's `count_tokens` endpoint, which shows where the context window goes, how it changes from step to step, and which project files reach the model.

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
- [Claude Code](https://code.claude.com/docs/en/overview) installed and signed in to the Anthropic API, with a claude.ai subscription or an API key. Setting `ANTHROPIC_BASE_URL` alone keeps the existing login, its usage limits, and its billing ([LLM gateway documentation](https://code.claude.com/docs/en/llm-gateway)).
- Claude Code configured for Amazon Bedrock, Google Cloud, or Microsoft Foundry uses provider-specific endpoints and is not supported.

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

This starts the proxy and the UI, opens the UI in the default browser, and runs `claude` in the project through the proxy, in the current terminal. Each API call appears in the UI as it happens. After Claude Code exits, the UI keeps serving until Ctrl-C. The launched `claude` gets `ENABLE_TOOL_SEARCH=true` unless the variable is already set (see [Tool search](#compatibility-and-limitations)).

Pass arguments to `claude` after `--`:

```sh
node bin/token-inspectour.js path/to/project -- --continue
node bin/token-inspectour.js path/to/project -- -p "<prompt>"
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
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-a claude
ENABLE_TOOL_SEARCH=true ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-b claude
```

The path segment after the port names the agent. The proxy strips it before forwarding and records it on every capture, so one UI lists both agents' sessions, labelled.

### Measuring a single request

Send one headless prompt through the inspector:

```sh
node bin/token-inspectour.js path/to/project -- -p "<prompt>"
```

Claude Code answers and exits; the UI keeps serving. Select the first agent turn in the left column. **Anatomy** shows the prompt total reported by the server (`usage`), the sum of the attributed parts, and the split by request area (`system`, `tools`, `messages`) and by source kind. The *Tools* accordion separates built-in tools from each MCP server, and the *Messages* accordion shows which `CLAUDE.md` files and reminders were sent.

The totals depend on the environment, not only on the prompt: the Claude Code version, the model, connected MCP servers and claude.ai connectors, installed skills and plugins, and every `CLAUDE.md` above the project. Record these with any number taken from a capture, and compare runs made on the same machine and configuration. Tool definitions are usually the largest area, and grow with each connected MCP server.

With `--no-count`, per-part numbers are local estimates (`≈`); the prompt total still comes from the server's `usage`.

### Other API clients

Proxy-only mode captures any client that sends Messages API calls to a configurable base URL: SDK scripts, agent frameworks, or `curl`. Both official SDKs read `ANTHROPIC_BASE_URL`:

```sh
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/agent-a python agent.py
```

Calls from clients other than Claude Code are treated as agent turns, so the Session, Diff, and flow-graph views follow them. They are grouped into sessions by, in order:

1. the `x-inspectour-session` request header, when set (the proxy does not forward it);
2. otherwise the agent name and the first message: every turn of one conversation resends the same first message, so a multi-turn loop stays in one session.

Without Claude Code's harness there are no `CLAUDE.md`, skill, or memory spans to attribute: the system prompt and tool definitions are attributed to the client (`user`), and messages by role (`user`, `model`, `tool-result`). The [`examples/`](examples/) directory has two runnable scripts: five turns of one conversation, and a timestamp that defeats prompt caching.

### Recipes

- **Which files reach the model.** In **Sources**, the *Inventory* table lists every scanned file with its tokens in the selected request; in *Inventory structure*, files that were never sent are drawn hollow. For memory files, run several sessions under one agent name and compare each memory file's *steps* column with the files on disk.
- **When a skill loads.** In the *Presence over the session* heatmap, a skill's listing line appears from the first step; its body appears only from the step after the `Skill` call. Files that the skill's instructions read with `Bash` arrive as plain tool results and are not attributed to the skill.
- **An agent loop, turn by turn.** **Response** shows each call's `stop_reason` (`tool_use` for intermediate turns, `end_turn` for the last); the *Session flow* mode of the flow-graph page draws the tool calls between turns.
- **What a tool description says.** The *Tools* accordion in **Anatomy** shows each tool definition exactly as sent, grouped by MCP server, with its marginal token cost.
- **What compaction keeps.** Compaction calls are marked on the heatmap and labelled `compaction` in the call list. **Diff** on the next agent turn lists what was removed and what was reloaded.

## Views

### Inspector

**Anatomy.** Stat tiles compare the server-reported prompt total with the sum of attributed parts and show the cache split. A donut and a stacked bar break tokens down by request area and by source kind. The *request map* is a zoomable icicle of the whole request body: `system`, `tools` (grouped into built-in tools and MCP servers), `messages` (one cell per message, then one per content block), and any tokens the parts do not account for. Clicking a cell zooms into it and opens it in the details panel. Accordions list the same structure:

- *Request envelope*: fields outside the three areas (`model`, `max_tokens`, `thinking`, `context_management`, `output_config`, `metadata`), as JSON.
- *System prompt*: the billing header, the Agent SDK preamble, and the harness prompt with its cache breakpoint.
- *Tools*: every tool definition, grouped into built-in tools and MCP servers, plus the tool-use framing the API adds once per request.
- *Messages*: one row per message with its role, block types, and token share, expanding into its content blocks. `<system-reminder>` blocks are split: each `Contents of <file>` section is attributed to its file, and skill, agent, and MCP-instruction listings are attributed line by line. Tool results are attributed to the file a `Read` call fetched or the skill a `Skill` call invoked.
  - *Relation map*: an arc diagram with messages in order on one axis and each called tool beside them; calls arc above the axis, results arc below, and arc width follows tokens. Reorder by position or by tokens; hovering a tool highlights its arcs.
  - *Tool cost flow*: a Sankey from call input, through each tool, to the result tokens returned into context, with error results separated.

Selecting a part opens the details panel: JSON path (for example `messages[12].content[1]`), counted or estimated tokens, the matching tool call or result, the tool definition, attribution spans, and the content, either verbatim with spans tinted by kind or as collapsible JSON from the captured body. Clicking a span opens the source file with the matched region highlighted.

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

`count_tokens` is the API's own counter, but the API documentation describes its result as an estimate: it can differ slightly from the `usage` the call itself reports. The prompt total in Anatomy is always the server's `usage`; the counts per part are `count_tokens` results.

- **Thinking blocks.** Thinking blocks from earlier turns usually carry empty text and an encrypted signature, which still costs input tokens. They are counted in place with the request's `thinking` and `context_management` settings, or estimated from the signature length when counting is unavailable.
- **Tool definitions.** Per-tool numbers are marginal costs. The API adds a fixed wrapper around any tool list; the wrapper appears as its own part.
- **Images and documents.** `image` and `document` blocks, including those inside tool results, are counted as the real block, so a PDF shows its full cost. Local estimates do not cover them; with `--no-count` their cost appears as unattributed.
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

## JSON API

The UI reads everything from a JSON API under the instance's base URL, for example `http://127.0.0.1:4142/agent-a/`. Use it to script measurements:

```sh
curl -s http://127.0.0.1:4142/agent-a/api/sessions               # sessions with one summary per call
curl -s http://127.0.0.1:4142/agent-a/api/requests/<id>          # one call: usage, analysis totals, parts
curl -s 'http://127.0.0.1:4142/agent-a/api/requests/<id>?full=1' # full analysis with spans and inventory
```

| method | path | returns |
|---|---|---|
| GET | `api/state` | instance settings, counter status, inventory, sessions |
| GET | `api/sessions` | sessions and their call summaries (`usage`, `toolCount`, `kind`, `model`) |
| GET | `api/requests/<id>` | one call; `analysis.promptTotalFromUsage`, `analysis.totals.byArea`, `analysis.totals.byKind`, `analysis.parts` |
| GET | `api/requests/<id>/raw` | captured request and response bodies and headers, credentials redacted |
| GET | `api/requests/<id>/graph` | turn-context Sankey data |
| GET | `api/sessions/<id>/graph` | session flow-graph data |
| GET | `api/sources/<id>` | one inventory source with its content |
| GET | `events` | server-sent events: `session`, `request`, `response`, `analysis`, `inventory`, `cleared`, `log` |
| POST | `api/requests/<id>/recount` | re-analyse one call with `count_tokens` |
| POST | `api/rescan` | rescan the inventory |
| POST | `api/clear` | delete all captured sessions |

## Data and privacy

All data stays on the local machine. The proxy and the UI listen on `127.0.0.1` only; the proxy forwards to the configured upstream API and nowhere else. No telemetry is collected.

- **Local requests only:** both servers reject requests whose `Host` header is not a loopback address, which blocks DNS-rebinding attacks from web pages, and reject browser requests sent from another site.
- **Captures:** stored in `~/.token-inspectour/captures/<session>/`, one JSON file per call, alongside an `index.jsonl` of their summaries. They contain prompts, file contents as sent to the model, model replies, and identifiers such as `metadata.user_id` and organization headers; treat the directory as a transcript. Directories are created with mode `0700` and files with mode `0600`.
- **Credentials:** `authorization`, `x-api-key`, `cookie`, `set-cookie`, and `proxy-authorization` headers are redacted before anything is written. Live auth headers are held in memory only, for count_tokens calls, which are free of charge ([token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting)).
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

- Developed and tested against Claude Code 2.1.x on macOS. Linux and Windows are handled in the code (browser opening, launching `claude` through the `.cmd` shim on Windows) but untested. Attribution rules key off the harness's current wording (`Contents of …`, `The following skills are available`, `# MCP Server Instructions`, `Primary working directory:`). If a Claude Code release changes those strings, affected spans fall back to `harness` or `reminder` until the patterns in `src/analyze.ts` are updated.
- Claude Code must honour `ANTHROPIC_BASE_URL`. Organizations can pin it through managed settings (`allowedProviders`), which makes Claude Code refuse a local proxy. To chain an existing gateway, pass it with `--upstream`.
- **Tool search.** Claude Code turns off MCP tool search when `ANTHROPIC_BASE_URL` points to a host other than the Anthropic API ([MCP documentation](https://code.claude.com/docs/en/mcp)); every MCP tool definition is then sent in full, and the request can be several times larger than in a direct session. `ENABLE_TOOL_SEARCH=true` keeps tool search on, and the proxy forwards request bodies and headers unchanged, including `tool_reference` blocks. Launch mode sets it for the `claude` it starts unless the variable is already set; in proxy-only mode, set it in the environment of `claude` as shown above. Set `ENABLE_TOOL_SEARCH=false` to capture the full tool list instead.
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
| `examples/` | Messages API scripts to run through the proxy |

## Contributing

Issues and pull requests are welcome on GitHub. To report a request that is attributed incorrectly, attach an anonymised capture: replace message text and file contents, remove `metadata.user_id`, and remove organization or account headers, keeping the structure. Run `npm test` before opening a pull request.

## References

- Claude Code: [LLM gateways and `ANTHROPIC_BASE_URL`](https://code.claude.com/docs/en/llm-gateway), [memory and `CLAUDE.md`](https://code.claude.com/docs/en/memory), [MCP and tool search](https://code.claude.com/docs/en/mcp), [settings](https://code.claude.com/docs/en/settings)
- Claude API: [Messages](https://platform.claude.com/docs/en/api/messages), [token counting](https://platform.claude.com/docs/en/build-with-claude/token-counting), [prompt caching](https://platform.claude.com/docs/en/build-with-claude/prompt-caching)
- Vendored libraries: [d3](https://github.com/d3/d3) 7.9.0, [d3-sankey](https://github.com/d3/d3-sankey) 0.12.3

## License

[MIT](LICENSE).

Third-party code in `ui/vendor/` keeps its own license: d3 under the ISC license (`ui/vendor/LICENSE-d3`) and d3-sankey under the BSD 3-Clause license (`ui/vendor/LICENSE-d3-sankey`), both Copyright Mike Bostock.

Claude, Claude Code, and Anthropic are trademarks of Anthropic, PBC. token-inspectour is an independent project and is not affiliated with, sponsored by, or endorsed by Anthropic.
