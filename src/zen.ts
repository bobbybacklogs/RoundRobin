import { ModelExhaustedError, RoundRobinError } from './errors.js';
import {
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ModelInfo,
} from './types.js';
import { isExhaustionResponse, parseServerSentEvents } from './utils.js';

export class OpenCodeZenClient {
  private apiKey: string;
  private baseUrl: string;
  private timeoutMs: number;

  constructor(options: { apiKey?: string; baseUrl?: string; timeoutMs?: number } = {}) {
    this.apiKey = options.apiKey || '';
    this.baseUrl = options.baseUrl || 'https://opencode.ai/zen/v1';
    this.timeoutMs = options.timeoutMs || 60_000;
  }

  public setApiKey(apiKey: string): void {
    this.apiKey = apiKey;
  }

  public getApiKey(): string {
    return this.apiKey;
  }

  /**
   * Execute chat completion against OpenCode Zen for a verified free model
   */
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
      const endpoint = model.endpoint || `${this.baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

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
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const check = isExhaustionResponse(res.status, errorText, res.headers);
        if (check.isExhausted && check.reason) {
          throw new ModelExhaustedError(model.id, check.reason);
        }
        throw new RoundRobinError(
          `OpenCode Zen request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      const json = (await res.json()) as ChatCompletionResponse;
      json._roundRobin = {
        routedModel: model.id,
        provider: 'opencode-zen',
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

  /**
   * Execute streaming chat completion against OpenCode Zen
   */
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
      const endpoint = model.endpoint || `${this.baseUrl}/chat/completions`;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

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
        headers,
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        const errorText = await res.text().catch(() => '');
        const check = isExhaustionResponse(res.status, errorText, res.headers);
        if (check.isExhausted && check.reason) {
          throw new ModelExhaustedError(model.id, check.reason);
        }
        throw new RoundRobinError(
          `OpenCode Zen streaming request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      if (!res.body) {
        throw new RoundRobinError(`OpenCode Zen response body is empty`);
      }

      clearTimeout(timeoutId);

      for await (const sseData of parseServerSentEvents(res.body)) {
        try {
          const chunk = JSON.parse(sseData) as ChatCompletionChunk;
          chunk._roundRobin = {
            routedModel: model.id,
            provider: 'opencode-zen',
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
