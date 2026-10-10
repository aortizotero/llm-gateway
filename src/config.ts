import { readFileSync } from 'node:fs';
import type { BreakerConfig } from './breaker.ts';
import { hasPrice, type Pricing } from './pricing.ts';
import { anthropic } from './providers/anthropic.ts';
import { openaiCompat } from './providers/openai-compat.ts';
import type { ProviderAdapter } from './providers/types.ts';

export interface ProviderConfig {
  type: 'anthropic' | 'openai-compat';
  baseUrl: string;
  keyEnv: string;
  maxTokensOverrun?: number; // billed output can exceed max_tokens by this factor (default 1)
}

export interface Config {
  providers: Record<string, ProviderConfig>;
  aliases: Record<string, string[]>;
  timeouts: { perHopMs: number; firstTokenMs: number };
  breaker: BreakerConfig;
  defaults: { maxTokens: number; maxTokensCeiling: number; rpm: number; tpm: number; monthlyBudgetUsd: number };
}

// Budgets need a price for every hop an alias can land on; catch gaps at startup.
export function validatePricing(config: Config, pricing: Pricing): void {
  for (const [alias, chain] of Object.entries(config.aliases)) {
    for (const hop of chain) if (!hasPrice(pricing, hop)) throw new Error(`Alias "${alias}": no price for "${hop}" in pricing.json`);
  }
}

export function loadConfig(path = 'config/gateway.json'): Config {
  const config = JSON.parse(readFileSync(path, 'utf8')) as Config;
  for (const [alias, chain] of Object.entries(config.aliases)) {
    if (!chain.length) throw new Error(`Alias "${alias}" has an empty chain`);
    for (const hop of chain) {
      const provider = hop.split(':')[0];
      if (!config.providers[provider]) throw new Error(`Alias "${alias}" references unknown provider "${provider}"`);
    }
  }
  return config;
}

// Fails at startup, not on the first request, when a provider key is missing.
export function buildAdapters(config: Config, env: NodeJS.ProcessEnv = process.env): Record<string, ProviderAdapter> {
  const adapters: Record<string, ProviderAdapter> = {};
  for (const [name, p] of Object.entries(config.providers)) {
    const key = env[p.keyEnv];
    if (!key) throw new Error(`Missing env var ${p.keyEnv} for provider "${name}"`);
    adapters[name] =
      p.type === 'anthropic' ? anthropic(p.baseUrl, key, config.defaults.maxTokens) : openaiCompat(name, p.baseUrl, key);
  }
  return adapters;
}
