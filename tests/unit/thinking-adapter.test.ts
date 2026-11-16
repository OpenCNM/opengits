import { describe, it, expect } from 'vitest';
import {
  getModelThinkingCapability,
  buildThinkingProviderOptions,
  normalizeModelId,
} from '@/lib/llm-gateway/thinking-adapter';

describe('Thinking Capability Adapter (模型思考能力适配器)', () => {
  describe('normalizeModelId', () => {
    it('去除组织名前缀与大小写归一化', () => {
      expect(normalizeModelId('deepseek-ai/deepseek-r1')).toBe('deepseek-r1');
      expect(normalizeModelId('OpenAI/O3-Mini')).toBe('o3-mini');
      expect(normalizeModelId('anthropic/claude-3.7-sonnet:thinking')).toBe('claude-3.7-sonnet');
      expect(normalizeModelId('')).toBe('');
      expect(normalizeModelId(undefined)).toBe('');
    });
  });

  describe('getModelThinkingCapability (分类与厂商兼容)', () => {
    it('Type A: 原生不可关闭思考模型 (thinking-only)', () => {
      // 智谱原生思考模型
      const glm = getModelThinkingCapability('glm-5.3-flash', 'zhipu');
      expect(glm.type).toBe('thinking-only');
      expect(glm.supportsDisable).toBe(false);
      expect(glm.supportsThinking).toBe(true);

      // DeepSeek R1 各种镜像与官方命名
      const r1Direct = getModelThinkingCapability('deepseek-reasoner', 'deepseek');
      expect(r1Direct.type).toBe('thinking-only');
      expect(r1Direct.supportsDisable).toBe(false);

      const r1Mirror = getModelThinkingCapability('deepseek-ai/deepseek-r1', 'siliconflow');
      expect(r1Mirror.type).toBe('thinking-only');

      const r1Distill = getModelThinkingCapability('deepseek-r1-distill-qwen-32b', 'dashscope');
      expect(r1Distill.type).toBe('thinking-only');

      // OpenAI o-系列
      const o1 = getModelThinkingCapability('o1', 'openai');
      expect(o1.type).toBe('thinking-only');
      const o3Mini = getModelThinkingCapability('o3-mini', 'openai');
      expect(o3Mini.type).toBe('thinking-only');

      // QwQ
      const qwq = getModelThinkingCapability('qwq-32b', 'dashscope');
      expect(qwq.type).toBe('thinking-only');
    });

    it('Type B: 思考可选模型 (thinking-optional)', () => {
      // Anthropic Claude 3.7
      const claude37 = getModelThinkingCapability('claude-3-7-sonnet', 'anthropic');
      expect(claude37.type).toBe('thinking-optional');
      expect(claude37.supportsDisable).toBe(true);
      expect(claude37.supportsThinking).toBe(true);

      // Gemini Thinking
      const gemini = getModelThinkingCapability('gemini-2.0-flash-thinking-exp', 'google');
      expect(gemini.type).toBe('thinking-optional');
      expect(gemini.supportsDisable).toBe(true);

      // Qwen Thinking
      const qwenThinking = getModelThinkingCapability('qwen3-thinking', 'dashscope');
      expect(qwenThinking.type).toBe('thinking-optional');
      expect(qwenThinking.supportsDisable).toBe(true);
    });

    it('Type C: 传统无思考模型 (non-thinking)', () => {
      // OpenAI GPT-4o
      const gpt4o = getModelThinkingCapability('gpt-4o', 'openai');
      expect(gpt4o.type).toBe('non-thinking');
      expect(gpt4o.supportsThinking).toBe(false);

      // DeepSeek V3
      const deepseekChat = getModelThinkingCapability('deepseek-chat', 'deepseek');
      expect(deepseekChat.type).toBe('non-thinking');
      expect(deepseekChat.supportsThinking).toBe(false);

      // Qwen 传统模型
      const qwenTurbo = getModelThinkingCapability('qwen-turbo', 'dashscope');
      expect(qwenTurbo.type).toBe('non-thinking');

      const qwenMax = getModelThinkingCapability('qwen-max', 'dashscope');
      expect(qwenMax.type).toBe('non-thinking');

      // 未知模型兜底安全为 non-thinking (防 400 传参错误)
      const unknownModel = getModelThinkingCapability('my-custom-fine-tuned-model', 'custom');
      expect(unknownModel.type).toBe('non-thinking');
      expect(unknownModel.supportsThinking).toBe(false);
    });

    it('兼容多模型综合服务商（如阿里百炼 DashScope 混跑不同模型）', () => {
      // 同一个 DashScope 提供商下，模型特性由具体的 modelId 决定，而非死板依赖 provider
      const dsR1 = getModelThinkingCapability('deepseek-r1', 'dashscope');
      expect(dsR1.type).toBe('thinking-only');

      const dsV3 = getModelThinkingCapability('deepseek-v3', 'dashscope');
      expect(dsV3.type).toBe('non-thinking');

      const dsQwen = getModelThinkingCapability('qwen3.8-max', 'dashscope');
      expect(dsQwen.type).toBe('non-thinking');
    });
  });

  describe('buildThinkingProviderOptions (意图参数渲染)', () => {
    it('极速模式 (fast / disableThinking: true)：原生思考模型安全降级至 low，绝不报错关闭', () => {
      const opts = buildThinkingProviderOptions({
        modelId: 'glm-5.3-flash',
        disableThinking: true,
      });

      expect(opts).toEqual({
        openai: { reasoningEffort: 'low' },
        openaiCompatible: { reasoningEffort: 'low' },
        compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
      });
    });

    it('极速模式 (fast / disableThinking: true)：可选思考模型显式发送关闭协议', () => {
      const anthropicOpts = buildThinkingProviderOptions({
        modelId: 'claude-3-7-sonnet',
        provider: 'anthropic',
        disableThinking: true,
      });
      expect(anthropicOpts).toEqual({
        anthropic: { thinking: { type: 'disabled' } },
      });

      const qwenOpts = buildThinkingProviderOptions({
        modelId: 'qwen3-thinking',
        provider: 'dashscope',
        disableThinking: true,
      });
      expect(qwenOpts).toMatchObject({
        compatible: { enable_thinking: false, reasoning_effort: 'none' },
      });
    });

    it('极速模式 (fast / disableThinking: true)：传统模型绝不注入思考参数，彻底杜绝 400 错误', () => {
      const gpt4oOpts = buildThinkingProviderOptions({
        modelId: 'gpt-4o',
        disableThinking: true,
      });
      expect(gpt4oOpts).toBeUndefined();

      const deepseekV3Opts = buildThinkingProviderOptions({
        modelId: 'deepseek-chat',
        disableThinking: true,
      });
      expect(deepseekV3Opts).toBeUndefined();
    });

    it('深度思考模式 (deep / enableThinking: true)：thinking-only 模型注入 high——GLM-5.3 系列仅接受 max/high/low，medium 会 400', () => {
      const glmOpts = buildThinkingProviderOptions({
        modelId: 'glm-5.3-flash',
        enableThinking: true,
      });
      expect(glmOpts).toEqual({
        openai: { reasoningEffort: 'high' },
        openaiCompatible: { reasoningEffort: 'high' },
        compatible: { reasoningEffort: 'high', reasoning_effort: 'high' },
      });
    });

    it('深度思考模式 (deep / enableThinking: true)：可选模型注入开启与 token 预算', () => {
      const claudeOpts = buildThinkingProviderOptions({
        modelId: 'claude-3-7-sonnet',
        provider: 'anthropic',
        enableThinking: true,
      });
      expect(claudeOpts).toEqual({
        anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } },
      });

      const qwenOpts = buildThinkingProviderOptions({
        modelId: 'qwen3-thinking',
        enableThinking: true,
      });
      expect(qwenOpts).toMatchObject({
        compatible: { enable_thinking: true, reasoning_effort: 'medium' },
      });
    });

    it('深度思考模式 (deep / enableThinking: true)：传统模型返回 undefined，不强行注入', () => {
      const opts = buildThinkingProviderOptions({
        modelId: 'gpt-4o',
        enableThinking: true,
      });
      expect(opts).toBeUndefined();
    });

    it('缺省模式 (default)：返回 undefined，不干预模型默认行为', () => {
      const opts = buildThinkingProviderOptions({
        modelId: 'glm-5.3-flash',
      });
      expect(opts).toBeUndefined();
    });

  });
});
