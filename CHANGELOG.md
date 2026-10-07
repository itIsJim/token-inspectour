# Changelog

## 0.2.0 (2026-10-07)

- Inspector UI rebuilt on d3: zoomable request map, JSON views for parts and raw bodies, relation map, and tool cost flow.
- Sources view: usage-flow Sankey, presence heatmap over the session, and inventory tree.
- Session view: stacked context area by source kind with a cache panel and a shared zoomable axis.
- Flow-graph page moved to `/<agent>/graph`, with session flow, agents timeline, spawn tree, and turn-context modes.
- Encrypted thinking signatures are counted instead of reported as empty.
- Capture records are read from disk on demand; resident memory is bounded by `TOKEN_INSPECTOUR_CACHE_MB`.
- README documents single-request measurement and the JSON API.

## 0.1.0 (2026-09-09)

- Local capture proxy and browser UI that attribute each span of a Claude Code request to its source file, with token counts from `count_tokens`.
- Launches `claude` in a project by default; one inspector instance per agent, with routes named after the agent.
- Proxy-only mode with the agent named by the base-URL path segment.
- TypeScript source with no runtime dependencies.
