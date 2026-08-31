export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface ChatMessage {
  role: Role;
  content: string;
  name?: string;
}

export interface ChatCompletionOptions {
  messages: ChatMessage[];
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  presence_penalty?: number;
  frequency_penalty?: number;
  signal?: AbortSignal;
}

export interface ChatCompletionUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface ChatCompletionChoice {
  index: number;
  message: ChatMessage;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionResponse {
  id: string;
  object: 'chat.completion';
  created: number;
  model: string;
  choices: ChatCompletionChoice[];
  usage?: ChatCompletionUsage;
  // Extra RoundRobin routing metadata
  _roundRobin?: {
    routedModel: string;
    provider: 'opencode-zen' | 'ollama';
    attemptsCount: number;
    rotationHistory: Array<{ model: string; reason?: string }>;
  };
}

export interface ChatCompletionChunkDelta {
  role?: Role;
  content?: string;
}

export interface ChatCompletionChunkChoice {
  index: number;
  delta: ChatCompletionChunkDelta;
  finish_reason: 'stop' | 'length' | 'tool_calls' | 'content_filter' | null;
}

export interface ChatCompletionChunk {
  id: string;
  object: 'chat.completion.chunk';
  created: number;
  model: string;
  choices: ChatCompletionChunkChoice[];
  _roundRobin?: {
    routedModel: string;
    provider: 'opencode-zen' | 'ollama';
  };
}

export type ProviderType = 'opencode-zen' | 'ollama';

export interface ModelInfo {
  id: string;
  name: string;
  provider: ProviderType;
  endpoint: string;
  isFree: boolean;
  description?: string;
  contextWindow?: number;
}

export interface ModelStatus {
  model: ModelInfo;
  isExhausted: boolean;
  exhaustedUntil?: number;
  consecutiveFailures: number;
  lastError?: string;
  lastUsedAt?: number;
}

export interface ExhaustionReason {
  type: 'rate_limit' | 'quota_exceeded' | 'service_unavailable' | 'network_error' | 'other';
  message: string;
  statusCode?: number;
  retryAfterMs?: number;
}

export interface RoundRobinConfig {
  openCodeZenApiKey?: string;
  openCodeZenBaseUrl?: string;
  ollamaHost?: string;
  cooldownMs?: number;
  requestTimeoutMs?: number;
  maxRetriesPerModel?: number;
  autoCooldownReset?: boolean;
}

export interface RouterEvents {
  'model-rotated': (fromModel: string, toModel: string, reason: ExhaustionReason) => void;
  'model-exhausted': (model: string, reason: ExhaustionReason, cooldownMs: number) => void;
  'ollama-fallback': (availableModels: string[]) => void;
  'all-exhausted': (summary: { zenExhausted: string[]; ollamaChecked: boolean; ollamaModels: string[]; message: string }) => void;
  'request-start': (model: string) => void;
  'request-success': (model: string, durationMs: number) => void;
}
