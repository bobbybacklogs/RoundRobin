import { ModelExhaustedError, RoundRobinError } from './errors.js';
import {
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ModelInfo,
} from './types.js';
import { isExhaustionResponse, parseServerSentEvents } from './utils.js';

interface OllamaTagModel {
  name: string;
  model: string;
  size?: number;
  details?: {
    family?: string;
    parameter_size?: string;
  };
  capabilities?: string[];
}

interface OllamaTagsResponse {
  models?: OllamaTagModel[];
}

export class OllamaClient {
  private host: string;
  private timeoutMs: number;

  constructor(options: { host?: string; timeoutMs?: number } = {}) {
    this.host = (options.host || 'http://localhost:11434').replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs || 60_000;
  }

  public setHost(host: string): void {
    this.host = host.replace(/\/+$/, '');
  }

  public getHost(): string {
    return this.host;
  }

  /**
   * Check if Ollama server is running and reachable
   */
  public async isAvailable(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 3_000);

      const res = await fetch(`${this.host}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      return res.ok;
    } catch {
      return false;
    }
  }

  /**
   * Discover capable chat/completion models installed in Ollama
   */
  public async listCapableModels(): Promise<ModelInfo[]> {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 4_000);

      const res = await fetch(`${this.host}/api/tags`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (!res.ok) return [];

      const data = (await res.json()) as OllamaTagsResponse;
      if (!data.models || !Array.isArray(data.models)) return [];

      // Filter out embedding-only models, prioritize capable generative models
      const capable = data.models.filter((m) => {
        const nameLower = m.name.toLowerCase();
        // Skip embedding models
        if (
          nameLower.includes('embed') ||
          nameLower.includes('bge-') ||
          nameLower.includes('nomic-')
        ) {
          return false;
        }

        // If capabilities is defined, ensure it has completion or tools or thinking
        if (m.capabilities && m.capabilities.length > 0) {
          return m.capabilities.some((c) =>
            ['completion', 'tools', 'thinking', 'chat'].includes(c)
          );
        }

        return true;
      });

      return capable.map((m) => ({
        id: m.name,
        name: `Ollama: ${m.name}`,
        provider: 'ollama',
        endpoint: `${this.host}/v1/chat/completions`,
        isFree: true,
        description: `Local model ${m.details?.family || ''} ${m.details?.parameter_size ? `(${m.details.parameter_size})` : ''}`.trim(),
      }));
    } catch {
      return [];
    }
  }

  /**
   * Run chat completion against Ollama via its OpenAI-compatible endpoint
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
      // Ollama natively provides an OpenAI compatible /v1/chat/completions endpoint
      const endpoint = `${this.host}/v1/chat/completions`;
      const payload = {
        model: model.id,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        top_p: options.top_p,
        stream: false,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          `Ollama request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      const json = (await res.json()) as ChatCompletionResponse;
      json._roundRobin = {
        routedModel: model.id,
        provider: 'ollama',
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
          message: `Ollama request timed out after ${this.timeoutMs}ms`,
          statusCode: 408,
          retryAfterMs: 10_000,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Run streaming chat completion against Ollama
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
      const endpoint = `${this.host}/v1/chat/completions`;
      const payload = {
        model: model.id,
        messages: options.messages,
        temperature: options.temperature,
        max_tokens: options.max_tokens,
        top_p: options.top_p,
        stream: true,
      };

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
          `Ollama streaming request to ${model.id} failed with status ${res.status}: ${errorText.slice(0, 300)}`
        );
      }

      if (!res.body) {
        throw new RoundRobinError('Ollama response body is empty');
      }

      clearTimeout(timeoutId);

      for await (const sseData of parseServerSentEvents(res.body)) {
        try {
          const chunk = JSON.parse(sseData) as ChatCompletionChunk;
          chunk._roundRobin = {
            routedModel: model.id,
            provider: 'ollama',
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
          message: `Ollama request timed out after ${this.timeoutMs}ms`,
          statusCode: 408,
          retryAfterMs: 10_000,
        });
      }
      throw err;
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
