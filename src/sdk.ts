import { resolveConfig } from './config.js';
import { RoundRobinRouter, RouterOptions } from './router.js';
import { RoundRobinServer } from './server.js';
import {
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ModelStatus,
  RoundRobinConfig,
  RouterEvents,
} from './types.js';

export class RoundRobin {
  private router: RoundRobinRouter;
  private server?: RoundRobinServer;
  private config: Required<RoundRobinConfig> & { port: number };

  constructor(options: Partial<RoundRobinConfig> & { routerOptions?: RouterOptions } = {}) {
    this.config = resolveConfig(options);
    this.router = new RoundRobinRouter({
      openCodeZenApiKey: this.config.openCodeZenApiKey,
      openCodeZenBaseUrl: this.config.openCodeZenBaseUrl,
      ollamaHost: this.config.ollamaHost,
      cooldownMs: this.config.cooldownMs,
      requestTimeoutMs: this.config.requestTimeoutMs,
      maxRetriesPerModel: this.config.maxRetriesPerModel,
      autoCooldownReset: this.config.autoCooldownReset,
      ...options.routerOptions,
    });
  }

  public getRouter(): RoundRobinRouter {
    return this.router;
  }

  public setApiKey(apiKey: string): void {
    this.router.setApiKey(apiKey);
  }

  public setOllamaHost(host: string): void {
    this.router.setOllamaHost(host);
  }

  public getModels(): ModelStatus[] {
    return this.router.getModelStatuses();
  }

  public resetCooldowns(): void {
    this.router.resetCooldowns();
  }

  /**
   * Execute chat completion. Accepts a string prompt or full ChatCompletionOptions.
   */
  public async chat(
    promptOrOptions: string | ChatCompletionOptions
  ): Promise<ChatCompletionResponse> {
    const options: ChatCompletionOptions =
      typeof promptOrOptions === 'string'
        ? { messages: [{ role: 'user', content: promptOrOptions }] }
        : promptOrOptions;

    return this.router.chat(options);
  }

  /**
   * Execute streaming chat completion. Accepts a string prompt or full ChatCompletionOptions.
   */
  public async *streamChat(
    promptOrOptions: string | ChatCompletionOptions
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    const options: ChatCompletionOptions =
      typeof promptOrOptions === 'string'
        ? { messages: [{ role: 'user', content: promptOrOptions }], stream: true }
        : { ...promptOrOptions, stream: true };

    yield* this.router.streamChat(options);
  }

  /**
   * Start an OpenAI-compatible HTTP proxy server on the specified port.
   */
  public async serve(port?: number, host?: string): Promise<{ port: number; host: string }> {
    if (this.server) {
      await this.server.close();
    }

    const serverPort = port || this.config.port;
    this.server = new RoundRobinServer({
      router: this.router,
      port: serverPort,
      host: host || '0.0.0.0',
    });

    return this.server.listen();
  }

  /**
   * Stop the running server.
   */
  public async closeServer(): Promise<void> {
    if (this.server) {
      await this.server.close();
      this.server = undefined;
    }
  }

  /**
   * Subscribe to router events (model-rotated, model-exhausted, ollama-fallback, all-exhausted)
   */
  public on<K extends keyof RouterEvents>(event: K, listener: RouterEvents[K]): this {
    this.router.on(event, listener as (...args: any[]) => void);
    return this;
  }
}

export function createRoundRobin(options: Partial<RoundRobinConfig> = {}): RoundRobin {
  return new RoundRobin(options);
}
