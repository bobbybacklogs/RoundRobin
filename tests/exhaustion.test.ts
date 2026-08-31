import { describe, expect, it } from 'vitest';
import { isExhaustionResponse, isNetworkExhaustionError } from '../src/utils.js';

describe('Exhaustion Detection', () => {
  it('detects HTTP 429 as rate limit exhaustion', () => {
    const res = isExhaustionResponse(429, 'Too many requests');
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.type).toBe('rate_limit');
  });

  it('detects HTTP 402 as quota exhaustion', () => {
    const res = isExhaustionResponse(402, 'Payment Required: Quota exceeded');
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.type).toBe('quota_exceeded');
  });

  it('detects HTTP 503 as service unavailable exhaustion', () => {
    const res = isExhaustionResponse(503, 'Service Unavailable - capacity reached');
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.type).toBe('service_unavailable');
  });

  it('detects quota and rate limit keywords inside JSON response body', () => {
    const body = JSON.stringify({
      error: {
        message: 'You exceeded your current quota, please check your plan and billing details.',
        type: 'insufficient_quota',
      },
    });
    const res = isExhaustionResponse(400, body);
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.type).toBe('quota_exceeded');
  });

  it('parses Retry-After header in seconds', () => {
    const headers = new Headers();
    headers.set('retry-after', '45');
    const res = isExhaustionResponse(429, 'Rate limit', headers);
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.retryAfterMs).toBe(45000);
  });

  it('detects network connection refused errors as network exhaustion', () => {
    const err = new Error('connect ECONNREFUSED 127.0.0.1:11434');
    const res = isNetworkExhaustionError(err);
    expect(res.isExhausted).toBe(true);
    expect(res.reason?.type).toBe('network_error');
  });
});
