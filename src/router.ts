import EventEmitter from 'node:events';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_ZEN_BASE_URL,
  OPENCODE_ZEN_FREE_MODELS,
} from './constants.js';
import { AllModelsExhaustedError, ModelExhaustedError, RoundRobinError } from './errors.js';
import { OllamaClient } from './ollama.js';
import {
  ChatCompletionChunk,
  ChatCompletionOptions,
  ChatCompletionResponse,
  ExhaustionReason,
  ModelInfo,
  ModelStatus,
  RoundRobinConfig,
} from './types.js';
import { isNetworkExhaustionError } from './utils.js';
import { loadRouterState, saveRouterState } from './config.js';
import { OpenCodeZenClient } from './zen.js';

export interface RouterOptions extends Partial<RoundRobinConfig> {
  customZenModels?: ModelInfo[];
  persistState?: boolean;
}

export class RoundRobinRouter extends EventEmitter {
  private zenClient: OpenCodeZenClient;
  private ollamaClient: OllamaClient;
  private zenModels: ModelInfo[];
  private modelStatuses: Map<string, ModelStatus> = new Map();
  private currentIndex: number = 0;
  private cooldownMs: number;
  private autoCooldownReset: boolean;
  private persistState: boolean;

  constructor(options: RouterOptions = {}) {
    super();

    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.autoCooldownReset = options.autoCooldownReset ?? true;
    this.persistState = options.persistState ?? true;

    this.zenClient = new OpenCodeZenClient({
      apiKey: options.openCodeZenApiKey,
      baseUrl: options.openCodeZenBaseUrl || DEFAULT_ZEN_BASE_URL,
      timeoutMs: options.requestTimeoutMs,
    });

    this.ollamaClient = new OllamaClient({
      host: options.ollamaHost || DEFAULT_OLLAMA_HOST,
      timeoutMs: options.requestTimeoutMs,
    });

    this.zenModels = options.customZenModels && options.customZenModels.length > 0
      ? [...options.customZenModels]
      : [...OPENCODE_ZEN_FREE_MODELS];

    // Load persisted state if enabled
    const savedState = this.persistState ? loadRouterState() : { modelCooldowns: {} };
    const now = Date.now();

    // Initialize statuses for all verified free models
    for (const model of this.zenModels) {
      const saved = savedState.modelCooldowns[model.id];
      const isStillExhausted = Boolean(saved && saved.exhaustedUntil && saved.exhaustedUntil > now);

      this.modelStatuses.set(model.id, {
        model,
        isExhausted: isStillExhausted,
        exhaustedUntil: isStillExhausted ? saved?.exhaustedUntil : undefined,
        lastError: isStillExhausted ? saved?.lastError : undefined,
        consecutiveFailures: isStillExhausted ? 1 : 0,
      });
    }

    if (savedState.lastUsedIndex !== undefined) {
      this.currentIndex = savedState.lastUsedIndex;
    }
  }

  public setApiKey(apiKey: string): void {
    this.zenClient.setApiKey(apiKey);
  }

  public setOllamaHost(host: string): void {
    this.ollamaClient.setHost(host);
  }

  public getModelStatuses(): ModelStatus[] {
    this.checkAndResetCooldowns();
    return Array.from(this.modelStatuses.values());
  }

  public resetCooldowns(): void {
    for (const status of this.modelStatuses.values()) {
      status.isExhausted = false;
      status.exhaustedUntil = undefined;
      status.consecutiveFailures = 0;
      status.lastError = undefined;
    }
    this.persistCurrentState();
  }

  private persistCurrentState(): void {
    if (!this.persistState) return;
    const cooldowns: Record<string, { exhaustedUntil: number; lastError?: string }> = {};
    const now = Date.now();
    for (const [id, s] of this.modelStatuses.entries()) {
      if (s.isExhausted && s.exhaustedUntil && s.exhaustedUntil > now) {
        cooldowns[id] = {
          exhaustedUntil: s.exhaustedUntil,
          lastError: s.lastError,
        };
      }
    }
    saveRouterState({
      modelCooldowns: cooldowns,
      lastUsedIndex: this.currentIndex,
    });
  }

  private checkAndResetCooldowns(): void {
    if (!this.autoCooldownReset) return;
    const now = Date.now();
    let changed = false;
    for (const status of this.modelStatuses.values()) {
      if (status.isExhausted && status.exhaustedUntil && now >= status.exhaustedUntil) {
        status.isExhausted = false;
        status.exhaustedUntil = undefined;
        status.lastError = undefined;
        changed = true;
      }
    }
    if (changed) {
      this.persistCurrentState();
    }
  }

  private markModelExhausted(modelId: string, reason: ExhaustionReason): void {
    const status = this.modelStatuses.get(modelId);
    const cooldown = reason.retryAfterMs || this.cooldownMs;
    if (status) {
      status.isExhausted = true;
      status.exhaustedUntil = Date.now() + cooldown;
      status.consecutiveFailures += 1;
      status.lastError = reason.message;
    }
    this.persistCurrentState();
    this.emit('model-exhausted', modelId, reason, cooldown);
  }

  /**
   * Get list of currently available (non-exhausted) OpenCode Zen free models
   */
  public getAvailableZenModels(): ModelInfo[] {
    this.checkAndResetCooldowns();
    return this.zenModels.filter((m) => {
      const s = this.modelStatuses.get(m.id);
      return !s || !s.isExhausted;
    });
  }

  /**
   * Execute chat completion with free-model round-robin rotation,
   * falling back to Ollama when all Zen free models are exhausted,
   * and gracefully terminating if none are available.
   */
  public async chat(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    this.checkAndResetCooldowns();

    const rotationHistory: Array<{ model: string; reason?: string }> = [];
    const triedZenModels = new Set<string>();

    // 1. Try available OpenCode Zen verified free models in round-robin order
    const totalZen = this.zenModels.length;
    for (let i = 0; i < totalZen; i++) {
      const model = this.zenModels[this.currentIndex % totalZen];
      this.currentIndex++;

      const status = this.modelStatuses.get(model.id);
      if (status?.isExhausted) {
        continue;
      }

      triedZenModels.add(model.id);
      this.emit('request-start', model.id);
      const startTime = Date.now();

      try {
        const response = await this.zenClient.chat(model, options);
        if (status) {
          status.consecutiveFailures = 0;
          status.lastUsedAt = Date.now();
        }
        this.emit('request-success', model.id, Date.now() - startTime);

        if (response._roundRobin) {
          response._roundRobin.rotationHistory = rotationHistory;
          response._roundRobin.attemptsCount = rotationHistory.length + 1;
        }
        return response;
      } catch (err: unknown) {
        let reason: ExhaustionReason;
        if (err instanceof ModelExhaustedError) {
          reason = err.reason;
        } else {
          const netCheck = isNetworkExhaustionError(err);
          if (netCheck.isExhausted && netCheck.reason) {
            reason = netCheck.reason;
          } else {
            reason = {
              type: 'other',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }

        this.markModelExhausted(model.id, reason);
        rotationHistory.push({ model: model.id, reason: reason.message });

        // Find next candidate for event emission
        const nextModel = this.zenModels.find((m) => {
          const s = this.modelStatuses.get(m.id);
          return !s?.isExhausted && !triedZenModels.has(m.id);
        });

        if (nextModel) {
          this.emit('model-rotated', model.id, nextModel.id, reason);
        }
      }
    }

    // 2. All OpenCode Zen free models are exhausted! Route back and check for Ollama and capable models.
    const zenExhaustedList = Array.from(triedZenModels);
    const capableOllamaModels = await this.ollamaClient.listCapableModels();

    if (capableOllamaModels.length > 0) {
      this.emit('ollama-fallback', capableOllamaModels.map((m) => m.id));

      for (const ollamaModel of capableOllamaModels) {
        this.emit('request-start', ollamaModel.id);
        const startTime = Date.now();

        try {
          const response = await this.ollamaClient.chat(ollamaModel, options);
          this.emit('request-success', ollamaModel.id, Date.now() - startTime);

          if (response._roundRobin) {
            response._roundRobin.rotationHistory = rotationHistory;
            response._roundRobin.attemptsCount = rotationHistory.length + 1;
          }
          return response;
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          rotationHistory.push({ model: ollamaModel.id, reason: errMsg });
          // Rotate to next capable Ollama model
        }
      }
    }

    // 3. If none: gracefully end the loop and let the user know.
    const error = new AllModelsExhaustedError({
      zenExhaustedModels: zenExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      ollamaHost: this.ollamaClient.getHost(),
    });

    this.emit('all-exhausted', {
      zenExhausted: zenExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      message: error.gracefulNotice,
    });

    throw error;
  }

  /**
   * Execute streaming chat completion with rotation and fallback
   */
  public async *streamChat(
    options: ChatCompletionOptions
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    this.checkAndResetCooldowns();

    const rotationHistory: Array<{ model: string; reason?: string }> = [];
    const triedZenModels = new Set<string>();

    const totalZen = this.zenModels.length;
    for (let i = 0; i < totalZen; i++) {
      const model = this.zenModels[this.currentIndex % totalZen];
      this.currentIndex++;

      const status = this.modelStatuses.get(model.id);
      if (status?.isExhausted) {
        continue;
      }

      triedZenModels.add(model.id);
      this.emit('request-start', model.id);
      const startTime = Date.now();

      let hasYieldedAnyChunk = false;
      try {
        const stream = this.zenClient.streamChat(model, options);
        for await (const chunk of stream) {
          hasYieldedAnyChunk = true;
          yield chunk;
        }

        if (status) {
          status.consecutiveFailures = 0;
          status.lastUsedAt = Date.now();
        }
        this.emit('request-success', model.id, Date.now() - startTime);
        return;
      } catch (err: unknown) {
        // If we already started outputting stream to user, we cannot silently rotate mid-sentence
        if (hasYieldedAnyChunk) {
          throw err;
        }

        let reason: ExhaustionReason;
        if (err instanceof ModelExhaustedError) {
          reason = err.reason;
        } else {
          const netCheck = isNetworkExhaustionError(err);
          if (netCheck.isExhausted && netCheck.reason) {
            reason = netCheck.reason;
          } else {
            reason = {
              type: 'other',
              message: err instanceof Error ? err.message : String(err),
            };
          }
        }

        this.markModelExhausted(model.id, reason);
        rotationHistory.push({ model: model.id, reason: reason.message });

        const nextModel = this.zenModels.find((m) => {
          const s = this.modelStatuses.get(m.id);
          return !s?.isExhausted && !triedZenModels.has(m.id);
        });

        if (nextModel) {
          this.emit('model-rotated', model.id, nextModel.id, reason);
        }
      }
    }

    // Fallback to Ollama
    const zenExhaustedList = Array.from(triedZenModels);
    const capableOllamaModels = await this.ollamaClient.listCapableModels();

    if (capableOllamaModels.length > 0) {
      this.emit('ollama-fallback', capableOllamaModels.map((m) => m.id));

      for (const ollamaModel of capableOllamaModels) {
        this.emit('request-start', ollamaModel.id);
        const startTime = Date.now();

        let hasYieldedAnyChunk = false;
        try {
          const stream = this.ollamaClient.streamChat(ollamaModel, options);
          for await (const chunk of stream) {
            hasYieldedAnyChunk = true;
            yield chunk;
          }
          this.emit('request-success', ollamaModel.id, Date.now() - startTime);
          return;
        } catch (err: unknown) {
          if (hasYieldedAnyChunk) {
            throw err;
          }
          const errMsg = err instanceof Error ? err.message : String(err);
          rotationHistory.push({ model: ollamaModel.id, reason: errMsg });
        }
      }
    }

    // None available -> graceful termination
    const error = new AllModelsExhaustedError({
      zenExhaustedModels: zenExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      ollamaHost: this.ollamaClient.getHost(),
    });

    this.emit('all-exhausted', {
      zenExhausted: zenExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      message: error.gracefulNotice,
    });

    throw error;
  }
}
