import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import net from 'node:net';
import { parseArgs, freePort } from '../src/cli.js';

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
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const busy = srv.address().port;
  const p = await freePort(busy);
  assert.notEqual(p, busy);
  assert.ok(p > busy);
  const q = await freePort(busy + 1, '127.0.0.1', new Set([busy + 1]));
  assert.ok(q > busy + 1);
  srv.close();
});
