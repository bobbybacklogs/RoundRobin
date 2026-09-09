import { describe, expect, it } from 'vitest';
import { AI_GATEWAY_FREE_MODELS } from '../src/constants.js';
import { isFreeGatewayLanguageModel, preferExplicitFreeModels } from '../src/gateway.js';

describe('Vercel AI Gateway Free Models', () => {
  it('should contain the curated free language models', () => {
    const expectedModelIds = [
      'inclusionai/ling-3.0-flash-fin-free',
      'inclusionai/ling-3.0-flash-sante-free',
      'poolside/laguna-s-2.1-free',
    ];

    expect(AI_GATEWAY_FREE_MODELS.map((m) => m.id)).toEqual(expectedModelIds);
  });

  it('every model should be flagged as isFree = true and provider = ai-gateway', () => {
    for (const model of AI_GATEWAY_FREE_MODELS) {
      expect(model.isFree).toBe(true);
      expect(model.provider).toBe('ai-gateway');
      expect(model.endpoint).toContain('https://ai-gateway.vercel.sh/v1');
    }
  });

  it('preferExplicitFreeModels keeps only language free models and prefers -free ids', () => {
    const selected = preferExplicitFreeModels([
      {
        id: 'inclusionai/ling-3.0-flash-fin',
        name: 'Ling Fin',
        type: 'language',
        tags: ['free'],
        pricing: { input: 0, output: 0 },
      },
      {
        id: 'inclusionai/ling-3.0-flash-fin-free',
        name: 'Ling Fin Free',
        type: 'language',
        tags: ['free'],
        pricing: { input: '0', output: '0' },
      },
      {
        id: 'fish-audio/s1-free',
        name: 'Speech',
        type: 'speech',
        tags: ['free'],
        pricing: { input: 0, output: 0 },
      },
      {
        id: 'poolside/laguna-s-2.1-free',
        name: 'Laguna',
        type: 'language',
        tags: ['free'],
        pricing: { input: 0, output: 0 },
      },
      {
        id: 'openai/gpt-5.4',
        name: 'Paid',
        type: 'language',
        tags: [],
        pricing: { input: 0.0000025, output: 0.000015 },
      },
    ]);

    expect(selected.map((m) => m.id)).toEqual([
      'inclusionai/ling-3.0-flash-fin-free',
      'poolside/laguna-s-2.1-free',
    ]);
  });

  it('isFreeGatewayLanguageModel rejects non-free or non-language entries', () => {
    expect(
      isFreeGatewayLanguageModel({
        id: 'x',
        type: 'language',
        tags: ['free'],
        pricing: { input: 0, output: 0 },
      })
    ).toBe(true);

    expect(
      isFreeGatewayLanguageModel({
        id: 'x',
        type: 'speech',
        tags: ['free'],
        pricing: { input: 0, output: 0 },
      })
    ).toBe(false);

    expect(
      isFreeGatewayLanguageModel({
        id: 'x',
        type: 'language',
        tags: ['tool-use'],
        pricing: { input: 0, output: 0 },
      })
    ).toBe(false);
  });
});
