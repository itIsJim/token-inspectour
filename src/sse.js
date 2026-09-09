// Incremental parser for Anthropic Messages streaming (server-sent events).
// Feed raw chunks; it assembles the final message (content blocks + usage).

export class SseAssembler {
  constructor() {
    this.buffer = '';
    this.events = [];
    this.message = null; // from message_start
    this.blocks = []; // assembled content blocks
    this.usage = null;
    this.stopReason = null;
    this.stopSequence = null;
    this.contextManagement = null;
    this.error = null;
    this.rawEventCount = 0;
    this.firstTokenAt = null;
  }

  feed(chunk) {
    this.buffer += chunk.toString('utf8');
    let idx;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.#frame(frame);
    }
  }

  end() {
    if (this.buffer.trim()) this.#frame(this.buffer);
    this.buffer = '';
  }

  #frame(frame) {
    let event = null;
    const dataLines = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    this.rawEventCount++;
    this.#apply(event || data.type, data);
  }

  #apply(type, d) {
    switch (type) {
      case 'message_start':
        this.message = d.message || null;
        if (d.message && d.message.usage) this.usage = { ...d.message.usage };
        break;
      case 'content_block_start': {
        if (this.firstTokenAt === null) this.firstTokenAt = Date.now();
        const cb = d.content_block || {};
        const block = { ...cb, index: d.index };
        if (cb.type === 'text') block.text = cb.text || '';
        if (cb.type === 'thinking') block.thinking = cb.thinking || '';
        if (cb.type === 'tool_use' || cb.type === 'server_tool_use') {
          block._json = '';
          block.input = cb.input && Object.keys(cb.input).length ? cb.input : undefined;
        }
        this.blocks[d.index] = block;
        break;
      }
      case 'content_block_delta': {
        const block = this.blocks[d.index] || (this.blocks[d.index] = { type: 'unknown', index: d.index });
        const delta = d.delta || {};
        if (delta.type === 'text_delta') block.text = (block.text || '') + (delta.text || '');
        else if (delta.type === 'thinking_delta') block.thinking = (block.thinking || '') + (delta.thinking || '');
        else if (delta.type === 'input_json_delta') block._json = (block._json || '') + (delta.partial_json || '');
        else if (delta.type === 'signature_delta') block.signature = delta.signature;
        else if (delta.type === 'citations_delta') (block.citations ||= []).push(delta.citation);
        break;
      }
      case 'content_block_stop': {
        const block = this.blocks[d.index];
        if (block && typeof block._json === 'string') {
          if (block._json.trim()) {
            try {
              block.input = JSON.parse(block._json);
            } catch {
              block.input_raw = block._json;
            }
          } else if (block.input === undefined) block.input = {};
          delete block._json;
        }
        break;
      }
      case 'message_delta':
        if (d.delta) {
          if (d.delta.stop_reason !== undefined) this.stopReason = d.delta.stop_reason;
          if (d.delta.stop_sequence !== undefined) this.stopSequence = d.delta.stop_sequence;
        }
        if (d.usage) this.usage = { ...(this.usage || {}), ...d.usage };
        if (d.context_management) this.contextManagement = d.context_management;
        break;
      case 'message_stop':
        break;
      case 'error':
        this.error = d.error || d;
        break;
      default:
        break;
    }
  }

  result() {
    return {
      id: this.message ? this.message.id : null,
      model: this.message ? this.message.model : null,
      role: this.message ? this.message.role : 'assistant',
      content: this.blocks.filter(Boolean).map((b) => {
        const { index, ...rest } = b;
        return rest;
      }),
      stop_reason: this.stopReason,
      stop_sequence: this.stopSequence,
      usage: this.usage,
      context_management: this.contextManagement,
      error: this.error,
      eventCount: this.rawEventCount,
      firstTokenAt: this.firstTokenAt,
    };
  }
}

// Parse a complete non-streaming JSON body into the same shape.
export function fromJsonBody(text) {
  try {
    const j = JSON.parse(text);
    if (j.type === 'error') return { error: j.error || j, content: [], usage: null };
    return {
      id: j.id,
      model: j.model,
      role: j.role,
      content: j.content || [],
      stop_reason: j.stop_reason,
      stop_sequence: j.stop_sequence,
      usage: j.usage || null,
      context_management: j.context_management || null,
      error: null,
      eventCount: 0,
      firstTokenAt: null,
    };
  } catch {
    return { error: { type: 'unparseable', message: text.slice(0, 500) }, content: [], usage: null };
  }
}
