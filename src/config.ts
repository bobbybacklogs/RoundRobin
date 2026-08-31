import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config as loadDotEnv } from 'dotenv';
import {
  DEFAULT_COOLDOWN_MS,
  DEFAULT_OLLAMA_HOST,
  DEFAULT_REQUEST_TIMEOUT_MS,
  DEFAULT_SERVER_PORT,
  DEFAULT_ZEN_BASE_URL,
} from './constants.js';
import { RoundRobinConfig } from './types.js';

// Attempt to load .env in cwd
loadDotEnv();

export function getConfigFilePath(): string {
  const homeDir = os.homedir();
  const dir = path.join(homeDir, '.roundrobin');
  return path.join(dir, 'config.json');
}

export function getStateFilePath(): string {
  const homeDir = os.homedir();
  const dir = path.join(homeDir, '.roundrobin');
  return path.join(dir, 'state.json');
}

export interface RouterPersistedState {
  modelCooldowns: Record<string, { exhaustedUntil: number; lastError?: string }>;
  lastUsedIndex?: number;
}

export function loadRouterState(): RouterPersistedState {
  try {
    const file = getStateFilePath();
    if (fs.existsSync(file)) {
      const content = fs.readFileSync(file, 'utf8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore error
  }
  return { modelCooldowns: {} };
}

export function saveRouterState(state: RouterPersistedState): void {
  try {
    const file = getStateFilePath();
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(file, JSON.stringify(state, null, 2), 'utf8');
  } catch {
    // Ignore error
  }
}

export function loadUserConfig(): Partial<RoundRobinConfig> {
  const candidates = [
    path.resolve(process.cwd(), '.roundrobinrc'),
    path.resolve(process.cwd(), '.roundrobin.json'),
    getConfigFilePath(),
    path.join(os.homedir(), '.roundrobinrc'),
  ];

  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const content = fs.readFileSync(file, 'utf8');
        return JSON.parse(content);
      }
    } catch {
      // Ignore read/parse error and try next
    }
  }

  return {};
}

export function saveUserConfig(newConfig: Partial<RoundRobinConfig>): string {
  const filePath = getConfigFilePath();
  const dir = path.dirname(filePath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const existing = loadUserConfig();
  const merged = { ...existing, ...newConfig };
  fs.writeFileSync(filePath, JSON.stringify(merged, null, 2), 'utf8');
  return filePath;
}

export function resolveConfig(overrides: Partial<RoundRobinConfig> = {}): Required<RoundRobinConfig> & { port: number } {
  const fileConfig = loadUserConfig();

  const apiKey =
    overrides.openCodeZenApiKey ||
    process.env.OPENCODE_ZEN_API_KEY ||
    process.env.OPENCODE_API_KEY ||
    process.env.ZEN_API_KEY ||
    fileConfig.openCodeZenApiKey ||
    '';

  const openCodeZenBaseUrl =
    overrides.openCodeZenBaseUrl ||
    process.env.OPENCODE_ZEN_BASE_URL ||
    fileConfig.openCodeZenBaseUrl ||
    DEFAULT_ZEN_BASE_URL;

  const ollamaHost =
    overrides.ollamaHost ||
    process.env.OLLAMA_HOST ||
    fileConfig.ollamaHost ||
    DEFAULT_OLLAMA_HOST;

  const cooldownMs =
    overrides.cooldownMs ??
    (process.env.ROUNDROBIN_COOLDOWN_MS ? parseInt(process.env.ROUNDROBIN_COOLDOWN_MS, 10) : undefined) ??
    fileConfig.cooldownMs ??
    DEFAULT_COOLDOWN_MS;

  const requestTimeoutMs =
    overrides.requestTimeoutMs ??
    (process.env.ROUNDROBIN_TIMEOUT_MS ? parseInt(process.env.ROUNDROBIN_TIMEOUT_MS, 10) : undefined) ??
    fileConfig.requestTimeoutMs ??
    DEFAULT_REQUEST_TIMEOUT_MS;

  const maxRetriesPerModel =
    overrides.maxRetriesPerModel ??
    fileConfig.maxRetriesPerModel ??
    1;

  const autoCooldownReset =
    overrides.autoCooldownReset ??
    fileConfig.autoCooldownReset ??
    true;

  const port =
    (process.env.ROUNDROBIN_PORT ? parseInt(process.env.ROUNDROBIN_PORT, 10) : undefined) ??
    DEFAULT_SERVER_PORT;

  return {
    openCodeZenApiKey: apiKey,
    openCodeZenBaseUrl,
    ollamaHost,
    cooldownMs,
    requestTimeoutMs,
    maxRetriesPerModel,
    autoCooldownReset,
    port,
  };
}
