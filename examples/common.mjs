// Shared helper for the example scripts: one Messages API call through the inspector's proxy.
export const BASE = (process.env.ANTHROPIC_BASE_URL || 'http://127.0.0.1:4141/examples').replace(/\/$/, '');
export const MODEL = process.env.MODEL || 'claude-sonnet-5-5';

export async function send(body, session) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('Set ANTHROPIC_API_KEY.');
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
      // Groups the calls of one run into one inspector session; the proxy does not forward it.
      'x-inspectour-session': session,
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 64, ...body }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${res.status} ${JSON.stringify(json)}`);
  return json;
}

export function usageLine(label, u) {
  const read = u.cache_read_input_tokens || 0;
  const write = u.cache_creation_input_tokens || 0;
  return `${label.padEnd(28)} uncached ${String(u.input_tokens).padStart(6)}   cache write ${String(write).padStart(6)}   cache read ${String(read).padStart(6)}`;
}

// Deterministic filler long enough to pass every model's minimum cacheable prefix.
export function longInstructions() {
  const rules = [];
  for (let i = 1; i <= 400; i++) rules.push(`Rule ${i}: keep answers short, cite the file and line for every claim, and never invent an API.`);
  return rules.join('\n');
}
