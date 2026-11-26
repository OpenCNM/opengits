type ModelThinkingType = 'thinking-only' | 'thinking-optional' | 'non-thinking';

type ThinkingMode = 'fast' | 'deep' | 'default';

interface ModelThinkingCapability {
  type: ModelThinkingType;
  supportsDisable: boolean;
  supportsThinking: boolean;
  description: string;
}

export function normalizeModelId(modelId?: string): string {
  if (!modelId) return '';
  const trimmed = modelId.trim().toLowerCase();
  const lastSlash = trimmed.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  const colonIdx = baseName.indexOf(':');
  return colonIdx >= 0 ? baseName.slice(0, colonIdx) : baseName;
}

export function getModelThinkingCapability(
  modelId?: string,
  providerKey?: string
): ModelThinkingCapability {
  const normId = normalizeModelId(modelId);
  const normProvider = (providerKey || '').trim().toLowerCase();

  const isThinkingOnly =
    normId.includes('deepseek-r1') ||
    normId === 'deepseek-reasoner' ||
    normId.includes('deepseek-reasoner') ||
    normId === 'glm-5.3-flash' ||
    normId.includes('glm-zero') ||
    /^o[13](-|$|mini|preview)/.test(normId) ||
    normId.startsWith('qwq') ||
    /\bthinking-\d{4}\b/.test(normId) ||
    /^qwen3-(?:\d+b|next)[\w.-]*-thinking(?:-|$)/.test(normId) ||
    normId.includes('thinking-only') ||
    normId.includes('reasoning-only');

  if (isThinkingOnly) {
    return {
      type: 'thinking-only',
      supportsDisable: false,
      supportsThinking: true,
      description: '原生深度思考模型（强制长链推理，无法完全关闭）',
    };
  }

  const isQwenHybrid =
    normId.includes('qwen') &&
    (normId.includes('thinking') ||
      normId.includes('reasoning') ||
      ((normId === 'qwen-plus' ||
        normId === 'qwen-plus-latest' ||
        normId === 'qwen-max-latest' ||
        /^qwen3(?:\.\d+)?(?:-[a-z0-9._-]+)?$/.test(normId)) &&
        !normId.includes('instruct') &&
        !normId.includes('coder')));

  const isThinkingOptional =
    normId.includes('claude-3-7') ||
    normId.includes('claude-3.7') ||
    (normId.includes('gemini') && normId.includes('thinking')) ||
    isQwenHybrid ||
    (normId.includes('thinking') && !normId.includes('only'));

  if (isThinkingOptional) {
    return {
      type: 'thinking-optional',
      supportsDisable: true,
      supportsThinking: true,
      description: '混合思考模型（支持自由开启或关闭深度思考）',
    };
  }

  // Never inject thinking options for non-thinking models; strict endpoints reject unknown fields with 400.
  return {
    type: 'non-thinking',
    supportsDisable: false,
    supportsThinking: false,
    description: '标准直出模型（无深度思考模式）',
  };
}

interface ResolveThinkingOptionsParams {
  modelId?: string;
  provider?: string;
  apiFormat?: 'openai' | 'anthropic';
  mode?: ThinkingMode;
  disableThinking?: boolean;
  enableThinking?: boolean;
}

export function buildThinkingProviderOptions(
  params: ResolveThinkingOptionsParams
): Record<string, unknown> | undefined {
  let effectiveMode: ThinkingMode = 'default';
  if (params.mode) {
    effectiveMode = params.mode;
  } else if (params.disableThinking === true) {
    effectiveMode = 'fast';
  } else if (params.enableThinking === true) {
    effectiveMode = 'deep';
  }

  if (effectiveMode === 'default') {
    return undefined;
  }

  const normProvider = (params.provider || '').trim().toLowerCase();
  const normId = normalizeModelId(params.modelId);
  const capability = getModelThinkingCapability(params.modelId, params.provider);

  if (capability.type === 'non-thinking') {
    return undefined;
  }

  if (effectiveMode === 'fast') {
    if (capability.type === 'thinking-only') {
      return {
        openai: { reasoningEffort: 'low' },
        openaiCompatible: { reasoningEffort: 'low' },
        compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
      };
    }

    if (capability.type === 'thinking-optional') {
      if (params.apiFormat === 'anthropic' || normProvider === 'anthropic') {
        return {
          anthropic: { thinking: { type: 'disabled' } },
        };
      }
      if (normProvider === 'siliconflow') {
        return {
          compatible: { enable_thinking: false },
        };
      }
      if (normId.includes('claude-3-7') || normId.includes('claude-3.7')) {
        return {
          anthropic: { thinking: { type: 'disabled' } },
          openai: { reasoningEffort: 'low' },
          openaiCompatible: { reasoningEffort: 'low' },
          compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
        };
      }
      return {
        anthropic: { thinking: { type: 'disabled' } },
        openai: { reasoningEffort: 'low' },
        openaiCompatible: { reasoningEffort: 'none' },
        compatible: { reasoningEffort: 'none', enable_thinking: false, reasoning_effort: 'none' },
      };
    }
  }

  if (effectiveMode === 'deep') {
    if (capability.type === 'thinking-only') {
      // GLM-5.3 rejects 'medium'; 'high' is the common high-effort value across thinking-only families.
      return {
        openai: { reasoningEffort: 'high' },
        openaiCompatible: { reasoningEffort: 'high' },
        compatible: { reasoningEffort: 'high', reasoning_effort: 'high' },
      };
    }

    if (capability.type === 'thinking-optional') {
      if (params.apiFormat === 'anthropic' || normProvider === 'anthropic') {
        return {
          anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } },
        };
      }
      return {
        anthropic: { thinking: { type: 'enabled', budgetTokens: 4000 } },
        openai: { reasoningEffort: 'medium' },
        openaiCompatible: { reasoningEffort: 'medium' },
        compatible: { reasoningEffort: 'medium', enable_thinking: true, reasoning_effort: 'medium' },
      };
    }
  }

  return undefined;
}
