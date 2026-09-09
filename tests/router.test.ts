import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllModelsExhaustedError, ModelExhaustedError } from '../src/errors.js';
import { RoundRobinRouter } from '../src/router.js';
import { ChatCompletionResponse, ModelInfo } from '../src/types.js';

describe('RoundRobinRouter', () => {
  const customModels: ModelInfo[] = [
    {
      id: 'mock-gateway-1',
      name: 'Mock Gateway 1',
      provider: 'ai-gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
      isFree: true,
    },
    {
      id: 'mock-gateway-2',
      name: 'Mock Gateway 2',
      provider: 'ai-gateway',
      endpoint: 'https://ai-gateway.vercel.sh/v1/chat/completions',
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
      customGatewayModels: customModels,
      persistState: false,
      cooldownMs: 60_000,
      requireAiGateway: false,
      refreshFreeModels: false,
    });

    const rotatedEvents: Array<{ from: string; to: string }> = [];
    router.on('model-rotated', (from, to) => {
      rotatedEvents.push({ from, to });
    });

    const mockSuccessResponse: ChatCompletionResponse = {
      id: 'chatcmpl-123',
      object: 'chat.completion',
      created: Date.now(),
      model: 'mock-gateway-2',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Hello from mock-gateway-2' },
          finish_reason: 'stop',
        },
      ],
    };

    const gatewayClient = (router as any).gatewayClient;
    vi.spyOn(gatewayClient, 'chat').mockImplementation(async (model: ModelInfo) => {
      if (model.id === 'mock-gateway-1') {
        throw new ModelExhaustedError('mock-gateway-1', {
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

    expect(result.choices[0].message.content).toBe('Hello from mock-gateway-2');
    expect(rotatedEvents.length).toBe(1);
    expect(rotatedEvents[0]).toEqual({ from: 'mock-gateway-1', to: 'mock-gateway-2' });

    const statuses = router.getModelStatuses();
    const g1Status = statuses.find((s) => s.model.id === 'mock-gateway-1');
    expect(g1Status?.isExhausted).toBe(true);
  });

  it('falls back to Ollama when all AI Gateway models are exhausted', async () => {
    const router = new RoundRobinRouter({
      customGatewayModels: customModels,
      persistState: false,
      cooldownMs: 60_000,
      requireAiGateway: false,
      refreshFreeModels: false,
    });

    let ollamaFallbackCalled = false;
    router.on('ollama-fallback', (models) => {
      ollamaFallbackCalled = true;
      expect(models).toContain('qwen2.5-coder:latest');
    });

    const gatewayClient = (router as any).gatewayClient;
    vi.spyOn(gatewayClient, 'chat').mockRejectedValue(
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

  it('gracefully ends when all Gateway models are exhausted and no Ollama models are available', async () => {
    const router = new RoundRobinRouter({
      customGatewayModels: customModels,
      persistState: false,
      requireAiGateway: false,
      refreshFreeModels: false,
    });

    let allExhaustedEmitted = false;
    router.on('all-exhausted', (summary) => {
      allExhaustedEmitted = true;
      expect(summary.message).toContain('All free models are currently exhausted');
    });

    const gatewayClient = (router as any).gatewayClient;
    vi.spyOn(gatewayClient, 'chat').mockRejectedValue(
      new ModelExhaustedError('mock', {
        type: 'rate_limit',
        message: 'Rate limit hit',
        statusCode: 429,
      })
    );

    const ollamaClient = (router as any).ollamaClient;
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([]);

    await expect(
      router.chat({ messages: [{ role: 'user', content: 'Test' }] })
    ).rejects.toThrowError(AllModelsExhaustedError);

    expect(allExhaustedEmitted).toBe(true);
  });

  it('gracefully ends when all Gateway models are exhausted and all Ollama models error out', async () => {
    const router = new RoundRobinRouter({
      customGatewayModels: customModels,
      persistState: false,
      requireAiGateway: false,
      refreshFreeModels: false,
    });

    const gatewayClient = (router as any).gatewayClient;
    vi.spyOn(gatewayClient, 'chat').mockRejectedValue(
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

  it('streams completion and falls back to Ollama streaming when Gateway models are exhausted', async () => {
    const router = new RoundRobinRouter({
      customGatewayModels: customModels,
      persistState: false,
      requireAiGateway: false,
      refreshFreeModels: false,
    });

    const gatewayClient = (router as any).gatewayClient;
    vi.spyOn(gatewayClient, 'streamChat').mockImplementation(async function* () {
      throw new ModelExhaustedError('mock-gateway', {
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

  it('treats free Gateway models as unavailable when AI Gateway/Pro is missing', async () => {
    const auth = await import('../src/auth.js');
    vi.spyOn(auth, 'checkVercelAiGatewayStatus').mockResolvedValue({
      loggedIn: true,
      username: 'tester',
      gatewayAvailable: false,
      reason:
        'AI Gateway is unavailable. It requires a Vercel Pro membership. Free Gateway models are not available without AI Gateway.',
    });

    const router = new RoundRobinRouter({
      customGatewayModels: customModels,
      persistState: false,
      requireAiGateway: true,
      refreshFreeModels: false,
    });

    let gatewayUnavailable = false;
    router.on('gateway-unavailable', () => {
      gatewayUnavailable = true;
    });

    const ollamaClient = (router as any).ollamaClient;
    vi.spyOn(ollamaClient, 'listCapableModels').mockResolvedValue([]);

    await expect(
      router.chat({ messages: [{ role: 'user', content: 'Test' }] })
    ).rejects.toThrowError(AllModelsExhaustedError);

    expect(gatewayUnavailable).toBe(true);
    expect(router.getModelStatuses().length).toBe(0);
  });
});
