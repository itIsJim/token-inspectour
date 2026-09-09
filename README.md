# token-inspectour

See what Claude Code actually sends to the model.

`token-inspectour` is a local proxy plus a browser UI. You start it once and run Claude Code through it from any project. Every API call the binary makes is captured, and every span of the request is mapped back to the file that produced it: the `CLAUDE.md` chain, rules, skills, slash commands, agents, hooks, MCP servers, auto-memory, plugins, and the built-in harness. Each part carries an exact token count, so you can see where the context window goes, how it changes from step to step, and which of your project files are actually reaching the model.

```
┌─────────────┐  ANTHROPIC_BASE_URL   ┌──────────────────┐  forwards   ┌──────────────────┐
│ claude code │ ───────────────────▶  │ token-inspectour │ ──────────▶ │ api.anthropic.com│
│  (binary)   │ ◀─────────────────── │   proxy :4141    │ ◀────────── │                  │
└─────────────┘   streamed response   └────────┬─────────┘             └──────────────────┘
                                               │ captures request + response
                                               ▼
                                      ┌──────────────────┐
                                      │   UI  :4142      │  anatomy · sources · step diff · response · raw
                                      └──────────────────┘
```

## Quick start

Requires Node 18.17+ and a working `claude` login. No dependencies to install.

```sh
node bin/token-inspectour.js ~/path/to/agent-project
```

That starts the proxy and the UI, opens the UI in your browser, and launches `claude` in that project through the proxy, all in the current terminal. Use Claude Code as normal. Each API call shows up in the UI as it happens. When Claude Code exits, the inspector keeps serving the UI until you press Ctrl-C.

Anything after `--` is passed to `claude`:

```sh
node bin/token-inspectour.js ~/path/to/agent-project -- -p "summarize the repo"
node bin/token-inspectour.js ~/path/to/agent-project -- --continue
```

### Inspecting several agents at once

Run one inspector per agent, each in its own terminal:

```sh
# terminal 1
node bin/token-inspectour.js ~/agents/growth
# terminal 2
node bin/token-inspectour.js ~/agents/sales
```

Every instance picks the next free proxy and UI ports (4141/4142, then 4143/4144, and so on) and opens its own browser tab, titled with the project name and port. Each UI shows the sessions its own proxy captured.

### Proxy-only mode

If you would rather attach Claude Code yourself, or run a headless pipeline through a fixed port:

```sh
node bin/token-inspectour.js --proxy-only -p 4141
# any project, any terminal, on one line:
cd ~/path/to/agent-project && ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

### Works with any agent

The proxy is project-agnostic. Each session's project directory is read from the request itself (the harness tells the model its working directory; the `CLAUDE.md` paths are the fallback), and an inventory is scanned per detected project on first sight. A project with no `.claude/` of its own still gets a meaningful inventory: the parent `CLAUDE.md` chain, user-level skills, agents, settings, memory, and plugins.

Subagent turns (the Agent tool) are captured like any other call and labelled with the agent definition whose body appears in their system prompt. Skill invocations and file reads are attributed to the skill or file they came from.

## What you see

**Anatomy.** The request split into its three areas, with a stacked bar of tokens by source kind.

- *System prompt*: the billing header, the Agent SDK preamble, and the harness prompt (with its cache breakpoint).
- *Tools*: every tool definition, grouped into built-in tools and MCP servers, plus the tool-use framing the API adds once per request.
- *Messages*: every content block, with the `<system-reminder>` blocks opened up. Inside them, each `Contents of <file>` section is attributed to that file, and the skill, agent, and MCP-instruction listings are attributed line by line.

Expand any part to read its text with each span tinted by kind. Hover a span for its token count. Click a span to open the source file on the right with the matched region highlighted.

**Sources.** The full inventory the scanner found for the project: which files are sent, how many tokens each costs in this request, how much of the file arrived verbatim (coverage), and which steps of the session include it. Unused files are listed too, so you can spot a skill that never gets pulled in.

**Diff.** The change from the previous agent turn in the same session: added, removed, and changed parts with token deltas, next to the server's own cache-read / cache-write / uncached numbers.

**Response.** The assembled streamed reply (text, thinking, tool calls), usage, stop reason, and timing.

**Raw.** Headers and bodies as captured.

## Token counts

Counts are exact, not estimated. After the first captured request, the inspector reuses that session's auth headers to call `/v1/messages/count_tokens` for each part. Results are cached by content hash in `~/.token-inspectour/token-cache.json`, so a second turn only counts what changed. Parts that could not be counted fall back to a local estimate and are marked with `≈`.

Per-tool numbers are marginal costs. The API adds a fixed wrapper around any tool list; that wrapper is shown as its own part ("tool-use framing") so that the sum of parts matches the server's reported prompt total. On real runs the two agree to within about 0.05%.

Use `--no-count` to disable the count_tokens calls entirely.

## How attribution works

The scanner (`src/inventory.js`) walks from the filesystem root down to the project and picks up every `CLAUDE.md`, `CLAUDE.local.md`, `.claude/CLAUDE.md`, and `.claude/rules/*.md` on the way, then the project's and user's skills, commands (namespaced `a:b` like Claude Code does), agents, settings (hooks, permissions, enabled plugins), MCP config (`.mcp.json` and `~/.claude.json`), auto-memory for the project, and installed plugins.

The analyzer (`src/analyze.js`) then matches request text against that inventory:

| match | how |
|---|---|
| `contents-of` | `Contents of <path> (…):` sections inside `<system-reminder>` blocks |
| `exact` | a file's body or full content appearing verbatim (skill bodies after `Skill(...)`, injected files) |
| `partial` | a file located by its first 120 chars and extended by longest common prefix, reported with coverage |
| `listing` | one line per skill, command, or agent in the harness listings; one section per server under `# MCP Server Instructions` |
| tool name | `mcp__<server>__<tool>` resolved to the MCP source; `claude_ai_*` servers are claude.ai connectors |
| `tool-read` | a `Read` tool result, attributed to the file (or the skill whose folder contains it) |
| `skill-invoke` | a `Skill` tool result, attributed to the invoked skill or command |
| subagent | an agent definition body found in a request's system prompt labels that call `subagent: <name>` |

Anything left over inside a reminder is `reminder`, inside the system prompt is `harness`, in a user turn is `user`, and so on. Side calls that Claude Code makes (session-title generation, compaction) are captured and labelled separately from agent turns.

## CLI

```
token-inspectour [projectDir] [options] [-- claude args…]

  projectDir            Project to launch Claude Code in (default: cwd)
  -- <args…>            Passed to claude
  --proxy-only          Do not launch claude; just run the proxy + UI
  -p, --port <n>        Proxy port (default: first free port from 4141)
  -u, --ui <n>          UI port    (default: the port after the proxy port)
  --upstream <url>      Real API base URL (default https://api.anthropic.com)
  --no-open             Do not open the UI in the browser
  --no-count            Estimates only; never call count_tokens
  --no-persist          Do not write captures to ~/.token-inspectour
  --clear               Delete previously captured sessions on start
```

Captures live in `~/.token-inspectour/captures/<session>/`, one JSON per call, with auth headers redacted. In launch mode the inspector's own log goes to `~/.token-inspectour/logs/inspector-<port>.log` so it never draws over Claude Code's screen. Set `TOKEN_INSPECTOUR_HOME` to move that directory.

## Notes

- Works with OAuth (`claude login`) sessions and API keys alike; the proxy forwards whatever headers Claude Code sends.
- The inventory rescans automatically when files under `.claude/`, `CLAUDE.md`, `.mcp.json`, or the user's `~/.claude` change.
- The UI is a single dependency-free HTML file (`ui/index.html`); the server is plain `node:http`.
- Tests: `npm test`.
