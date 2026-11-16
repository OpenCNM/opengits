import { describe, it, expect } from 'vitest';
import { CreateModelProviderSchema, UpdateModelProviderSchema, TestConnectionSchema } from '@/lib/schemas/model-provider';

describe('Admin Providers Validation (Item 11)', () => {
  describe('model name formatting', () => {
    it('rejects model name containing whitespace', () => {
      const res = CreateModelProviderSchema.safeParse({
        providerKey: 'test_provider',
        name: 'Test Provider',
        label: 'Test Label',
        badgeLabel: 'Test Badge',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt 4o',
        models: ['gpt 4o'],
      });
      expect(res.success).toBe(false);
    });

    it('rejects model name exceeding 120 characters', () => {
      const longModel = 'a'.repeat(121);
      const res = CreateModelProviderSchema.safeParse({
        providerKey: 'test_provider',
        name: 'Test Provider',
        label: 'Test Label',
        badgeLabel: 'Test Badge',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: 'gpt-4o',
        models: [longModel],
      });
      expect(res.success).toBe(false);
    });

    it('accepts valid model names up to 120 chars without spaces', () => {
      const validModel = 'meta-llama/Llama-3.3-70B-Instruct-Turbo';
      const res = CreateModelProviderSchema.safeParse({
        providerKey: 'test_provider',
        name: 'Test Provider',
        label: 'Test Label',
        badgeLabel: 'Test Badge',
        baseUrl: 'https://api.openai.com/v1',
        defaultModel: validModel,
        models: [validModel],
      });
      expect(res.success).toBe(true);
    });
  });

  describe('baseUrl SSRF check with isPublicHttpEndpoint', () => {
    it('rejects private / loopback / metadata baseUrl', () => {
      const privateUrls = [
        'http://localhost:8000',
        'http://127.0.0.1:11434',
        'http://192.168.1.100:8000',
        'http://10.0.0.1/v1',
        'http://169.254.169.254/latest/meta-data',
      ];

      for (const url of privateUrls) {
        const res = CreateModelProviderSchema.safeParse({
          providerKey: 'local_provider',
          name: 'Local Provider',
          label: 'Local',
          badgeLabel: 'Local',
          baseUrl: url,
          defaultModel: 'llama3',
          models: ['llama3'],
        });
        expect(res.success).toBe(false);
      }
    });

    it('accepts valid public https baseUrl', () => {
      const res = CreateModelProviderSchema.safeParse({
        providerKey: 'dashscope_custom',
        name: 'DashScope Custom',
        label: 'DashScope',
        badgeLabel: 'DashScope',
        baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
        defaultModel: 'qwen-plus',
        models: ['qwen-plus'],
      });
      expect(res.success).toBe(true);
    });
  });

  describe('UpdateModelProviderSchema', () => {
    it('rejects invalid baseUrl or model name in partial update', () => {
      const res1 = UpdateModelProviderSchema.safeParse({
        baseUrl: 'http://127.0.0.1:8000',
      });
      expect(res1.success).toBe(false);

      const res2 = UpdateModelProviderSchema.safeParse({
        defaultModel: 'model with spaces',
      });
      expect(res2.success).toBe(false);
    });
  });
});
