/**
 * Encryption for stored provider API keys.
 *
 * Electron's safeStorage encrypts against the OS keychain, which is what makes
 * moving keys out of the renderer's IndexedDB worthwhile. It is injected as an
 * interface rather than imported here so the provider store stays testable
 * without an Electron runtime, and so a build with no usable keychain fails
 * loudly instead of silently writing plaintext.
 */

/** The slice of Electron's safeStorage this module needs. */
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export interface SecretCipher {
  /** False when the OS refuses a keychain; callers must then refuse to store secrets. */
  available(): boolean;
  encrypt(plain: string): string;
  /**
   * Undefined when the ciphertext cannot be read. That is an expected outcome,
   * not a fault: a dev run and a packaged build use different keychain
   * entries, so keys written by one are unreadable by the other.
   */
  decrypt(cipher: string): string | undefined;
}

export function createSafeStorageCipher(safeStorage: SafeStorageLike): SecretCipher {
  return {
    available: () => {
      try {
        return safeStorage.isEncryptionAvailable();
      } catch {
        return false;
      }
    },
    encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
    decrypt: (cipher) => {
      try {
        return safeStorage.decryptString(Buffer.from(cipher, 'base64'));
      } catch {
        return undefined;
      }
    },
  };
}

/** Refuses to hold secrets at all. The default when no keychain is available. */
export const unavailableCipher: SecretCipher = {
  available: () => false,
  encrypt: () => {
    throw new Error('secret storage is unavailable');
  },
  decrypt: () => undefined,
};
