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
    provider: 'ai-gateway' | 'ollama';
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
    provider: 'ai-gateway' | 'ollama';
  };
}

export type ProviderType = 'ai-gateway' | 'ollama';

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
  aiGatewayApiKey?: string;
  aiGatewayBaseUrl?: string;
  /** @deprecated Use aiGatewayApiKey */
  openCodeZenApiKey?: string;
  /** @deprecated Use aiGatewayBaseUrl */
  openCodeZenBaseUrl?: string;
  ollamaHost?: string;
  cooldownMs?: number;
  requestTimeoutMs?: number;
  maxRetriesPerModel?: number;
  autoCooldownReset?: boolean;
  /**
   * When true (default), probe Vercel CLI for AI Gateway / Pro availability.
   * If AI Gateway is unavailable, free cloud models are treated as unavailable.
   */
  requireAiGateway?: boolean;
  /** Refresh free model list from the live AI Gateway catalog on startup. */
  refreshFreeModels?: boolean;
}

export interface RouterEvents {
  'model-rotated': (fromModel: string, toModel: string, reason: ExhaustionReason) => void;
  'model-exhausted': (model: string, reason: ExhaustionReason, cooldownMs: number) => void;
  'ollama-fallback': (availableModels: string[]) => void;
  'all-exhausted': (summary: {
    gatewayExhausted: string[];
    /** @deprecated Use gatewayExhausted */
    zenExhausted: string[];
    ollamaChecked: boolean;
    ollamaModels: string[];
    message: string;
  }) => void;
  'gateway-unavailable': (reason: string) => void;
  'request-start': (model: string) => void;
  'request-success': (model: string, durationMs: number) => void;
}
