import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { parseArgs, freePort, slugify } from '../src/cli.js';
import { splitAgentPrefix, sessionIdFor } from '../src/proxy.js';

test('launching claude is the default; -- and --run pass args through; --proxy-only disables', () => {
  const d = parseArgs([]);
  assert.equal(d.proxyOnly, false);
  assert.deepEqual(d.run, []);
  assert.equal(d.open, true);
  assert.equal(d.port, null);
  const a = parseArgs(['/tmp', '--no-open', '--', '-p', 'hi there']);
  assert.equal(a.projectDir, path.resolve('/tmp'));
  assert.equal(a.open, false);
  assert.deepEqual(a.run, ['-p', 'hi there']);
  assert.deepEqual(parseArgs(['--run', '--continue']).run, ['--continue']);
  const p = parseArgs(['--proxy-only', '-p', '5000', '-u', '5001']);
  assert.equal(p.proxyOnly, true);
  assert.equal(p.port, 5000);
  assert.equal(p.ui, 5001);
  assert.throws(() => parseArgs(['--bogus']));
});

test('freePort skips ports that are in use', async () => {
  const srv = net.createServer();
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const busy = (srv.address() as net.AddressInfo).port;
  const p = await freePort(busy);
  assert.notEqual(p, busy);
  assert.ok(p > busy);
  const q = await freePort(busy + 1, '127.0.0.1', new Set([busy + 1]));
  assert.ok(q > busy + 1);
  srv.close();
});

test('agent names become route slugs; the proxy strips the agent prefix', () => {
  assert.equal(slugify('My Agent'), 'my-agent');
  assert.equal(slugify('v1'), 'agent');
  assert.equal(slugify(''), 'agent');
  assert.deepEqual(splitAgentPrefix('/agent-a/v1/messages?beta=true'), { agent: 'agent-a', path: '/v1/messages?beta=true' });
  assert.deepEqual(splitAgentPrefix('/v1/messages?beta=true'), { agent: null, path: '/v1/messages?beta=true' });
  assert.deepEqual(splitAgentPrefix('/api/hello'), { agent: null, path: '/api/hello' });
  assert.deepEqual(splitAgentPrefix('/agent.b/api/hello'), { agent: 'agent.b', path: '/api/hello' });
});

test('sessions: Claude Code metadata, then the session header, then agent and first message', () => {
  const body = { model: 'm', messages: [{ role: 'user' as const, content: 'hello' }] };
  assert.equal(sessionIdFor(body, { session_id: 'abc' }, 'run-1', 'agent-a'), 'abc');
  assert.equal(sessionIdFor(body, {}, 'run 1/../x', 'agent-a'), 'run-1-x');
  const a = sessionIdFor(body, {}, undefined, 'agent-a');
  assert.match(a, /^agent-a-[0-9a-f]{12}$/);
  const next = { model: 'm', messages: [...body.messages, { role: 'assistant' as const, content: 'hi' }, { role: 'user' as const, content: 'again' }] };
  assert.equal(sessionIdFor(next, {}, undefined, 'agent-a'), a);
  assert.notEqual(sessionIdFor({ model: 'm', messages: [{ role: 'user' as const, content: 'other' }] }, {}, undefined, 'agent-a'), a);
  assert.match(sessionIdFor(body, {}, undefined, null), /^client-/);
  assert.equal(sessionIdFor(null, {}, undefined, 'agent-a'), 'unknown');
});

test('only loopback hosts and same-site browser requests are served', async () => {
  const { isLocalRequest, redactHeaders } = await import('../src/util.js');
  assert.equal(isLocalRequest({ host: '127.0.0.1:4142' }), true);
  assert.equal(isLocalRequest({ host: 'localhost:4142', origin: 'http://localhost:4142', 'sec-fetch-site': 'same-origin' }), true);
  assert.equal(isLocalRequest({ host: '[::1]:4142' }), true);
  assert.equal(isLocalRequest({ host: 'attacker.example:4142' }), false);
  assert.equal(isLocalRequest({ host: '127.0.0.1:4142', origin: 'https://attacker.example' }), false);
  assert.equal(isLocalRequest({ host: '127.0.0.1:4142', 'sec-fetch-site': 'cross-site' }), false);
  assert.equal(isLocalRequest({}), false);
  const r = redactHeaders({ authorization: 'Bearer x', 'x-api-key': 'k', 'set-cookie': ['a=b'], 'anthropic-version': '2023-06-01' });
  assert.deepEqual(r, { authorization: '<redacted>', 'x-api-key': '<redacted>', 'set-cookie': '<redacted>', 'anthropic-version': '2023-06-01' });
});
