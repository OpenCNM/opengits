import { describe, expect, it } from 'vitest';
import {
  decryptApiKey,
  encryptApiKey,
  isEncryptedApiKey,
  maskApiKey,
  tryDecryptApiKey,
} from '@/lib/crypto/api-key-cipher';

describe('api-key-cipher', () => {
  it('roundtrips plaintext through encrypt → decrypt', () => {
    const plain = 'sk-test-1234567890abcdef';
    const sealed = encryptApiKey(plain);
    expect(isEncryptedApiKey(sealed)).toBe(true);
    expect(sealed).not.toContain(plain);
    expect(decryptApiKey(sealed)).toBe(plain);
  });

  it('encrypt is idempotent (already-sealed input returned as-is)', () => {
    const sealed = encryptApiKey('sk-abc');
    expect(encryptApiKey(sealed)).toBe(sealed);
  });

  it('decrypt passes through legacy plaintext rows (migration transition)', () => {
    expect(decryptApiKey('sk-legacy-plaintext')).toBe('sk-legacy-plaintext');
  });

  it('🧪 [8.2.1.1] rejects tampered ciphertext (GCM auth tag)', () => {
    const sealed = encryptApiKey('sk-secret');
    const parts = sealed.split(':');
    // 篡改密文段（最后一段 base64 翻转字符）
    const ct = parts[parts.length - 1];
    const flipped = ct.endsWith('A') ? ct.slice(0, -1) + 'B' : ct.slice(0, -1) + 'A';
    const tampered = [...parts.slice(0, -1), flipped].join(':');
    expect(() => decryptApiKey(tampered)).toThrow();
    expect(tryDecryptApiKey(tampered)).toBeNull();
  });

  it('🧪 [8.2.3.1] 测试模型连通性时 baseURL 校验拦截私有 IP / 云元数据 IP（防 SSRF 扫描）', async () => {
    const { isPublicHttpEndpoint } = await import('@/lib/url-inspector');

    // 1. 合法公开端点放行
    expect(isPublicHttpEndpoint('https://api.openai.com/v1')).toBe(true);
    expect(isPublicHttpEndpoint('https://dashscope.aliyuncs.com/compatible-mode/v1')).toBe(true);

    // 2. 本地回环与内网私有 IP 拦截
    expect(isPublicHttpEndpoint('http://localhost:11434/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://127.0.0.1:8000/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://192.168.1.100/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://10.0.0.1:8080/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://172.16.0.1/v1')).toBe(false);

    // 3. 云元数据 IP 拦截 (AWS/GCP/Aliyun 169.254.169.254)
    expect(isPublicHttpEndpoint('http://169.254.169.254/latest/meta-data')).toBe(false);

    // 4. 非法危险端口拦截
    expect(isPublicHttpEndpoint('http://example.com:22/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://example.com:3306/v1')).toBe(false);
    expect(isPublicHttpEndpoint('http://example.com:6379/v1')).toBe(false);
  });

  it('handles empty string without wrapping', () => {
    expect(encryptApiKey('')).toBe('');
    expect(decryptApiKey('')).toBe('');
    expect(isEncryptedApiKey('')).toBe(false);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    const a = encryptApiKey('sk-same-input');
    const b = encryptApiKey('sk-same-input');
    expect(a).not.toBe(b);
    expect(decryptApiKey(a)).toBe('sk-same-input');
    expect(decryptApiKey(b)).toBe('sk-same-input');
  });

  it('maskApiKey keeps head/tail fragments for human recognition', () => {
    expect(maskApiKey('sk-1234567890wxyz')).toBe('sk-12••••••••••••wxyz');
    expect(maskApiKey('short')).toBe('••••••••');
    expect(maskApiKey('')).toBe('');
  });

  it('rejects malformed ciphertext segments, invalid IV length, or invalid tag length', () => {
    // 1. 段数错误
    expect(() => decryptApiKey('enc:v1:onlyonepart')).toThrow('malformed ciphertext: expected iv:tag:ct segments');
    expect(() => decryptApiKey('enc:v1:two:parts')).toThrow('malformed ciphertext: expected iv:tag:ct segments');

    // 2. IV 长度错误（例如 IV 只有 8 字节）
    const shortIvB64 = Buffer.from('12345678').toString('base64');
    const validTagB64 = Buffer.alloc(16).toString('base64');
    const ctB64 = Buffer.from('hello').toString('base64');
    expect(() => decryptApiKey(`enc:v1:${shortIvB64}:${validTagB64}:${ctB64}`)).toThrow('invalid iv length');

    // 3. AuthTag 长度错误（例如 Tag 只有 12 字节）
    const validIvB64 = Buffer.alloc(12).toString('base64');
    const shortTagB64 = Buffer.from('123456789012').toString('base64');
    expect(() => decryptApiKey(`enc:v1:${validIvB64}:${shortTagB64}:${ctB64}`)).toThrow('invalid auth tag length');
  });

  it('🧪 [8.2.2.1] api-key-cipher re-exports sanitizeLogPayload cleanly', async () => {
    const { sanitizeLogPayload } = await import('@/lib/crypto/api-key-cipher');
    expect(typeof sanitizeLogPayload).toBe('function');
    const sensitive = { apiKey: 'sk-1234567890abcdef123', provider: 'openai', model: 'gpt-4o' };
    const sanitized = sanitizeLogPayload(sensitive);
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.provider).toBe('openai');
  });
});
