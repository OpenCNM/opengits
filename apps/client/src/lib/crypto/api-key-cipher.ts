import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { ignoreBestEffort } from '../best-effort';
import { resolveSecret } from '../secrets';

const ENC_PREFIX = 'enc:v1:';
const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

let cachedKey: Buffer | null = null;

// Derive fixed 256-bit AES key from arbitrary-length env secret; cached in-process.
function masterKey(): Buffer {
  if (!cachedKey) {
    const master = resolveSecret(
      'BYOK_ENC_KEY',
      'insecure_dev_byok_enc_key_DO_NOT_USE_IN_PRODUCTION'
    );
    cachedKey = createHash('sha256').update(master).digest();
  }
  return cachedKey;
}

export function isEncryptedApiKey(value: string): boolean {
  return typeof value === 'string' && value.startsWith(ENC_PREFIX);
}

export function maskApiKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••••••';
  return `${trimmed.slice(0, 5)}••••••••••••${trimmed.slice(-4)}`;
}

export function encryptApiKey(plaintext: string): string {
  if (!plaintext) return plaintext;
  if (isEncryptedApiKey(plaintext)) return plaintext;
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, masterKey(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${ENC_PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

// Passes through unprefixed legacy plaintext rows, but throws on tampered v1 GCM auth tags.
export function decryptApiKey(stored: string): string {
  if (!stored) return stored;
  if (!isEncryptedApiKey(stored)) return stored;
  const parts = stored.slice(ENC_PREFIX.length).split(':');
  if (parts.length !== 3) {
    throw new Error('[api-key-cipher] malformed ciphertext: expected iv:tag:ct segments');
  }
  const [ivB64, tagB64, ctB64] = parts;
  const ivBuf = Buffer.from(ivB64, 'base64');
  const tagBuf = Buffer.from(tagB64, 'base64');

  if (ivBuf.length !== IV_BYTES) {
    throw new Error('[api-key-cipher] malformed ciphertext: invalid iv length');
  }
  if (tagBuf.length !== TAG_BYTES) {
    throw new Error('[api-key-cipher] malformed ciphertext: invalid auth tag length');
  }

  try {
    const decipher = createDecipheriv(ALGO, masterKey(), ivBuf);
    decipher.setAuthTag(tagBuf);
    return Buffer.concat([
      decipher.update(Buffer.from(ctB64, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    throw new Error(
      '[api-key-cipher] decrypt failed (auth tag mismatch or key rotation without re-encrypt)'
    );
  }
}

export function tryDecryptApiKey(stored: string): string | null {
  try {
    return decryptApiKey(stored);
  } catch {
    ignoreBestEffort();
    return null;
  }
}

export { sanitizeLogPayload } from './sanitize-log-payload';
