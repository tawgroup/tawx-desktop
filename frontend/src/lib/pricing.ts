import type { CompletionUsage, Provider } from '../types.ts';

interface TokenRates {
  cachedInput: number;
  uncachedInput: number;
  output: number;
}

const TOKENS_PER_MILLION = 1_000_000;
const DEEPSEEK_PRO_RETIREMENT = Date.UTC(2026, 8, 14, 4);
const DEEPSEEK_FLASH_PEAK: TokenRates = { cachedInput: 0.006, uncachedInput: 0.3, output: 1.2 };
const DEEPSEEK_PRO_PEAK: TokenRates = { cachedInput: 0.044, uncachedInput: 1.32, output: 3.96 };

/**
 * Estimates charges only when the provider's public tariff is unambiguous.
 * A cost reported by the provider remains authoritative and bypasses this code.
 * DeepSeek rates: https://api-docs.deepseek.com/quick_start/pricing (2026-09-10).
 */
export function estimateUsageCost(
  provider: Provider,
  model: string,
  usage: CompletionUsage,
  at = new Date(),
): number | undefined {
  if (isLocalProvider(provider)) return 0;
  if (!isDeepSeek(provider)) return undefined;

  const rates = deepSeekRates(model, at);
  if (!rates) return undefined;

  const input = usage.prompt_tokens ?? usage.input_tokens ?? 0;
  const output = usage.completion_tokens ?? usage.output_tokens ?? 0;
  const cached = Math.min(
    input,
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const uncached = Math.min(
    input - cached,
    usage.prompt_cache_miss_tokens ?? input - cached,
  );

  return (
    cached * rates.cachedInput
    + uncached * rates.uncachedInput
    + output * rates.output
  ) / TOKENS_PER_MILLION;
}

function isLocalProvider(provider: Provider): boolean {
  if (provider.kind === 'ollama') return true;
  if (provider.authKind !== 'none') return false;
  const baseUrl = provider.billingBaseUrl ?? provider.baseUrl;
  if (!/^https?:\/\//i.test(baseUrl)) return false;
  try {
    const hostname = new URL(baseUrl).hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isDeepSeek(provider: Provider): boolean {
  const baseUrl = provider.billingBaseUrl ?? provider.baseUrl;
  try {
    return new URL(baseUrl).hostname === 'api.deepseek.com';
  } catch {
    return false;
  }
}

function deepSeekRates(model: string, at: Date): TokenRates | undefined {
  const bareModel = model.slice(model.lastIndexOf('/') + 1).toLowerCase();
  const flash = bareModel === 'deepseek-flash'
    || bareModel === 'deepseek-v4-flash'
    || bareModel === 'deepseek-v4-flash-vision-exp';
  const retiredPro = bareModel === 'deepseek-v4-pro' && at.getTime() >= DEEPSEEK_PRO_RETIREMENT;
  const peakRates = flash || retiredPro
    ? DEEPSEEK_FLASH_PEAK
    : bareModel === 'deepseek-v4-pro'
      ? DEEPSEEK_PRO_PEAK
      : undefined;
  if (!peakRates) return undefined;
  if (isDeepSeekPeakHour(at)) return peakRates;
  return {
    cachedInput: peakRates.cachedInput / 2,
    uncachedInput: peakRates.uncachedInput / 2,
    output: peakRates.output / 2,
  };
}

function isDeepSeekPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}
