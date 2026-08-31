import { ExhaustionReason } from './types.js';

export class RoundRobinError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoundRobinError';
  }
}

export class ModelExhaustedError extends RoundRobinError {
  public readonly modelId: string;
  public readonly reason: ExhaustionReason;

  constructor(modelId: string, reason: ExhaustionReason) {
    super(`Model '${modelId}' is exhausted: ${reason.message}`);
    this.name = 'ModelExhaustedError';
    this.modelId = modelId;
    this.reason = reason;
  }
}

export class AllModelsExhaustedError extends RoundRobinError {
  public readonly zenExhaustedModels: string[];
  public readonly ollamaChecked: boolean;
  public readonly ollamaModels: string[];
  public readonly gracefulNotice: string;

  constructor(details: {
    zenExhaustedModels: string[];
    ollamaChecked: boolean;
    ollamaModels: string[];
    ollamaHost?: string;
    reason?: string;
  }) {
    const zenList = details.zenExhaustedModels.length > 0
      ? details.zenExhaustedModels.join(', ')
      : 'None available';

    let message = `[RoundRobin] All OpenCode Zen verified free models are currently exhausted.\n` +
      `Tested Zen Free Models: [${zenList}].\n`;

    if (details.ollamaChecked) {
      if (details.ollamaModels.length === 0) {
        message += `Checked local Ollama (${details.ollamaHost || 'http://localhost:11434'}): No capable models found or Ollama is offline.\n`;
      } else {
        message += `Checked local Ollama (${details.ollamaHost || 'http://localhost:11434'}): Tried models [${details.ollamaModels.join(', ')}], but all failed or were unavailable.\n`;
      }
    } else {
      message += `Ollama check was skipped or unconfigured.\n`;
    }

    const gracefulNotice = `All free models are currently exhausted and no responsive local models were found. Gracefully terminating router loop. Please wait a few moments for rate limit resets or run an Ollama model locally (e.g., \`ollama run qwen3:0.6b\`).`;

    message += gracefulNotice;

    super(message);
    this.name = 'AllModelsExhaustedError';
    this.zenExhaustedModels = details.zenExhaustedModels;
    this.ollamaChecked = details.ollamaChecked;
    this.ollamaModels = details.ollamaModels;
    this.gracefulNotice = gracefulNotice;
  }
}
