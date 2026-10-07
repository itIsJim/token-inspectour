# Changelog

## 0.2.0 (2026-10-07)

- Inspector UI rebuilt on d3: zoomable request map, JSON views for parts and raw bodies, relation map, and tool cost flow.
- Sources view: usage-flow Sankey, presence heatmap over the session, and inventory tree.
- Session view: stacked context area by source kind with a cache panel and a shared zoomable axis.
- Flow-graph page moved to `/<agent>/graph`, with session flow, agents timeline, spawn tree, and turn-context modes.
- Encrypted thinking signatures are counted instead of reported as empty.
- Capture records are read from disk on demand; resident memory is bounded by `TOKEN_INSPECTOUR_CACHE_MB`.
- Calls from clients other than Claude Code (SDK scripts, agent frameworks) are agent turns, grouped into sessions by the `x-inspectour-session` header or by agent name and first message; their system prompt and tools are attributed to the client.
- Compaction is detected from the summary instruction in the last user message, also when the request carries tools.
- `image` and `document` blocks, including those inside tool results, are counted as real blocks instead of placeholder text.
- `examples/` with scripts for conversation resend and prompt caching.
- The proxy and UI reject requests with a non-loopback `Host` header (DNS rebinding) and cross-site browser requests.
- Capture, log, and cache files are created owner-only (`0700` directories, `0600` files); `set-cookie` headers are redacted.
- Windows: `claude` launches through its `.cmd` shim and the browser opens with `rundll32`; a missing browser opener no longer crashes the process.
- The npm package includes the compiled UI modules (`dist/ui`).
- Launch mode starts `claude` with `ENABLE_TOOL_SEARCH=true` unless the variable is set, so MCP tool search stays on behind the proxy as in a direct session.
- README documents single-request measurement, other API clients, recipes, the JSON API, the tool-search behaviour behind a custom base URL, what `count_tokens` numbers mean, supported setups, references, third-party licenses, and a trademark notice.

## 0.1.0 (2026-09-09)

- Local capture proxy and browser UI that attribute each span of a Claude Code request to its source file, with token counts from `count_tokens`.
- Launches `claude` in a project by default; one inspector instance per agent, with routes named after the agent.
- Proxy-only mode with the agent named by the base-URL path segment.
- TypeScript source with no runtime dependencies.
