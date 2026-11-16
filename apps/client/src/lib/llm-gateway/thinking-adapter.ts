/**
 * Thinking Capability Adapter (模型思考能力适配器)
 *
 * 核心职责：
 * 1. 模型思考能力分类：根据模型 ID 与提供商，判定属于 thinking-only（原生强制思考）、
 *    thinking-optional（可开可关思考）还是 non-thinking（传统无思考模型）。
 * 2. 跨厂商与聚合平台兼容：兼顾阿里百炼 (DashScope)、硅基流动 (SiliconFlow)、OpenRouter
 *    等综合服务商在同一端点下混跑各种异构模型的场景。
 * 3. 意图驱动的参数渲染：根据调用方意图（fast: 极速出词/最低思考; deep: 深度推理; default: 保持缺省），
 *    生成合规的 ProviderOptions，坚决杜绝因错误传参导致的 400 Bad Request。
 */

type ModelThinkingType = 'thinking-only' | 'thinking-optional' | 'non-thinking';

type ThinkingMode = 'fast' | 'deep' | 'default';

interface ModelThinkingCapability {
  type: ModelThinkingType;
  /** 是否支持关闭思考（true 则可彻底关闭；false 则即使 fast 模式也只能压低思考强度） */
  supportsDisable: boolean;
  /** 是否具备思考/推理能力（false 则禁止任何思考参数注入，防止 400 报错） */
  supportsThinking: boolean;
  /** 适合 UI 展示的特性描述 */
  description: string;
}

/**
 * 标准化模型标识（去除大小写、去除组织/镜像前缀如 `deepseek-ai/`、`openai/`）
 */
export function normalizeModelId(modelId?: string): string {
  if (!modelId) return '';
  const trimmed = modelId.trim().toLowerCase();
  const lastSlash = trimmed.lastIndexOf('/');
  const baseName = lastSlash >= 0 ? trimmed.slice(lastSlash + 1) : trimmed;
  // 去除常见的冒号标签（如 :free, :thinking）
  const colonIdx = baseName.indexOf(':');
  return colonIdx >= 0 ? baseName.slice(0, colonIdx) : baseName;
}

/**
 * 判定模型的思考能力
 */
export function getModelThinkingCapability(
  modelId?: string,
  providerKey?: string
): ModelThinkingCapability {
  const normId = normalizeModelId(modelId);
  const normProvider = (providerKey || '').trim().toLowerCase();

  // 1. 原生强制思考模型 (thinking-only)
  // 特征：不支持关闭思考，强行关闭会报错；快速意图下只能压低思考强度 (low)
  const isThinkingOnly =
    // DeepSeek R1 系列（含百炼、硅基流动、官方等各种衍生命名）
    normId.includes('deepseek-r1') ||
    normId === 'deepseek-reasoner' ||
    normId.includes('deepseek-reasoner') ||
    // 智谱原生思考模型
    normId === 'glm-5.3-flash' ||
    normId.includes('glm-zero') ||
    // OpenAI o-系列
    /^o[13](-|$|mini|preview)/.test(normId) ||
    // Qwen 推理专用模型 (QwQ)
    normId.startsWith('qwq') ||
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

  // 2. 思考可选模型 (thinking-optional)
  // 特征：支持协议参数显式开启或完全关闭
  const isThinkingOptional =
    // Anthropic Claude 3.7
    normId.includes('claude-3-7') ||
    normId.includes('claude-3.7') ||
    // Google Gemini 思考版
    (normId.includes('gemini') && normId.includes('thinking')) ||
    // Qwen 思考可配置版 (如 qwen3-thinking, qwen-plus-latest 思考配置)
    (normId.includes('qwen') && (normId.includes('thinking') || normId.includes('reasoning'))) ||
    // 通用含 thinking / thought 命名（排除 thinking-only）
    (normId.includes('thinking') && !normId.includes('only'));

  if (isThinkingOptional) {
    return {
      type: 'thinking-optional',
      supportsDisable: true,
      supportsThinking: true,
      description: '混合思考模型（支持自由开启或关闭深度思考）',
    };
  }

  // 3. 传统无思考模型 (non-thinking)
  // 兜底安全：不注入任何思考参数，防止向严格端点（如 gpt-4o, deepseek-chat）发送未定义字段触发 400
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
  /** 调用方意图：fast = 最低延迟/关闭思考; deep = 深度推理; default = 保持模型缺省 */
  mode?: ThinkingMode;
  /** 兼容既有布尔参数：disableThinking = true 等价于 mode = 'fast' */
  disableThinking?: boolean;
  /** 兼容既有布尔参数：enableThinking = true 等价于 mode = 'deep' */
  enableThinking?: boolean;
}

/**
 * 统一构建 ProviderOptions
 */
export function buildThinkingProviderOptions(
  params: ResolveThinkingOptionsParams
): Record<string, unknown> | undefined {
  // 解析有效意图
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

  const capability = getModelThinkingCapability(params.modelId, params.provider);

  // 场景 A：传统无思考模型 -> 无论什么意图均绝不注入思考参数，防止 400
  if (capability.type === 'non-thinking') {
    return undefined;
  }

  // 场景 B：极速直出模式（fast：针对大纲提炼、分类裁决、JSON 提取等）
  if (effectiveMode === 'fast') {
    if (capability.type === 'thinking-only') {
      // 无法关闭思考：安全降级至最低思考强度 (low)
      return {
        openai: { reasoningEffort: 'low' },
        openaiCompatible: { reasoningEffort: 'low' },
        compatible: { reasoningEffort: 'low', reasoning_effort: 'low' },
      };
    }

    if (capability.type === 'thinking-optional') {
      // 支持关闭思考：显式发送关闭协议
      if (params.apiFormat === 'anthropic' || params.provider === 'anthropic') {
        return {
          anthropic: { thinking: { type: 'disabled' } },
        };
      }
      return {
        anthropic: { thinking: { type: 'disabled' } },
        openai: { reasoningEffort: 'low' },
        openaiCompatible: { reasoningEffort: 'low' },
        compatible: { reasoningEffort: 'low', enable_thinking: false, reasoning_effort: 'none' },
      };
    }
  }

  // 场景 C：深度推理模式（deep：针对小节测验出题、复杂代码攻坚）
  if (effectiveMode === 'deep') {
    if (capability.type === 'thinking-only') {
      // 原生思考模型已天然开启，补充高强度档位。物理事实（docs.bigmodel.cn
      // /guide/capabilities/thinking）：GLM-5.3 系列 reasoning_effort 仅接受
      // max/high/low，传 medium 直接 400——'high' 是跨 thinking-only 家族
      // （GLM-5.3 / o-系列 / QwQ）的唯一合法高档公共值。
      return {
        openai: { reasoningEffort: 'high' },
        openaiCompatible: { reasoningEffort: 'high' },
        compatible: { reasoningEffort: 'high', reasoning_effort: 'high' },
      };
    }

    if (capability.type === 'thinking-optional') {
      // 显式开启深度思考
      if (params.apiFormat === 'anthropic' || params.provider === 'anthropic') {
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
