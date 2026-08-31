import { ModelInfo } from './types.js';

/**
 * OpenCode Zen Verified Free Models
 * Source: https://opencode.ai/docs/zen/
 * 
 * Only models explicitly listed as "Free" in OpenCode Zen pricing:
 * - big-pickle
 * - mimo-v2.5-free
 * - ling-3.0-flash-fin-free
 * - nemotron-3-ultra-free
 * - nemotron-3.5-lightning-free
 * - muse-spark-1.2-contributor-free
 */
export const OPENCODE_ZEN_FREE_MODELS: ReadonlyArray<ModelInfo> = [
  {
    id: 'big-pickle',
    name: 'Big Pickle',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified high-capability free model',
  },
  {
    id: 'mimo-v2.5-free',
    name: 'MiMo-V2.5 Free',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified fast reasoning free model',
  },
  {
    id: 'ling-3.0-flash-fin-free',
    name: 'Ling 3.0 Flash Fin Free',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified flash speed financial & coding free model',
  },
  {
    id: 'nemotron-3-ultra-free',
    name: 'Nemotron 3 Ultra Free',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified NVIDIA Nemotron 3 Ultra trial free model',
  },
  {
    id: 'nemotron-3.5-lightning-free',
    name: 'Nemotron 3.5 Lightning Free',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified NVIDIA Nemotron 3.5 Lightning fast free model',
  },
  {
    id: 'muse-spark-1.2-contributor-free',
    name: 'Muse Spark 1.2 Contributor Free',
    provider: 'opencode-zen',
    endpoint: 'https://opencode.ai/zen/v1/chat/completions',
    isFree: true,
    description: 'OpenCode Zen verified Meta contributor free tier model',
  },
];

export const DEFAULT_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
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
];
