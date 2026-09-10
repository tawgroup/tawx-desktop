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
