/**
 * The one definition of an acceptable provider URL.
 *
 * The rule — HTTPS, or HTTP only for loopback — is enforced wherever a
 * user-supplied provider address is accepted: the remote proxy and the provider
 * registry. The frontend validates the same rule for its error message
 * (frontend/src/lib/providers.ts), which is a deliberate second copy: client
 * validation is a convenience, this one is the guard.
 */

import { isIPv4 } from 'node:net';
import { ApiError, ErrorType } from './errors.js';

/** Mirrors Go's net.IP.IsLoopback, including IPv4-mapped IPv6 (::ffff:127.0.0.1). */
export function isLoopbackHost(host: string): boolean {
  const bare = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (bare === 'localhost') return true;
  if (bare === '::1') return true;
  const mapped = bare.startsWith('::ffff:') ? bare.slice('::ffff:'.length) : bare;
  return isIPv4(mapped) && mapped.startsWith('127.');
}

/**
 * Converts a stored provider URL into the base an adapter expects.
 *
 * Two conventions meet here. Users — and the Settings field's own hint — give
 * the URL "including /v1", because that is what a provider's docs print. The
 * adapters, and config.yaml with them, take a base *without* the version and
 * append `/v1/chat/completions` themselves. Handing one to the other produced
 * `/v1/v1/chat/completions`.
 *
 * Stripping one trailing `/v1` reconciles them and accepts either form, so a
 * user who omits it is equally correct:
 *
 *   https://api.deepseek.com/v1     → https://api.deepseek.com
 *   https://api.groq.com/openai/v1  → https://api.groq.com/openai
 *   https://api.deepseek.com        → https://api.deepseek.com
 */
export function adapterBaseUrl(storedUrl: string): string {
  const trimmed = storedUrl.trim().replace(/\/+$/, '');
  return trimmed.replace(/\/v1$/, '');
}

/**
 * Parses an absolute provider URL, rejecting anything that could smuggle
 * credentials or downgrade the transport. Throws an OpenAI-shaped ApiError.
 */
export function assertProviderUrl(raw: string): URL {
  let target: URL;
  try {
    target = new URL(raw.trim());
  } catch {
    throw new ApiError('invalid provider URL', ErrorType.InvalidRequest);
  }
  if (!target.hostname || target.username || target.password || target.hash) {
    throw new ApiError('invalid provider URL', ErrorType.InvalidRequest);
  }
  if (target.protocol === 'https:') return target;
  if (target.protocol === 'http:' && isLoopbackHost(target.hostname)) return target;
  throw new ApiError(
    'remote providers require HTTPS; HTTP is allowed only for localhost',
    ErrorType.InvalidRequest,
  );
}
