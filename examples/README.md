# Examples

Scripts that call the Messages API directly through the inspector, to observe request mechanics outside Claude Code. They need Node 18.17 or later and an API key; there is nothing to install.

Start the proxy in one terminal:

```sh
node bin/token-inspectour.js --proxy-only -p 4141
```

Run a script from the repository root in another:

```sh
export ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_BASE_URL=http://127.0.0.1:4141/examples node examples/resend-turns.mjs
```

| script | shows |
|---|---|
| `resend-turns.mjs` | five turns of one conversation; input tokens grow with every turn because the whole conversation is resent |
| `cache-timestamp.mjs` | a timestamp at the start of the system prompt changes the cached prefix on every call; the same timestamp in the last message leaves the prefix cacheable |

Each run is one session in the UI (`http://127.0.0.1:4142/examples/`), named by the `x-inspectour-session` header. Set `MODEL` to change the model (default `claude-sonnet-5-5`). The scripts send short prompts with `max_tokens: 64`; `cache-timestamp.mjs` sends a system prompt of several thousand tokens four times.
