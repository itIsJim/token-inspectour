// Shared data model for token-inspectour.

// ---- Anthropic Messages API (the subset Claude Code uses) ----------------------

export interface CacheControl {
  type: 'ephemeral';
  ttl?: string;
}

export interface SystemBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl | null;
}

export interface ToolDef {
  name: string;
  description?: string;
  input_schema?: unknown;
  parameters?: unknown;
  type?: string;
  cache_control?: CacheControl | null;
}

export interface TextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl | null;
}
export interface ThinkingBlock {
  type: 'thinking';
  thinking: string;
  signature?: string;
}
export interface RedactedThinkingBlock {
  type: 'redacted_thinking';
  data?: string;
}
export interface ToolUseBlock {
  type: 'tool_use' | 'server_tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
  input_raw?: string;
}
export interface ToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content?: string | ContentBlock[];
  is_error?: boolean;
  cache_control?: CacheControl | null;
}
export interface ImageBlock {
  type: 'image';
  source?: { media_type?: string };
}
export interface DocumentBlock {
  type: 'document';
}
export interface OtherBlock {
  type: string;
  [k: string]: unknown;
}

export type ContentBlock =
  | TextBlock
  | ThinkingBlock
  | RedactedThinkingBlock
  | ToolUseBlock
  | ToolResultBlock
  | ImageBlock
  | DocumentBlock
  | OtherBlock;

export type Role = 'user' | 'assistant' | 'system';

export interface Message {
  role: Role;
  content: string | ContentBlock[];
}

export interface RequestBody {
  model: string;
  system?: string | SystemBlock[];
  tools?: ToolDef[];
  messages?: Message[];
  metadata?: { user_id?: string };
  max_tokens?: number;
  stream?: boolean;
  [k: string]: unknown;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  [k: string]: unknown;
}

export interface ApiError {
  type: string;
  message?: string;
  [k: string]: unknown;
}

export interface AssembledResponse {
  id: string | null;
  model: string | null;
  role: string;
  content: ContentBlock[];
  stop_reason: string | null;
  stop_sequence: string | null;
  usage: Usage | null;
  context_management: unknown;
  error: ApiError | null;
  eventCount: number;
  firstTokenAt: number | null;
}

// ---- Inventory --------------------------------------------------------------------

export type SourceKind =
  | 'claude-md'
  | 'rules'
  | 'skill'
  | 'command'
  | 'agent'
  | 'settings'
  | 'hook'
  | 'mcp'
  | 'mcp-remote'
  | 'memory'
  | 'plugin'
  | 'harness'
  | 'harness-tool'
  | 'reminder'
  | 'user'
  | 'model'
  | 'tool-result'
  | 'file';

export type Scope = 'project' | 'parent' | 'user' | 'plugin' | 'external';

export interface HookDef {
  event: string;
  matcher: string;
  type?: string;
  command: string;
}

export interface McpServerRef {
  name: string;
  sanitized: string;
  config: unknown;
}

export interface Source {
  id: string;
  kind: SourceKind;
  path: string;
  scope: Scope;
  name: string;
  description: string;
  frontmatter: Record<string, string>;
  content: string;
  body: string;
  size: number;
  mtime: number;
  dir?: string;
  hooks?: HookDef[];
  permissions?: unknown;
  enabledPlugins?: Record<string, boolean> | null;
  model?: string | null;
  servers?: McpServerRef[];
  plugin?: string;
  version?: string;
  enabled?: boolean;
  adhoc?: boolean;
}

/** A source referenced by a request but not in the scanned inventory (e.g. a file the agent read). */
export interface AdhocSource {
  id: string;
  kind: SourceKind;
  path: string;
  name: string;
  scope: Scope;
  description: string;
  size: number;
  adhoc: true;
  dir?: string;
}

export type AnySource = Source | AdhocSource;

export interface Inventory {
  projectDir: string;
  scannedAt: number;
  sources: Source[];
}

export type PublicSource = Omit<Source, 'content' | 'body'> & { content?: string; body?: string; hasContent?: boolean };

// ---- Analysis -----------------------------------------------------------------------

export type MatchKind = 'contents-of' | 'exact' | 'partial' | 'listing' | 'tool-read' | 'skill-invoke';

export interface Span {
  start: number;
  end: number;
  kind: SourceKind;
  sourceId?: string;
  label?: string;
  match?: MatchKind;
  file?: string;
  desc?: string;
  coverage?: number;
  tokens?: number;
  exact?: boolean;
}

export type Area = 'system' | 'tools' | 'messages';

export interface Part {
  id: string;
  area: Area;
  index: number;
  sub?: number;
  role: Role | 'tools';
  blockType: string;
  label: string;
  text: string;
  chars: number;
  spans: Span[];
  cache?: boolean;
  name?: string;
  kind?: SourceKind;
  sourceId?: string;
  toolUseId?: string;
  isError?: boolean;
  /** Length of an encrypted thinking signature (thinking parts whose text is not sent). */
  signatureChars?: number;
  raw?: unknown;
  tokens?: number;
  exact?: boolean;
}

export interface KindTotal {
  chars: number;
  tokens: number;
  spans: number;
  exactTokens: number;
}
export interface AreaTotal {
  chars: number;
  tokens: number;
  parts: number;
}
export interface SourceTotal {
  chars: number;
  tokens: number;
  spans: number;
  parts: string[];
  matches: Record<string, number>;
}
export interface SourceUsage {
  used: boolean;
  tokens: number;
  chars: number;
  spans: number;
  parts: string[];
  matches: Record<string, number>;
  coverage: number;
}

export interface Totals {
  chars: number;
  tokens: number;
  byKind: Partial<Record<SourceKind, KindTotal>>;
  byArea: Partial<Record<Area, AreaTotal>>;
  bySource: Record<string, SourceTotal>;
  sourceUsage: Record<string, SourceUsage>;
}

export interface DiffEntry {
  id: string;
  key: string;
  label: string;
  tokens?: number;
  chars: number;
  role?: string;
  blockType?: string;
  prevId?: string;
  prevTokens?: number;
  prevChars?: number;
}

export interface Diff {
  added: DiffEntry[];
  removed: DiffEntry[];
  changed: DiffEntry[];
  sameCount: number;
  addedTokens: number;
  removedTokens: number;
  changedDelta: number;
}

export type RequestKind = 'main' | 'side' | 'unknown';

export interface Classification {
  kind: RequestKind;
  label: string;
  agent?: string | null;
}

export interface Analysis {
  kind: RequestKind;
  label: string;
  agent: string | null;
  parts: Part[];
  adhocSources: AdhocSource[];
  totals: Totals;
  counted: number;
  partCount: number;
  exactTotal: boolean;
  toolsTotal: number | null;
  systemTotal: number | null;
  toolsOverhead: number | null;
  toolFraming: number | null;
  promptTotalFromUsage: number | null;
  cache: { read: number; write: number; uncached: number } | null;
  diff: Diff | null;
  prevId: string | null;
  inventoryScannedAt: number;
}

// ---- Captures -----------------------------------------------------------------------

export interface CaptureRecord {
  id: string;
  seq?: number;
  startedAt: string;
  endedAt?: string;
  method: string;
  path: string;
  agent: string | null;
  headers: Record<string, string | string[] | undefined>;
  _auth?: Record<string, string | string[] | undefined>;
  _analyzing?: Promise<void> | null;
  bytesIn: number;
  bytesOut?: number;
  body: RequestBody | null;
  bodyText: string | null;
  sessionId: string;
  meta: Record<string, unknown>;
  model: string | null;
  stream: boolean;
  toolCount: number;
  messageCount: number;
  status: number | null;
  response: AssembledResponse | null;
  responseHeaders?: Record<string, string | string[] | undefined>;
  durationMs?: number;
  ttfbMs?: number | null;
  ttftMs?: number;
  error?: string | null;
  kind?: string;
  projectDir?: string;
  projectDetected?: boolean;
  userPreview?: string;
  assistantPreview?: string;
  analysis?: Analysis | null;
}

export interface UsageSummary {
  input: number | null;
  cacheRead: number | null;
  cacheWrite: number | null;
  output: number | null;
}

export interface RequestSummary {
  id: string;
  seq: number | undefined;
  sessionId: string;
  agent: string | null;
  projectDir: string | null;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  ttfbMs?: number | null;
  status: number | null;
  kind?: string;
  model: string | null;
  stream: boolean;
  path: string;
  bytesIn: number;
  bytesOut?: number;
  toolCount: number;
  messageCount: number;
  stopReason: string | null;
  error: unknown;
  usage: UsageSummary;
  userPreview: string;
  assistantPreview: string;
  analysis: { totals: Totals; counted: number; exactTotal: boolean } | null;
}

export interface Session {
  id: string;
  startedAt: string;
  projectDir: string | null;
  agent: string | null;
  requests: string[];
  label: string | null;
}

export interface SessionSummary {
  id: string;
  startedAt: string;
  projectDir: string | null;
  agent: string | null;
  label: string | null;
  requests: RequestSummary[];
}

/** Analysis with part text stripped, for list/summary transport. */
export type SlimPart = Omit<Part, 'text' | 'raw'>;
export type SlimAnalysis = Omit<Analysis, 'parts'> & { parts: SlimPart[] };

// ---- Flow graph ---------------------------------------------------------------------

export type GraphNodeKind = SourceKind | 'session' | 'turn' | 'side' | 'group' | 'area' | 'request';

export interface GraphNodeData {
  id: string;
  label: string;
  kind: GraphNodeKind;
  sub?: string;
  parent?: string;
  tokens?: number;
  tokensOut?: number;
  ref?: { type: 'request' | 'source' | 'call' | 'area'; id: string; requestId?: string };
  detail?: Record<string, unknown>;
}
export interface GraphEdgeData {
  id: string;
  source: string;
  target: string;
  label?: string;
  tokens?: number;
  kind: 'next' | 'side' | 'call' | 'result' | 'spawn' | 'feeds';
}
export interface GraphNode { data: GraphNodeData }
export interface GraphEdge { data: GraphEdgeData }
export interface GraphData {
  mode: 'flow' | 'context';
  sessionId: string;
  requestId?: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  stats: Record<string, number>;
}
