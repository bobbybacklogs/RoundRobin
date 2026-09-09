import { ModelInfo } from './types.js';

/**
 * Vercel AI Gateway verified free language models ($0 input/output, `free` tag).
 * Source: https://ai-gateway.vercel.sh/v1/models and https://vercel.com/ai-gateway/models
 *
 * Prefer explicit `*-free` ids when twins exist in the catalog.
 * RoundRobin may refresh this list at runtime via the public catalog API.
 */
export const AI_GATEWAY_FREE_MODELS: ReadonlyArray<ModelInfo> = [
  {
    id: 'inclusionai/ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin (Free)',
    provider: 'ai-gateway',
    endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    isFree: true,
    description: 'InclusionAI finance-enhanced MoE free language model via Vercel AI Gateway',
    contextWindow: 256000,
  },
  {
    id: 'inclusionai/ling-3.0-flash-sante-free',
    name: 'Ling 3.0 Flash Sante (Free)',
    provider: 'ai-gateway',
    endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    isFree: true,
    description: 'InclusionAI health-specialized free language model via Vercel AI Gateway',
    contextWindow: 256000,
  },
  {
    id: 'poolside/laguna-s-2.1-free',
    name: 'Laguna S 2.1 Free',
    provider: 'ai-gateway',
    endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
    isFree: true,
    description: 'Poolside Laguna S 2.1 free open-weight coding model via Vercel AI Gateway',
    contextWindow: 256000,
  },
];

/** @deprecated Use AI_GATEWAY_FREE_MODELS */
export const OPENCODE_ZEN_FREE_MODELS = AI_GATEWAY_FREE_MODELS;

export const DEFAULT_AI_GATEWAY_BASE_URL = 'https://ai-gateway.vercel.sh/v1';
/** @deprecated Use DEFAULT_AI_GATEWAY_BASE_URL */
export const DEFAULT_ZEN_BASE_URL = DEFAULT_AI_GATEWAY_BASE_URL;

export const DEFAULT_OLLAMA_HOST = 'http://localhost:11434';
export const DEFAULT_COOLDOWN_MS = 60_000; // 1 minute default cooldown on rate limit
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000; // 60s timeout
export const DEFAULT_SERVER_PORT = 8080;

export const EXHAUSTION_HTTP_STATUS_CODES = new Set([
  429, // Too Many Requests
  402, // Payment Required / Insufficient credits
  503, // Service Unavailable (overloaded capacity)
  504, // Gateway Timeout
]);

export const EXHAUSTION_MESSAGE_PATTERNS = [
  /rate\s*limit/i,
  /quota/i,
  /exhausted/i,
  /limit\s*reached/i,
  /too\s*many\s*requests/i,
  /capacity\s*exceeded/i,
  /insufficient_quota/i,
  /overloaded/i,
  /credit/i,
  /exceeded\s*your\s*current\s*quota/i,
  /free\s*tier\s*limit/i,
  /resource\s*has\s*been\s*exhausted/i,
  /model_rate_limit/i,
  /requests_per_minute/i,
  /tokens_per_minute/i,
  /pro\s*(plan|membership)/i,
  /ai\s*gateway.*(unavailable|not\s*available)/i,
];
