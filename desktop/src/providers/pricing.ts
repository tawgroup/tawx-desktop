import type { Usage } from './types.js';

interface TokenRates {
  cachedInput: number;
  uncachedInput: number;
  output: number;
}

const TOKENS_PER_MILLION = 1_000_000;
const DEEPSEEK_PRO_RETIREMENT = Date.UTC(2026, 8, 14, 4);
const FLASH_PEAK: TokenRates = { cachedInput: 0.006, uncachedInput: 0.3, output: 1.2 };
const PRO_PEAK: TokenRates = { cachedInput: 0.044, uncachedInput: 1.32, output: 3.96 };

/**
 * Adds a trustworthy estimate only when upstream did not report an authoritative cost.
 * DeepSeek rates: https://api-docs.deepseek.com/quick_start/pricing (2026-09-10).
 */
export function withEstimatedUsageCost(
  baseUrl: string,
  model: string,
  usage: Usage | undefined,
  at = new Date(),
): Usage | undefined {
  if (!usage || usage.cost !== undefined) return usage;
  if (!isDeepSeek(baseUrl)) return usage;
  const rates = deepSeekRates(model, at);
  if (!rates) return usage;

  const input = usage.prompt_tokens;
  const cached = Math.min(
    input,
    usage.prompt_cache_hit_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0,
  );
  const uncached = Math.min(
    input - cached,
    usage.prompt_cache_miss_tokens ?? input - cached,
  );
  const cost = (
    cached * rates.cachedInput
    + uncached * rates.uncachedInput
    + usage.completion_tokens * rates.output
  ) / TOKENS_PER_MILLION;
  return { ...usage, cost };
}

function isDeepSeek(baseUrl: string): boolean {
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
    ? FLASH_PEAK
    : bareModel === 'deepseek-v4-pro'
      ? PRO_PEAK
      : undefined;
  if (!peakRates || isPeakHour(at)) return peakRates;
  return {
    cachedInput: peakRates.cachedInput / 2,
    uncachedInput: peakRates.uncachedInput / 2,
    output: peakRates.output / 2,
  };
}

function isPeakHour(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = at.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}
