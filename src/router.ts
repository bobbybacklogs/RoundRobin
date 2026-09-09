import EventEmitter from 'node:events';
import {
  AI_GATEWAY_FREE_MODELS,
  DEFAULT_AI_GATEWAY_BASE_URL,
  DEFAULT_COOLDOWN_MS,
  DEFAULT_OLLAMA_HOST,
} from './constants.js';
import { checkVercelAiGatewayStatus } from './auth.js';
import { AllModelsExhaustedError, ModelExhaustedError } from './errors.js';
import { AiGatewayClient } from './gateway.js';
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

export interface RouterOptions extends Partial<RoundRobinConfig> {
  customGatewayModels?: ModelInfo[];
  /** @deprecated Use customGatewayModels */
  customZenModels?: ModelInfo[];
  persistState?: boolean;
}

export class RoundRobinRouter extends EventEmitter {
  private gatewayClient: AiGatewayClient;
  private ollamaClient: OllamaClient;
  private gatewayModels: ModelInfo[];
  private modelStatuses: Map<string, ModelStatus> = new Map();
  private currentIndex: number = 0;
  private cooldownMs: number;
  private autoCooldownReset: boolean;
  private persistState: boolean;
  private requireAiGateway: boolean;
  private refreshFreeModels: boolean;
  private gatewayReady: boolean | null = null;
  private gatewayUnavailableReason?: string;
  private modelsInitialized = false;

  constructor(options: RouterOptions = {}) {
    super();

    this.cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    this.autoCooldownReset = options.autoCooldownReset ?? true;
    this.persistState = options.persistState ?? true;
    this.requireAiGateway = options.requireAiGateway ?? true;
    this.refreshFreeModels = options.refreshFreeModels ?? true;

    this.gatewayClient = new AiGatewayClient({
      apiKey: options.aiGatewayApiKey || options.openCodeZenApiKey,
      baseUrl: options.aiGatewayBaseUrl || options.openCodeZenBaseUrl || DEFAULT_AI_GATEWAY_BASE_URL,
      timeoutMs: options.requestTimeoutMs,
    });

    this.ollamaClient = new OllamaClient({
      host: options.ollamaHost || DEFAULT_OLLAMA_HOST,
      timeoutMs: options.requestTimeoutMs,
    });

    const custom =
      options.customGatewayModels && options.customGatewayModels.length > 0
        ? options.customGatewayModels
        : options.customZenModels && options.customZenModels.length > 0
          ? options.customZenModels
          : null;

    this.gatewayModels = custom
      ? [...custom]
      : [...AI_GATEWAY_FREE_MODELS];

    this.initializeStatusesFromModels();
  }

  private initializeStatusesFromModels(): void {
    const savedState = this.persistState ? loadRouterState() : { modelCooldowns: {} };
    const now = Date.now();
    this.modelStatuses.clear();

    for (const model of this.gatewayModels) {
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
    this.gatewayClient.setApiKey(apiKey);
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
   * Ensure AI Gateway (Pro) is available and optionally refresh free model catalog.
   * If AI Gateway is unavailable, free cloud models are empty.
   */
  public async ensureGatewayReady(): Promise<boolean> {
    if (this.modelsInitialized && this.gatewayReady !== null) {
      return this.gatewayReady;
    }

    if (this.requireAiGateway) {
      const status = await checkVercelAiGatewayStatus({
        apiKeyPresent: Boolean(this.gatewayClient.getApiKey()),
      });
      this.gatewayReady = status.gatewayAvailable;
      if (!status.gatewayAvailable) {
        this.gatewayUnavailableReason =
          status.reason ||
          'AI Gateway requires Pro membership. Free Gateway models are not available.';
        this.gatewayModels = [];
        this.modelStatuses.clear();
        this.emit('gateway-unavailable', this.gatewayUnavailableReason);
        this.modelsInitialized = true;
        return false;
      }
    } else {
      this.gatewayReady = true;
    }

    if (this.refreshFreeModels) {
      try {
        const live = await this.gatewayClient.listFreeModels();
        if (live.length > 0) {
          this.gatewayModels = live;
          this.initializeStatusesFromModels();
        }
      } catch {
        // Keep static fallback list when catalog refresh fails.
      }
    }

    this.modelsInitialized = true;
    return this.gatewayReady !== false;
  }

  public getAvailableGatewayModels(): ModelInfo[] {
    this.checkAndResetCooldowns();
    return this.gatewayModels.filter((m) => {
      const s = this.modelStatuses.get(m.id);
      return !s || !s.isExhausted;
    });
  }

  /** @deprecated Use getAvailableGatewayModels */
  public getAvailableZenModels(): ModelInfo[] {
    return this.getAvailableGatewayModels();
  }

  private emitAllExhausted(
    gatewayExhaustedList: string[],
    ollamaModels: string[],
    message: string
  ): void {
    this.emit('all-exhausted', {
      gatewayExhausted: gatewayExhaustedList,
      zenExhausted: gatewayExhaustedList,
      ollamaChecked: true,
      ollamaModels,
      message,
    });
  }

  public async chat(options: ChatCompletionOptions): Promise<ChatCompletionResponse> {
    await this.ensureGatewayReady();
    this.checkAndResetCooldowns();

    const rotationHistory: Array<{ model: string; reason?: string }> = [];
    const triedGatewayModels = new Set<string>();

    const totalGateway = this.gatewayModels.length;
    for (let i = 0; i < totalGateway; i++) {
      const model = this.gatewayModels[this.currentIndex % totalGateway];
      this.currentIndex++;

      const status = this.modelStatuses.get(model.id);
      if (status?.isExhausted) {
        continue;
      }

      triedGatewayModels.add(model.id);
      this.emit('request-start', model.id);
      const startTime = Date.now();

      try {
        const response = await this.gatewayClient.chat(model, options);
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

        const nextModel = this.gatewayModels.find((m) => {
          const s = this.modelStatuses.get(m.id);
          return !s?.isExhausted && !triedGatewayModels.has(m.id);
        });

        if (nextModel) {
          this.emit('model-rotated', model.id, nextModel.id, reason);
        }
      }
    }

    const gatewayExhaustedList =
      triedGatewayModels.size > 0
        ? Array.from(triedGatewayModels)
        : this.gatewayUnavailableReason
          ? ['(ai-gateway-unavailable)']
          : [];

    const capableOllamaModels = await this.ollamaClient.listCapableModels();

    if (capableOllamaModels.length > 0) {
      this.emit(
        'ollama-fallback',
        capableOllamaModels.map((m) => m.id)
      );

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
        }
      }
    }

    const error = new AllModelsExhaustedError({
      gatewayExhaustedModels: gatewayExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      ollamaHost: this.ollamaClient.getHost(),
      reason: this.gatewayUnavailableReason,
    });

    this.emitAllExhausted(gatewayExhaustedList, capableOllamaModels.map((m) => m.id), error.gracefulNotice);
    throw error;
  }

  public async *streamChat(
    options: ChatCompletionOptions
  ): AsyncGenerator<ChatCompletionChunk, void, unknown> {
    await this.ensureGatewayReady();
    this.checkAndResetCooldowns();

    const rotationHistory: Array<{ model: string; reason?: string }> = [];
    const triedGatewayModels = new Set<string>();

    const totalGateway = this.gatewayModels.length;
    for (let i = 0; i < totalGateway; i++) {
      const model = this.gatewayModels[this.currentIndex % totalGateway];
      this.currentIndex++;

      const status = this.modelStatuses.get(model.id);
      if (status?.isExhausted) {
        continue;
      }

      triedGatewayModels.add(model.id);
      this.emit('request-start', model.id);
      const startTime = Date.now();

      let hasYieldedAnyChunk = false;
      try {
        const stream = this.gatewayClient.streamChat(model, options);
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

        const nextModel = this.gatewayModels.find((m) => {
          const s = this.modelStatuses.get(m.id);
          return !s?.isExhausted && !triedGatewayModels.has(m.id);
        });

        if (nextModel) {
          this.emit('model-rotated', model.id, nextModel.id, reason);
        }
      }
    }

    const gatewayExhaustedList =
      triedGatewayModels.size > 0
        ? Array.from(triedGatewayModels)
        : this.gatewayUnavailableReason
          ? ['(ai-gateway-unavailable)']
          : [];

    const capableOllamaModels = await this.ollamaClient.listCapableModels();

    if (capableOllamaModels.length > 0) {
      this.emit(
        'ollama-fallback',
        capableOllamaModels.map((m) => m.id)
      );

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

    const error = new AllModelsExhaustedError({
      gatewayExhaustedModels: gatewayExhaustedList,
      ollamaChecked: true,
      ollamaModels: capableOllamaModels.map((m) => m.id),
      ollamaHost: this.ollamaClient.getHost(),
      reason: this.gatewayUnavailableReason,
    });

    this.emitAllExhausted(gatewayExhaustedList, capableOllamaModels.map((m) => m.id), error.gracefulNotice);
    throw error;
  }
}
