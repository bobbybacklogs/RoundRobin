import {
  DEFAULT_COOLDOWN_MS,
  EXHAUSTION_HTTP_STATUS_CODES,
  EXHAUSTION_MESSAGE_PATTERNS,
} from './constants.js';
import { ExhaustionReason } from './types.js';

export function isExhaustionResponse(
  status: number,
  bodyText: string,
  headers?: Headers
): { isExhausted: boolean; reason?: ExhaustionReason } {
  let isExhausted = EXHAUSTION_HTTP_STATUS_CODES.has(status);
  let detectedType: ExhaustionReason['type'] = 'other';
  let message = `HTTP ${status}: ${bodyText.slice(0, 200)}`;

  if (status === 429) {
    detectedType = 'rate_limit';
    isExhausted = true;
  } else if (status === 402) {
    detectedType = 'quota_exceeded';
    isExhausted = true;
  } else if (status === 503 || status === 504) {
    detectedType = 'service_unavailable';
    isExhausted = true;
  }

  // Also parse body for structured errors
  try {
    const parsed = JSON.parse(bodyText);
    const errMsg = parsed.error?.message || parsed.message || parsed.detail || '';
    const errCode = parsed.error?.code || parsed.code || '';

    const combined = `${errMsg} ${errCode}`;
    for (const pattern of EXHAUSTION_MESSAGE_PATTERNS) {
      if (pattern.test(combined)) {
        isExhausted = true;
        detectedType = pattern.test('quota') ? 'quota_exceeded' : 'rate_limit';
        message = errMsg || combined;
        break;
      }
    }
  } catch {
    // If not JSON, check plain text
    for (const pattern of EXHAUSTION_MESSAGE_PATTERNS) {
      if (pattern.test(bodyText)) {
        isExhausted = true;
        detectedType = pattern.test('quota') ? 'quota_exceeded' : 'rate_limit';
        message = bodyText.slice(0, 200);
        break;
      }
    }
  }

  if (!isExhausted) {
    return { isExhausted: false };
  }

  // Extract Retry-After header if present
  let retryAfterMs = DEFAULT_COOLDOWN_MS;
  if (headers) {
    const retryAfterHeader = headers.get('retry-after');
    if (retryAfterHeader) {
      const seconds = parseFloat(retryAfterHeader);
      if (!isNaN(seconds) && seconds > 0) {
        retryAfterMs = seconds * 1000;
      } else {
        const date = new Date(retryAfterHeader);
        if (!isNaN(date.getTime())) {
          const diff = date.getTime() - Date.now();
          if (diff > 0) retryAfterMs = diff;
        }
      }
    }
  }

  return {
    isExhausted: true,
    reason: {
      type: detectedType,
      message,
      statusCode: status,
      retryAfterMs,
    },
  };
}

export function isNetworkExhaustionError(err: unknown): { isExhausted: boolean; reason?: ExhaustionReason } {
  if (!err) return { isExhausted: false };
  const message = err instanceof Error ? err.message : String(err);

  for (const pattern of EXHAUSTION_MESSAGE_PATTERNS) {
    if (pattern.test(message)) {
      return {
        isExhausted: true,
        reason: {
          type: 'rate_limit',
          message,
          retryAfterMs: DEFAULT_COOLDOWN_MS,
        },
      };
    }
  }

  if (message.includes('ECONNREFUSED') || message.includes('ETIMEDOUT') || message.includes('fetch failed')) {
    return {
      isExhausted: true,
      reason: {
        type: 'network_error',
        message,
        retryAfterMs: 15_000,
      },
    };
  }

  return { isExhausted: false };
}

export async function* parseServerSentEvents(
  bodyStream: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = bodyStream.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(':')) continue;

        if (trimmed.startsWith('data:')) {
          const data = trimmed.slice(5).trim();
          if (data === '[DONE]') {
            return;
          }
          yield data;
        }
      }
    }

    if (buffer.trim()) {
      const trimmed = buffer.trim();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data !== '[DONE]') {
          yield data;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export function formatDuration(ms: number): string {
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSec = seconds % 60;
  return `${minutes}m ${remainingSec}s`;
}
