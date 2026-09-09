import test from 'node:test';
import assert from 'node:assert/strict';
import { SseAssembler, fromJsonBody } from '../src/sse.js';

const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;

test('assembles a streamed message with text and tool_use blocks', () => {
  const a = new SseAssembler();
  const stream =
    ev('message_start', { message: { id: 'msg_1', model: 'claude-sonnet-5', role: 'assistant', usage: { input_tokens: 10, cache_read_input_tokens: 5 } } }) +
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'Hel' } }) +
    ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'lo' } }) +
    ev('content_block_stop', { index: 0 }) +
    ev('content_block_start', { index: 1, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '{"command":' } }) +
    ev('content_block_delta', { index: 1, delta: { type: 'input_json_delta', partial_json: '"ls"}' } }) +
    ev('content_block_stop', { index: 1 }) +
    ev('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } }) +
    ev('message_stop', {});
  // feed in awkward chunk boundaries
  for (let i = 0; i < stream.length; i += 17) a.feed(stream.slice(i, i + 17));
  a.end();
  const r = a.result();
  assert.equal(r.id, 'msg_1');
  assert.equal(r.content.length, 2);
  assert.equal(r.content[0].text, 'Hello');
  assert.deepEqual(r.content[1].input, { command: 'ls' });
  assert.equal(r.stop_reason, 'tool_use');
  assert.equal(r.usage.output_tokens, 7);
  assert.equal(r.usage.input_tokens, 10);
  assert.equal(r.eventCount, 11);
});

test('captures error events and non-streaming bodies', () => {
  const a = new SseAssembler();
  a.feed(ev('error', { error: { type: 'overloaded_error', message: 'busy' } }));
  a.end();
  assert.equal(a.result().error.type, 'overloaded_error');
  const j = fromJsonBody(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'x' }], usage: { input_tokens: 3 } }));
  assert.equal(j.content[0].text, 'x');
  assert.equal(fromJsonBody('not json').error.type, 'unparseable');
});
