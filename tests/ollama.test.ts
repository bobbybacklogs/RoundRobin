import { describe, expect, it } from 'vitest';
import { OllamaClient } from '../src/ollama.js';

describe('Local Ollama Client', () => {
  it('connects to local Ollama and lists models if available', async () => {
    const client = new OllamaClient();
    const isOnline = await client.isAvailable();
    if (isOnline) {
      const capable = await client.listCapableModels();
      expect(Array.isArray(capable)).toBe(true);
      for (const m of capable) {
        expect(m.provider).toBe('ollama');
        expect(m.isFree).toBe(true);
      }
    } else {
      expect(isOnline).toBe(false);
    }
  });

  it('returns empty array gracefully when host is unreachable', async () => {
    const offlineClient = new OllamaClient({ host: 'http://127.0.0.1:59999' });
    const isOnline = await offlineClient.isAvailable();
    expect(isOnline).toBe(false);
    const models = await offlineClient.listCapableModels();
    expect(models).toEqual([]);
  });
});
