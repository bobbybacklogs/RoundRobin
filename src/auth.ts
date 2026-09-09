import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GatewayUnavailableError } from './errors.js';

const execFileAsync = promisify(execFile);

export interface VercelCliStatus {
  loggedIn: boolean;
  username?: string;
  gatewayAvailable: boolean;
  reason?: string;
  keyCount?: number;
}

/**
 * Resolve an AI Gateway API key from environment / config.
 * OIDC tokens from `vercel env pull` are also accepted.
 */
export function resolveAiGatewayApiKey(explicit?: string): string {
  return (
    explicit ||
    process.env.AI_GATEWAY_API_KEY ||
    process.env.VERCEL_OIDC_TOKEN ||
    process.env.VERCEL_AI_GATEWAY_API_KEY ||
    ''
  ).trim();
}

type Runner = { command: string; args: string[] };

function vercelRunners(args: string[]): Runner[] {
  if (process.platform === 'win32') {
    return [
      { command: 'npx.cmd', args: ['--yes', 'vercel@latest', ...args] },
      { command: 'vercel.cmd', args },
      { command: 'npx', args: ['--yes', 'vercel@latest', ...args] },
    ];
  }
  return [
    { command: 'npx', args: ['--yes', 'vercel@latest', ...args] },
    { command: 'vercel', args },
  ];
}

async function runVercel(args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let lastError = '';

  for (const runner of vercelRunners(args)) {
    try {
      const { stdout, stderr } = await execFileAsync(runner.command, runner.args, {
        windowsHide: true,
        timeout: 90_000,
        maxBuffer: 2 * 1024 * 1024,
        env: process.env,
        // Windows needs a shell to resolve npx.cmd / vercel.cmd shims.
        // Args are fixed CLI flags only (no user-controlled interpolation).
        shell: process.platform === 'win32',
      });
      return { ok: true, stdout: stdout || '', stderr: stderr || '' };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      lastError = e.stderr || e.message || String(err);
      if (e.stdout || e.stderr) {
        const combined = `${e.stdout || ''}\n${e.stderr || ''}`;
        if (looksLikePlanOrGatewayBlock(combined)) {
          return { ok: false, stdout: e.stdout || '', stderr: e.stderr || lastError };
        }
      }
    }
  }

  return { ok: false, stdout: '', stderr: lastError };
}

function looksLikePlanOrGatewayBlock(text: string): boolean {
  return /pro\s*(plan|membership)|upgrade\s*to\s*pro|ai\s*gateway.*(unavailable|not\s*available|requires)|not\s*available\s*on\s*(hobby|free)|plan\s*does\s*not\s*include/i.test(
    text
  );
}

/**
 * Probe Vercel CLI login and AI Gateway availability.
 * AI Gateway (and therefore free Gateway models) require Pro membership.
 *
 * If an AI Gateway API key is already configured, treat Gateway as available even
 * when the CLI probe cannot confirm login (common on some Windows shells).
 */
export async function checkVercelAiGatewayStatus(options?: {
  apiKeyPresent?: boolean;
}): Promise<VercelCliStatus> {
  const whoami = await runVercel(['whoami']);
  if (!whoami.ok) {
    if (options?.apiKeyPresent) {
      return {
        loggedIn: false,
        gatewayAvailable: true,
        reason:
          'Vercel CLI login could not be verified, but AI_GATEWAY_API_KEY is set so free Gateway models remain enabled.',
      };
    }
    return {
      loggedIn: false,
      gatewayAvailable: false,
      reason:
        'Vercel CLI is not logged in. Run `vercel login`, then ensure your team has Pro access to AI Gateway. Free Gateway models are not available without AI Gateway.',
    };
  }

  const username = whoami.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('npm ') && !line.includes('deprecated'))
    .pop();

  const keys = await runVercel(['ai-gateway', 'api-keys', 'ls', '--format', 'json']);
  const combined = `${keys.stdout}\n${keys.stderr}`;

  if (looksLikePlanOrGatewayBlock(combined)) {
    return {
      loggedIn: true,
      username,
      gatewayAvailable: false,
      reason:
        'AI Gateway is unavailable. It requires a Vercel Pro membership. Free Gateway models are not available without AI Gateway.',
    };
  }

  if (!keys.ok) {
    if (options?.apiKeyPresent) {
      return {
        loggedIn: true,
        username,
        gatewayAvailable: true,
        reason:
          'AI Gateway key is configured. CLI key listing failed, but free Gateway models remain enabled.',
      };
    }
    return {
      loggedIn: true,
      username,
      gatewayAvailable: false,
      reason:
        'Unable to verify AI Gateway via Vercel CLI. Free Gateway models are not available until AI Gateway is accessible (Pro membership required).',
    };
  }

  try {
    const jsonStart = keys.stdout.indexOf('{');
    const jsonEnd = keys.stdout.lastIndexOf('}');
    if (jsonStart >= 0 && jsonEnd > jsonStart) {
      const parsed = JSON.parse(keys.stdout.slice(jsonStart, jsonEnd + 1)) as {
        apiKeys?: unknown[];
        keys?: unknown[];
      };
      const list = parsed.apiKeys || parsed.keys || [];
      return {
        loggedIn: true,
        username,
        gatewayAvailable: true,
        keyCount: Array.isArray(list) ? list.length : 0,
      };
    }
  } catch {
    // Non-JSON success still means the command worked under this login.
  }

  return {
    loggedIn: true,
    username,
    gatewayAvailable: true,
  };
}

export async function assertAiGatewayAvailable(options?: {
  apiKeyPresent?: boolean;
}): Promise<VercelCliStatus> {
  const status = await checkVercelAiGatewayStatus(options);
  if (!status.gatewayAvailable) {
    throw new GatewayUnavailableError(status.reason || 'AI Gateway unavailable');
  }
  return status;
}
