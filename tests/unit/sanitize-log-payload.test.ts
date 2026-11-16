import { describe, it, expect } from 'vitest';
import { sanitizeLogPayload } from '@/lib/crypto/sanitize-log-payload';

describe('sanitizeLogPayload (Item 10)', () => {
  it('replaces sensitive keys like apiKey, token, secret, authorization with [REDACTED]', () => {
    const input = {
      name: 'test-model',
      apiKey: 'sk-1234567890abcdef123456',
      nested: {
        token: 'ghp_abcdefghijklmnopqrstuvwxyz123456',
        secret: 'my-secret-key',
        authorization: 'Bearer secret_token_xyz',
      },
      normalField: 'hello',
    };

    const sanitized = sanitizeLogPayload(input);
    expect(sanitized.apiKey).toBe('[REDACTED]');
    expect(sanitized.nested.token).toBe('[REDACTED]');
    expect(sanitized.nested.secret).toBe('[REDACTED]');
    expect(sanitized.nested.authorization).toBe('[REDACTED]');
    expect(sanitized.normalField).toBe('hello');
  });

  it('redacts inline API key patterns inside string values', () => {
    const errorString = 'Failed to connect: sk-abcdef1234567890abcdef invalid';
    const sanitized = sanitizeLogPayload(errorString);
    expect(sanitized).toBe('Failed to connect: [REDACTED] invalid');
    expect(sanitized).not.toContain('sk-abcdef');
  });

  it('handles circular references safely without infinite recursion', () => {
    const circular: any = { name: 'circular' };
    circular.self = circular;

    const sanitized = sanitizeLogPayload(circular);
    expect(sanitized.name).toBe('circular');
    expect(sanitized.self).toBe('[CIRCULAR]');
  });
});
