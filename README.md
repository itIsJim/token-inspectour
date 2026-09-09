# token-inspectour

See what Claude Code actually sends to the model.

`token-inspectour` is a local proxy plus a browser UI. You point it at an agent project folder and run Claude Code through it. Every API call the binary makes is captured, and every span of the request is mapped back to the file that produced it: the `CLAUDE.md` chain, rules, skills, slash commands, agents, hooks, MCP servers, auto-memory, plugins, and the built-in harness. Each part carries an exact token count, so you can see where the context window goes, how it changes from step to step, and which of your project files are actually reaching the model.

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
# 1. start the inspector, pointed at the project you want to understand
node bin/token-inspectour.js ~/path/to/agent-project --open

# 2. in another terminal, run Claude Code through the proxy
cd ~/path/to/agent-project
ANTHROPIC_BASE_URL=http://127.0.0.1:4141 claude
```

Or let the inspector launch Claude Code for you (arguments after `--run` go to `claude`):

```sh
node bin/token-inspectour.js ~/path/to/agent-project --run
node bin/token-inspectour.js ~/path/to/agent-project --run -p "summarize the repo"
```

Open http://127.0.0.1:4142. Each API call shows up on the left as it happens.

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

Anything left over inside a reminder is `reminder`, inside the system prompt is `harness`, in a user turn is `user`, and so on. Side calls that Claude Code makes (session-title generation, compaction) are captured and labelled separately from agent turns.

## CLI

```
token-inspectour [projectDir] [options]

  -p, --port <n>        Proxy port Claude Code connects to        (default 4141)
  -u, --ui <n>          UI port                                   (default 4142)
  --upstream <url>      Real API base URL                         (default https://api.anthropic.com)
  --run [args…]         Launch `claude` in projectDir through the proxy
  --no-count            Estimates only; never call count_tokens
  --no-persist          Do not write captures to ~/.token-inspectour
  --clear               Delete previously captured sessions on start
  --open                Open the UI in the browser
```

Captures live in `~/.token-inspectour/captures/<session>/`, one JSON per call, with auth headers redacted. Set `TOKEN_INSPECTOUR_HOME` to move that directory.

## Notes

- Works with OAuth (`claude login`) sessions and API keys alike; the proxy forwards whatever headers Claude Code sends.
- The inventory rescans automatically when files under `.claude/`, `CLAUDE.md`, `.mcp.json`, or the user's `~/.claude` change.
- The UI is a single dependency-free HTML file (`ui/index.html`); the server is plain `node:http`.
- Tests: `npm test`.
