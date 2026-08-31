import { describe, expect, it } from 'vitest';
import { OPENCODE_ZEN_FREE_MODELS } from '../src/constants.js';

describe('OpenCode Zen Verified Free Models', () => {
  it('should contain exactly the 6 verified free models from OpenCode Zen docs', () => {
    const expectedModelIds = [
      'big-pickle',
      'mimo-v2.5-free',
      'ling-3.0-flash-fin-free',
      'nemotron-3-ultra-free',
      'nemotron-3.5-lightning-free',
      'muse-spark-1.2-contributor-free',
    ];

    expect(OPENCODE_ZEN_FREE_MODELS.map((m) => m.id)).toEqual(expectedModelIds);
  });

  it('every model should be flagged as isFree = true and provider = opencode-zen', () => {
    for (const model of OPENCODE_ZEN_FREE_MODELS) {
      expect(model.isFree).toBe(true);
      expect(model.provider).toBe('opencode-zen');
      expect(model.endpoint).toContain('https://opencode.ai/zen/v1');
    }
  });
});
