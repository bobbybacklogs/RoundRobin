import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AllModelsExhaustedError } from '../src/errors.js';
import { RoundRobinRouter } from '../src/router.js';
import { RoundRobinServer } from '../src/server.js';
import { ChatCompletionChunk, ChatCompletionResponse } from '../src/types.js';

describe('RoundRobinServer (OpenAI Compatible Proxy)', () => {
  let server: RoundRobinServer;
  let router: RoundRobinRouter;
  let baseUrl: string;

  beforeEach(async () => {
    router = new RoundRobinRouter({ persistState: false });
    // Random port for test isolation
    const testPort = 18000 + Math.floor(Math.random() * 1000);
    server = new RoundRobinServer({ router, port: testPort, host: '127.0.0.1' });
    const info = await server.listen();
    baseUrl = `http://127.0.0.1:${info.port}`;
  });

  afterEach(async () => {
    await server.close();
    vi.restoreAllMocks();
  });

  it('responds to GET /health', async () => {
    const res = await fetch(`${baseUrl}/health`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.status).toBe('ok');
    expect(json.service).toContain('RoundRobin');
  });

  it('responds to GET /v1/models with verified free models', async () => {
    const res = await fetch(`${baseUrl}/v1/models`);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.object).toBe('list');
    expect(Array.isArray(json.data)).toBe(true);
    expect(json.data.length).toBeGreaterThan(0);
    expect(json.data[0].id).toBeDefined();
  });

  it('handles POST /v1/chat/completions (non-streaming)', async () => {
    const mockResponse: ChatCompletionResponse = {
      id: 'chatcmpl-mock',
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model: 'big-pickle',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Server test answer' },
          finish_reason: 'stop',
        },
      ],
    };

    vi.spyOn(router, 'chat').mockResolvedValue(mockResponse);

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.choices[0].message.content).toBe('Server test answer');
  });

  it('handles POST /v1/chat/completions with stream: true (SSE)', async () => {
    async function* mockGenerator(): AsyncGenerator<ChatCompletionChunk> {
      yield {
        id: 'chunk-1',
        object: 'chat.completion.chunk',
        created: 123456,
        model: 'big-pickle',
        choices: [{ index: 0, delta: { content: 'Hello ' }, finish_reason: null }],
      };
      yield {
        id: 'chunk-2',
        object: 'chat.completion.chunk',
        created: 123456,
        model: 'big-pickle',
        choices: [{ index: 0, delta: { content: 'world!' }, finish_reason: 'stop' }],
      };
    }

    vi.spyOn(router, 'streamChat').mockImplementation(mockGenerator);

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
        stream: true,
      }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    const text = await res.text();
    expect(text).toContain('data: {"id":"chunk-1"');
    expect(text).toContain('data: {"id":"chunk-2"');
    expect(text).toContain('data: [DONE]');
  });

  it('returns HTTP 503 with graceful message when all models are exhausted', async () => {
    vi.spyOn(router, 'chat').mockRejectedValue(
      new AllModelsExhaustedError({
        zenExhaustedModels: ['big-pickle', 'mimo-v2.5-free'],
        ollamaChecked: true,
        ollamaModels: [],
      })
    );

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Test' }],
      }),
    });

    expect(res.status).toBe(503);
    const json = await res.json();
    expect(json.error.code).toBe('all_free_models_exhausted');
    expect(json.error.gracefulNotice).toContain('All free models are currently exhausted');
  });
});
