import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store, summarize, sessionKey } from '../src/store.js';
import type { CaptureRecord } from '../src/types.js';

const bodyText = (r: CaptureRecord | null): string => String(r?.body?.messages?.[0]?.content ?? '');

const withHome = <T>(fn: (home: string) => T): T => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ti-store-'));
  const prev = process.env.TOKEN_INSPECTOUR_HOME;
  process.env.TOKEN_INSPECTOUR_HOME = home;
  try {
    return fn(home);
  } finally {
    if (prev === undefined) delete process.env.TOKEN_INSPECTOUR_HOME;
    else process.env.TOKEN_INSPECTOUR_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
};

// A record whose body is `fill` KB of text, so cache budgets can be expressed in bytes.
const rec = (over: Partial<CaptureRecord> & { id: string; sessionId: string }, fill = 1): CaptureRecord => {
  const text = 'x'.repeat(fill * 1024);
  return {
    startedAt: '2024-01-01T00:00:00.000Z', method: 'POST', path: '/v1/messages', agent: 'agent-a',
    headers: {}, bytesIn: text.length, bytesOut: 10, bodyText: null, meta: {}, model: 'test-model',
    stream: false, toolCount: 0, messageCount: 1, status: 200, response: null,
    body: { model: 'test-model', messages: [{ role: 'user', content: text }] },
    ...over,
  } as CaptureRecord;
};

test('records are read back from disk, so the index alone stays resident', () => {
  withHome(() => {
    const a = new Store({ cacheBytes: 4 * 1024 });
    for (let i = 0; i < 20; i++) a.save(a.addRequest(rec({ id: `r${i}`, sessionId: 's1' }, 8)));

    const b = new Store({ cacheBytes: 4 * 1024 });
    b.load();
    assert.equal(b.index.size, 20);
    assert.equal(b.sessions.get('s1')!.requests.length, 20);
    // loading builds the index without holding a single full record
    assert.equal(b.heldCount, 0);

    const got = b.get('r7');
    assert.ok(got);
    assert.equal(bodyText(got), 'x'.repeat(8 * 1024));
    assert.equal(got!.seq, 8);

    // walking every record keeps at most one over the budget
    for (const r of b.records('s1')) assert.ok(r.id);
    assert.ok(b.heldCount <= 2, `held ${b.heldCount}`);
    assert.equal([...b.records('s1')].length, 20);
  });
});

test('capture files larger than the text read cap load intact', () => {
  withHome(() => {
    const big = 5 * 1024; // 5 MB of body, past readTextSafe's 4 MB cap
    const a = new Store();
    a.save(a.addRequest(rec({ id: 'big', sessionId: 's1' }, big)));

    const b = new Store();
    b.load();
    assert.equal(b.index.size, 1);
    assert.equal(bodyText(b.get('big')).length, big * 1024);
  });
});

test('the session index is rebuilt from capture files and compacted', () => {
  withHome((home) => {
    const a = new Store();
    for (let i = 0; i < 3; i++) {
      const r = a.addRequest(rec({ id: `r${i}`, sessionId: 's/1' }));
      a.save(r);
      a.save(r); // an update appends another line for the same call
    }
    const dir = path.join(home, 'captures', sessionKey('s/1'));
    const lines = (): string[] => fs.readFileSync(path.join(dir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean);
    assert.equal(lines().length, 6);

    const b = new Store();
    b.load();
    assert.equal(b.index.size, 3);
    assert.equal(lines().length, 3); // superseded lines dropped on load

    // a capture file the index does not mention is recovered, and a torn line ignored
    fs.copyFileSync(path.join(dir, '00001-r0.json'), path.join(dir, '00009-r9.json'));
    const stray = JSON.parse(fs.readFileSync(path.join(dir, '00009-r9.json'), 'utf8')) as CaptureRecord;
    stray.id = 'r9';
    stray.seq = 9;
    fs.writeFileSync(path.join(dir, '00009-r9.json'), JSON.stringify(stray));
    fs.appendFileSync(path.join(dir, 'index.jsonl'), '{"s":{"id":"torn"');

    const c = new Store();
    c.load();
    assert.equal(c.index.size, 4);
    assert.deepEqual(c.sessions.get('s/1')!.requests, ['r0', 'r1', 'r2', 'r9']);
    assert.equal(c.seq, 9);
    assert.equal(lines().length, 4);
    assert.ok(c.get('r9'));
  });
});

test('a project detected late re-points the calls captured before it', () => {
  withHome(() => {
    const a = new Store();
    a.save(a.addRequest(rec({ id: 'r0', sessionId: 's1', projectDir: '/Users/me/fallback', projectDetected: false })));
    a.save(a.addRequest(rec({ id: 'r1', sessionId: 's1', projectDir: '/Users/me/proj', projectDetected: true })));
    a.repointProject('s1', '/Users/me/proj');

    const b = new Store();
    b.load();
    assert.equal(b.sessions.get('s1')!.projectDir, '/Users/me/proj');
    assert.deepEqual(b.summaries('s1').map((s) => s.projectDir), ['/Users/me/proj', '/Users/me/proj']);
    // the index is authoritative: a record read back carries the re-pointed project
    assert.equal(b.get('r0')!.projectDir, '/Users/me/proj');
  });
});

test('calls still in flight are never evicted', () => {
  withHome(() => {
    const s = new Store({ cacheBytes: 1 });
    const live = s.addRequest(rec({ id: 'live', sessionId: 's1', status: null }, 8));
    s.save(live);
    for (let i = 0; i < 10; i++) s.save(s.addRequest(rec({ id: `r${i}`, sessionId: 's1' }, 8)));
    assert.equal(s.get('live'), live); // the same object the proxy is still writing to
    live.status = 200;
    s.update(live, 'response');
    for (let i = 10; i < 20; i++) s.save(s.addRequest(rec({ id: `r${i}`, sessionId: 's1' }, 8)));
    assert.ok(s.heldCount <= 2, `held ${s.heldCount}`);
  });
});

test('without persistence every record stays resident', () => {
  withHome(() => {
    const s = new Store({ persist: false, cacheBytes: 1 });
    for (let i = 0; i < 5; i++) s.update(s.addRequest(rec({ id: `r${i}`, sessionId: 's1' }, 8)), 'response');
    assert.equal(s.heldCount, 5);
    assert.equal(s.get('r0')!.id, 'r0');
    assert.equal(s.listSessions()[0].requests.length, 5);
  });
});

test('summaries carry what the session list renders', () => {
  withHome(() => {
    const s = new Store();
    const r = s.addRequest(rec({ id: 'r0', sessionId: 's1', userPreview: 'hello' }));
    s.save(r);
    assert.deepEqual(s.summaries('s1')[0], summarize(r));
    assert.equal(s.listSessions()[0].requests[0].userPreview, 'hello');
  });
});
