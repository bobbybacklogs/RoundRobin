import { DEFAULT_AI_GATEWAY_BASE_URL } from './constants.js';
import { ModelExhaustedError, RoundRobinError } from './errors.js';
import {
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ModelInfo,
} from './types.js';
import { isExhaustionResponse, parseServerSentEvents } from './utils.js';

interface GatewayModelPricing {
  input?: string | number;
  output?: string | number;
}

interface GatewayModelEntry {
  id: string;
  name?: string;
  description?: string;
  type?: string;
  context_window?: number;
  tags?: string[];
  pricing?: GatewayModelPricing;
}

interface GatewayModelsResponse {
  data?: GatewayModelEntry[];
}

function toNumber(value: string | number | undefined): number {
  if (value === undefined || value === null) return Number.NaN;
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : Number.NaN;
}

/**
 * True when a catalog entry is a zero-cost free language model on AI Gateway.
 */
export function isFreeGatewayLanguageModel(entry: GatewayModelEntry): boolean {
  if (entry.type && entry.type !== 'language') return false;
  const tags = entry.tags || [];
  if (!tags.includes('free')) return false;
  const input = toNumber(entry.pricing?.input);
  const output = toNumber(entry.pricing?.output);
  return input === 0 && output === 0;
}

/**
 * Prefer explicit `*-free` ids when a paid twin of the same base model exists.
 */
export function preferExplicitFreeModels(entries: GatewayModelEntry[]): GatewayModelEntry[] {
  const free = entries.filter(isFreeGatewayLanguageModel);
  const byBase = new Map<string, GatewayModelEntry[]>();

  for (const entry of free) {
    const base = entry.id.replace(/-free$/, '');
    const list = byBase.get(base) || [];
    list.push(entry);
    byBase.set(base, list);
  }

  const selected: GatewayModelEntry[] = [];
  for (const group of byBase.values()) {
    const explicit = group.find((m) => m.id.endsWith('-free'));
    selected.push(explicit || group[0]);
  }

  return selected.sort((a, b) => a.id.localeCompare(b.id));
}

export function gatewayEntryToModelInfo(entry: GatewayModelEntry, baseUrl: string): ModelInfo {
  return {
    id: entry.id,
    name: entry.name || entry.id,
    provider: 'ai-gateway',
    endpoint: `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
    isFree: true,
    description: entry.description || 'Vercel AI Gateway verified free language model',
    contextWindow: entry.context_window,
  };
}

export class AiGatewayClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(options: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = (options.baseUrl || DEFAULT_AI_GATEWAY_BASE_URL).replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || 60_000;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  public getBaseUrl(): string {
    return this.baseUrl;
  }

  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  /**
   * Discover currently free language models from the public AI Gateway catalog.
   * Catalog listing does not require authentication.
   */
  public async listFreeModels(): Promise<ModelInfo[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 15_000));

    try {
      const res = await fetch(`${this.baseUrl}/models`, {
        method: 'GET',
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new RoundRobinError(
          `AI Gateway model catalog request failed with status ${res.status}`
        );
      }

      const json = (await res.json()) as GatewayModelsResponse;
      const selected = preferExplicitFreeModels(json.data || []);
      return selected.map((entry) => gatewayEntryToModelInfo(entry, this.baseUrl));
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async chat(
    model: ModelInfo,
    options: ChatCompletionOptions
  ): Promise<ChatCompletionResponse> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      if (!this.apiKey) {
        throw new ModelExhaustedError(model.id, {
          type: 'other',
          message:
            'AI_GATEWAY_API_KEY is not set. Create a key with `vercel ai-gateway api-keys create` or set AI_GATEWAY_API_KEY.',
          statusCode: 401,
          retryAfterMs: 60_000,
        });
      }

      const endpoint = model.endpoint || `${this.baseUrl}/chat/completions`;
      const payload = {
        model: model.id,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        top_p: options.top_p,
        presence_penalty: options.presence_penalty,
        frequency_penalty: options.frequency_penalty,
        stream: false,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const check = isExhaustionResponse(res.status, errorText, res.headers);
        if (check.isExhausted && check.reason) {
          throw new ModelExhaustedError(model.id, check.reason);
        }
        if (res.status === 401 || res.status === 403) {
          throw new ModelExhaustedError(model.id, {
            type: 'quota_exceeded',
            message: `AI Gateway auth/plan error (${res.status}): ${errorText.slice(0, 200)}`,
            statusCode: res.status,
            retryAfterMs: 120_000,
          });
        }
        throw new RoundRobinError(
          `AI Gateway request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      const json = (await res.json()) as ChatCompletionResponse;
      json._roundRobin = {
        routedModel: model.id,
        provider: 'ai-gateway',
        attemptsCount: 1,
        rotationHistory: [],
      };
      return json;
    } catch (err: unknown) {
      if (err instanceof ModelExhaustedError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ModelExhaustedError(model.id, {
          type: 'network_error',
          message: `Request timed out after ${this.timeoutMs}ms`,
          statusCode: 408,
          retryAfterMs: 30_000,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  public async *streamChat(
    model: ModelInfo,
    options: ChatCompletionOptions
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    if (options.signal) {
      options.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      if (!this.apiKey) {
        throw new ModelExhaustedError(model.id, {
          type: 'other',
          message:
            'AI_GATEWAY_API_KEY is not set. Create a key with `vercel ai-gateway api-keys create` or set AI_GATEWAY_API_KEY.',
          statusCode: 401,
          retryAfterMs: 60_000,
        });
      }

      const endpoint = model.endpoint || `${this.baseUrl}/chat/completions`;
      const payload = {
        model: model.id,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        top_p: options.top_p,
        presence_penalty: options.presence_penalty,
        frequency_penalty: options.frequency_penalty,
        stream: true,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: this.authHeaders(),
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const check = isExhaustionResponse(res.status, errorText, res.headers);
        if (check.isExhausted && check.reason) {
          throw new ModelExhaustedError(model.id, check.reason);
        }
        if (res.status === 401 || res.status === 403) {
          throw new ModelExhaustedError(model.id, {
            type: 'quota_exceeded',
            message: `AI Gateway auth/plan error (${res.status}): ${errorText.slice(0, 200)}`,
            statusCode: res.status,
            retryAfterMs: 120_000,
          });
        }
        throw new RoundRobinError(
          `AI Gateway streaming request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      if (!res.body) {
        throw new RoundRobinError('AI Gateway response body is empty');
      }

      clearTimeout(timeoutId);

      for await (const sseData of parseServerSentEvents(res.body)) {
        try {
          const chunk = JSON.parse(sseData) as ChatCompletionChunk;
          chunk._roundRobin = {
            routedModel: model.id,
            provider: 'ai-gateway',
          };
          yield chunk;
        } catch {
          // Skip invalid chunk
        }
      }
    } catch (err: unknown) {
      if (err instanceof ModelExhaustedError) {
        throw err;
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new ModelExhaustedError(model.id, {
          type: 'network_error',
          message: `Request timed out after ${this.timeoutMs}ms`,
          statusCode: 408,
          retryAfterMs: 30_000,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
