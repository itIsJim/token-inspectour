// Incremental parser for Anthropic Messages streaming (server-sent events).
// Feed raw chunks; it assembles the final message (content blocks + usage).
import type { AssembledResponse, ContentBlock, Usage, ApiError } from './types.js';

type Block = ContentBlock & { index?: number; _json?: string; text?: string; thinking?: string; input?: Record<string, unknown>; input_raw?: string; signature?: string; citations?: unknown[] };

interface MessageStart {
  id?: string;
  model?: string;
  role?: string;
  usage?: Usage;
}

export class SseAssembler {
  private buffer = '';
  private message: MessageStart | null = null;
  private blocks: Block[] = [];
  private usage: Usage | null = null;
  private stopReason: string | null = null;
  private stopSequence: string | null = null;
  private contextManagement: unknown = null;
  private error: ApiError | null = null;
  private rawEventCount = 0;
  private firstTokenAt: number | null = null;

  feed(chunk: Buffer | string): void {
    this.buffer += chunk.toString();
    let idx: number;
    while ((idx = this.buffer.indexOf('\n\n')) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      this.frame(frame);
    }
  }

  end(): void {
    if (this.buffer.trim()) this.frame(this.buffer);
    this.buffer = '';
  }

  private frame(frame: string): void {
    let event: string | null = null;
    const dataLines: string[] = [];
    for (const line of frame.split('\n')) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    }
    if (!dataLines.length) return;
    let data: Record<string, any>;
    try {
      data = JSON.parse(dataLines.join('\n'));
    } catch {
      return;
    }
    this.rawEventCount++;
    this.apply(event || data.type, data);
  }

  private apply(type: string, d: Record<string, any>): void {
    switch (type) {
      case 'message_start':
        this.message = d.message || null;
        if (d.message && d.message.usage) this.usage = { ...d.message.usage };
        break;
      case 'content_block_start': {
        if (this.firstTokenAt === null) this.firstTokenAt = Date.now();
        const cb = d.content_block || {};
        const block: Block = { ...cb, index: d.index };
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
        const block = this.blocks[d.index] || (this.blocks[d.index] = { type: 'unknown', index: d.index } as Block);
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
      case 'error':
        this.error = d.error || d;
        break;
      default:
        break;
    }
  }

  result(): AssembledResponse {
    return {
      id: this.message ? this.message.id ?? null : null,
      model: this.message ? this.message.model ?? null : null,
      role: this.message ? this.message.role ?? 'assistant' : 'assistant',
      content: this.blocks.filter(Boolean).map((b) => {
        const { index, ...rest } = b;
        return rest as ContentBlock;
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
export function fromJsonBody(text: string): AssembledResponse {
  const empty = (error: ApiError): AssembledResponse => ({
    id: null, model: null, role: 'assistant', content: [], stop_reason: null, stop_sequence: null, usage: null,
    context_management: null, error, eventCount: 0, firstTokenAt: null,
  });
  try {
    const j = JSON.parse(text);
    if (j.type === 'error') return empty(j.error || j);
    return {
      id: j.id ?? null,
      model: j.model ?? null,
      role: j.role ?? 'assistant',
      content: j.content || [],
      stop_reason: j.stop_reason ?? null,
      stop_sequence: j.stop_sequence ?? null,
      usage: j.usage || null,
      context_management: j.context_management || null,
      error: null,
      eventCount: 0,
      firstTokenAt: null,
    };
  } catch {
    return empty({ type: 'unparseable', message: text.slice(0, 500) });
  }
}
