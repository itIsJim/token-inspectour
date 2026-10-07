// Prompt caching and a timestamp. Sends the same long system prompt twice per variant:
//   A: the current time at the start of the system prompt, so the cached prefix changes every call;
//   B: the same prompt with the time moved into the last user message, so the prefix stays fixed.
// The second call of B reads the prefix from cache; the second call of A writes it again.
import { send, usageLine, longInstructions } from './common.mjs';

const instructions = longInstructions();
const run = Date.now().toString(36);

async function variant(name, build) {
  for (const call of [1, 2]) {
    const now = new Date().toISOString();
    const { system, messages } = build(now);
    const r = await send({ system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }], messages }, `cache-${name}-${run}`);
    console.log(usageLine(`${name} call ${call}`, r.usage));
    await new Promise((ok) => setTimeout(ok, 1500));
  }
}

await variant('A-time-in-system', (now) => ({
  system: `Current time: ${now}\n\n${instructions}`,
  messages: [{ role: 'user', content: 'Reply with OK.' }],
}));
await variant('B-time-in-message', (now) => ({
  system: instructions,
  messages: [{ role: 'user', content: `Current time: ${now}\n\nReply with OK.` }],
}));
