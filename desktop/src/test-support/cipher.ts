/**
 * Test doubles for SecretCipher. Kept out of src/providers so a production
 * import of a cipher that does not encrypt cannot happen by accident.
 */

import type { SecretCipher } from '../providers/secrets.js';

/**
 * Reversible, and deliberately not a passthrough: base64 means a test asserting
 * "the plaintext key is not on disk" is actually testing something. Stands in
 * for a working keychain.
 */
export function identityCipher(): SecretCipher {
  return {
    available: () => true,
    encrypt: (plain) => `b64:${Buffer.from(plain, 'utf8').toString('base64')}`,
    decrypt: (cipher) =>
      cipher.startsWith('b64:')
        ? Buffer.from(cipher.slice('b64:'.length), 'base64').toString('utf8')
        : undefined,
  };
}

/** Encrypts, but can no longer read what it wrote — a keychain that changed. */
export function unreadableCipher(): SecretCipher {
  return {
    available: () => true,
    encrypt: (plain) => `sealed:${plain}`,
    decrypt: () => undefined,
  };
}
