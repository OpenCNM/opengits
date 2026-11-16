import { describe, it, expect } from 'vitest';
import { CreateModelProviderSchema, UpdateModelProviderSchema, TestConnectionSchema } from '@/lib/schemas/model-provider';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';

describe('Model Provider Schemas & 2026 Presets Suite', () => {
  describe('AI_PROVIDER_PRESETS 2026 Registry', () => {
    it('包含全部主流厂商预设且格式完备', () => {
      const keys = Object.keys(AI_PROVIDER_PRESETS);
      expect(keys).toContain('google');
      expect(keys).toContain('deepseek');
      expect(keys).toContain('zhipu');
      expect(keys).toContain('dashscope');
      expect(keys).toContain('openai');
      expect(keys).toContain('anthropic');
      expect(keys).toContain('custom');

      for (const preset of Object.values(AI_PROVIDER_PRESETS)) {
        expect(preset.id).toBeTruthy();
        expect(preset.name).toBeTruthy();
        expect(preset.baseUrl).toMatch(/^https?:\/\//);
        expect(['openai', 'anthropic']).toContain(preset.apiFormat);
        expect(preset.models.length).toBeGreaterThan(0);
        expect(preset.models).toContain(preset.defaultModel);
      }
    });

    it('Google Gemini 预设包含 2026 旗舰模型 gemini-3.7-flash 与 gemini-3.1-pro', () => {
      const google = AI_PROVIDER_PRESETS.google;
      expect(google).toBeDefined();
      expect(google.models).toContain('gemini-3.7-flash');
      expect(google.models).toContain('gemini-3.1-pro');
      expect(google.defaultModel).toBe('gemini-3.7-flash');
    });

    it('DeepSeek 预设已迁移至 V4 架构并移除废弃模型', () => {
      const deepseek = AI_PROVIDER_PRESETS.deepseek;
      expect(deepseek).toBeDefined();
      expect(deepseek.models).toContain('deepseek-v4-pro');
      expect(deepseek.models).toContain('deepseek-v4-flash');
      expect(deepseek.models).not.toContain('deepseek-chat');
      expect(deepseek.models).not.toContain('deepseek-reasoner');
    });
  });

  describe('CreateModelProviderSchema Validation', () => {
    it('合法入参能够成功通过校验', () => {
      const valid = {
        providerKey: 'google_cloud_custom',
        name: 'Google Custom',
        label: 'Google Custom (Vertex)',
        badgeLabel: '🔴 Google Custom',
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiFormat: 'openai',
        defaultModel: 'gemini-3.7-flash',
        models: ['gemini-3.7-flash', 'gemini-3.1-pro'],
        isEnabled: true,
        isDefault: false,
        displayOrder: 1,
        description: 'Custom Google endpoint',
      };
      const parsed = CreateModelProviderSchema.safeParse(valid);
      expect(parsed.success).toBe(true);
    });

    it('非法 URL 或空模型列表将拒绝通过', () => {
      const invalidUrl = {
        providerKey: 'bad_url',
        name: 'Bad URL',
        label: 'Bad',
        badgeLabel: 'Bad',
        baseUrl: 'not-a-valid-url',
        defaultModel: 'test',
        models: ['test'],
      };
      const res1 = CreateModelProviderSchema.safeParse(invalidUrl);
      expect(res1.success).toBe(false);

      const emptyModels = {
        providerKey: 'empty_models',
        name: 'Empty Models',
        label: 'Empty',
        badgeLabel: 'Empty',
        baseUrl: 'https://api.example.com/v1',
        defaultModel: 'test',
        models: [],
      };
      const res2 = CreateModelProviderSchema.safeParse(emptyModels);
      expect(res2.success).toBe(false);
    });
  });

  describe('TestConnectionSchema Validation', () => {
    it('检测连通性入参校验正确', () => {
      const valid = {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: 'AIzaSyExampleKey',
        apiFormat: 'openai',
        model: 'gemini-3.7-flash',
      };
      const parsed = TestConnectionSchema.safeParse(valid);
      expect(parsed.success).toBe(true);

      const missingKey = {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
        apiKey: '',
        model: 'gemini-3.7-flash',
      };
      const res = TestConnectionSchema.safeParse(missingKey);
      expect(res.success).toBe(false);
    });
  });
});
