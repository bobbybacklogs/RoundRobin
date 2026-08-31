import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllModelsExhaustedError, ModelExhaustedError } from '../src/errors.js';
import { RoundRobinRouter } from '../src/router.js';
import { ChatCompletionResponse, ModelInfo } from '../src/types.js';

describe('RoundRobinRouter', () => {
  const customModels: ModelInfo[] = [
    {
      id: 'mock-zen-1',
      name: 'Mock Zen 1',
      provider: 'opencode-zen',
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      isFree: true,
    },
    {
      id: 'mock-zen-2',
      name: 'Mock Zen 2',
      provider: 'opencode-zen',
      endpoint: 'https://opencode.ai/zen/v1/chat/completions',
      isFree: true,
    },
  ];

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rotates to next free model when current model is exhausted', async () => {
    const router = new RoundRobinRouter({
      customZenModels: customModels,
      persistState: false,
      cooldownMs: 60_000,
    });

    const rotatedEvents: Array<{ from: string; to: string }> = [];
    router.on('model-rotated', (from, to) => {
      rotatedEvents.push({ from, to });
    });

    // Mock zenClient.chat: mock-zen-1 fails with ModelExhaustedError (429), mock-zen-2 succeeds
    const mockSuccessResponse: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'mock-zen-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock-zen-2' },
          finish_reason: 'stop',
        },
      ],
    };

    const zenClient = (router as any).zenClient;
    vi.spyOn(zenClient, 'chat').mockImplementation(async (model: ModelInfo) => {
      if (model.id === 'mock-zen-1') {
        throw new ModelExhaustedError('mock-zen-1', {
          type: 'rate_limit',
          message: 'Rate limit exceeded (429)',
          statusCode: 429,
        });
      }
      return mockSuccessResponse;
    });

    const result = await router.chat({
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(result.choices[0].message.content).toBe('Hello from mock-zen-2');
    expect(rotatedEvents.length).toBe(1);
    expect(rotatedEvents[0]).toEqual({ from: 'mock-zen-1', to: 'mock-zen-2' });

    // Verify mock-zen-1 is marked as exhausted
    const statuses = router.getModelStatuses();
    const zen1Status = statuses.find((s) => s.model.id === 'mock-zen-1');
    expect(zen1Status?.isExhausted).toBe(true);
  });

  it('falls back to Ollama when all OpenCode Zen models are exhausted', async () => {
    const router = new RoundRobinRouter({
      customZenModels: customModels,
      persistState: false,
      cooldownMs: 60_000,
    });

    let ollamaFallbackCalled = false;
    router.on('ollama-fallback', (models) => {
      ollamaFallbackCalled = true;
      expect(models).toContain('qwen2.5-coder:latest');
    });

    const zenClient = (router as any).zenClient;
    vi.spyOn(zenClient, 'chat').mockRejectedValue(
      new ModelExhaustedError('mock', {
        type: 'rate_limit',
        message: 'Rate limited',
        statusCode: 429,
      })
    );

    const ollamaClient = (router as any).ollamaClient;
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([
      {
        id: 'qwen2.5-coder:latest',
        name: 'Ollama: qwen2.5-coder',
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        isFree: true,
      },
    ]);

    const mockOllamaResponse: ChatCompletionResponse = {
      id: 'ollama-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'qwen2.5-coder:latest',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Local Ollama response' },
          finish_reason: 'stop',
        },
      ],
      _roundRobin: {
        routedModel: 'qwen2.5-coder:latest',
        provider: 'ollama',
        attemptsCount: 1,
        rotationHistory: [],
      },
    };

    vi.spyOn(ollamaClient, 'chat').mockResolvedValue(mockOllamaResponse);

    const result = await router.chat({
      messages: [{ role: 'user', content: 'Hello' }],
    });

    expect(ollamaFallbackCalled).toBe(true);
    expect(result.choices[0].message.content).toBe('Local Ollama response');
    expect(result._roundRobin?.provider).toBe('ollama');
  });

  it('gracefully ends the loop and lets user know when all Zen models are exhausted and no Ollama models are available', async () => {
    const router = new RoundRobinRouter({
      customZenModels: customModels,
      persistState: false,
    });

    let allExhaustedEmitted = false;
    router.on('all-exhausted', (summary) => {
      allExhaustedEmitted = true;
      expect(summary.message).toContain('All free models are currently exhausted');
    });

    const zenClient = (router as any).zenClient;
    vi.spyOn(zenClient, 'chat').mockRejectedValue(
      new ModelExhaustedError('mock', {
        type: 'rate_limit',
        message: 'Rate limit hit',
        statusCode: 429,
      })
    );

    const ollamaClient = (router as any).ollamaClient;
    // Ollama returns 0 capable models (or is offline)
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([]);

    await expect(
      router.chat({ messages: [{ role: 'user', content: 'Test' }] })
    ).rejects.toThrowError(AllModelsExhaustedError);

    expect(allExhaustedEmitted).toBe(true);
  });

  it('gracefully ends the loop when all Zen models are exhausted and all Ollama models error out', async () => {
    const router = new RoundRobinRouter({
      customZenModels: customModels,
      persistState: false,
    });

    const zenClient = (router as any).zenClient;
    vi.spyOn(zenClient, 'chat').mockRejectedValue(
      new ModelExhaustedError('mock', {
        type: 'rate_limit',
        message: 'Rate limit hit',
        statusCode: 429,
      })
    );

    const ollamaClient = (router as any).ollamaClient;
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([
      {
        id: 'broken-model',
        name: 'Ollama: broken-model',
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        isFree: true,
      },
    ]);

    vi.spyOn(ollamaClient, 'chat').mockRejectedValue(new Error('Server error 500'));

    let allExhaustedEmitted = false;
    router.on('all-exhausted', (summary) => {
      allExhaustedEmitted = true;
      expect(summary.ollamaModels).toContain('broken-model');
    });

    await expect(
      router.chat({ messages: [{ role: 'user', content: 'Test' }] })
    ).rejects.toThrowError(AllModelsExhaustedError);

    expect(allExhaustedEmitted).toBe(true);
  });

  it('streams completion and falls back to Ollama streaming when Zen models are exhausted', async () => {
    const router = new RoundRobinRouter({
      customZenModels: customModels,
      persistState: false,
    });

    const zenClient = (router as any).zenClient;
    vi.spyOn(zenClient, 'streamChat').mockImplementation(async function* () {
      throw new ModelExhaustedError('mock-zen', {
        type: 'rate_limit',
        message: 'Rate limit reached',
        statusCode: 429,
      });
    });

    const ollamaClient = (router as any).ollamaClient;
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([
      {
        id: 'stream-ollama',
        name: 'Ollama: stream-ollama',
        provider: 'ollama',
        endpoint: 'http://localhost:11434/v1/chat/completions',
        isFree: true,
      },
    ]);

    vi.spyOn(ollamaClient, 'streamChat').mockImplementation(async function* () {
      yield {
        id: 's-1',
        object: 'chat.completion.chunk',
        created: 1,
        model: 'stream-ollama',
        choices: [{ index: 0, delta: { content: 'Streaming Ollama!' }, finish_reason: 'stop' }],
      };
    });

    const chunks = [];
    for await (const chunk of router.streamChat({ messages: [{ role: 'user', content: 'test' }] })) {
      chunks.push(chunk);
    }

    expect(chunks.length).toBe(1);
    expect(chunks[0].choices[0].delta.content).toBe('Streaming Ollama!');
  });
});
