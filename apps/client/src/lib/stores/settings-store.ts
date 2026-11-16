import { create } from 'zustand';
import {
  STORAGE_KEYS,
  AGENT_DEFAULTS,
  type ExplainDepth,
} from '@/lib/constants';
import { normalizeExplainDepth } from '@/lib/ai/response-depth';

/**
 * 客户端 Agent 设置的唯一真相源（取代 SETTINGS_UPDATED 事件总线 + 多处手写
 * localStorage 双写）。持久化策略：写穿（write-through）到既有 STORAGE_KEYS
 * 原生键位——api-key-guard、ingest 循环等旧读取方无需迁移即可继续工作；
 * 动态变量（STORAGE_KEYS.VAR_* 裸键）注册表化为 vars 字段。
 *
 * 注意 SSR：localStorage 只能在挂载后的 effect / 事件回调中触碰；
 * initSettings() 由宿主组件挂载时调用一次。
 */

/** 单个 agent 设置字段与其 localStorage 键位/兜底值的映射注册表（modelsList 以 JSON 序列化） */
const FIELD_KEYS = {
  apiKey: STORAGE_KEYS.VAR_API_KEY,
  projectId: STORAGE_KEYS.VAR_PROJECT_ID,
  tutoringStyle: STORAGE_KEYS.AGENT_TUTORING_STYLE,
  explainDepth: STORAGE_KEYS.AGENT_EXPLAIN_DEPTH,
  preferredLang: STORAGE_KEYS.AGENT_PREFERRED_LANG,
  responseLang: STORAGE_KEYS.AGENT_RESPONSE_LANG,
  customInstructions: STORAGE_KEYS.AGENT_CUSTOM_INSTRUCTIONS,
  appearanceMode: STORAGE_KEYS.AGENT_APPEARANCE_MODE,
  provider: STORAGE_KEYS.AGENT_PROVIDER,
  providerName: STORAGE_KEYS.AGENT_PROVIDER_NAME,
  baseUrl: STORAGE_KEYS.AGENT_BASE_URL,
  apiFormat: STORAGE_KEYS.AGENT_API_FORMAT,
  modelsList: STORAGE_KEYS.AGENT_MODELS_LIST,
  model: STORAGE_KEYS.AGENT_MODEL,
} as const;

export interface AgentSettings {
  apiKey: string;
  projectId: string;
  tutoringStyle: string;
  explainDepth: ExplainDepth;
  preferredLang: string;
  responseLang: string;
  customInstructions: string;
  appearanceMode: string;
  provider: string;
  providerName: string;
  baseUrl: string;
  apiFormat: string;
  modelsList: string[];
  model: string;
  /** 动态变量注册表（`opengits_var_<NAME>` 裸键），键为变量名 */
  vars: Record<string, string>;
}

interface SettingsStoreState extends AgentSettings {
  /** 从 localStorage 恢复（挂载时调用一次；SSR 安全） */
  initSettings: () => void;
  /** 局部更新：状态与对应 localStorage 键同步写穿（数组序列化为 JSON） */
  setSettings: (patch: Partial<Omit<AgentSettings, 'vars'>>) => void;
}

/** 动态变量的 localStorage 裸键（外部契约：DynamicVar 展示名不可变更） */
const varKey = (name: string): string => `opengits_var_${name}`;

function readString(key: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeString(key: string, value: string): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch {}
}

export const useSettingsStore = create<SettingsStoreState>((set, get) => ({
  apiKey: '',
  projectId: '',
  tutoringStyle: AGENT_DEFAULTS.tutoringStyle,
  explainDepth: AGENT_DEFAULTS.explainDepth,
  preferredLang: AGENT_DEFAULTS.preferredLang,
  responseLang: AGENT_DEFAULTS.responseLang,
  customInstructions: '',
  appearanceMode: AGENT_DEFAULTS.appearanceMode,
  provider: AGENT_DEFAULTS.provider,
  providerName: '',
  baseUrl: '',
  apiFormat: '',
  modelsList: [],
  model: AGENT_DEFAULTS.model,
  vars: {},

  initSettings: () => {
    const stringFields = Object.fromEntries(
      Object.entries(FIELD_KEYS).map(([field, key]) => {
        const fallback = (get() as unknown as Record<string, string>)[field] ?? '';
        return [field, readString(key, fallback)];
      })
    ) as unknown as Record<keyof typeof FIELD_KEYS, string>;

    // 动态变量：从裸键空间恢复（存量用户数据兼容）
    const vars: Record<string, string> = {};
    if (typeof window !== 'undefined') {
      try {
        for (let i = 0; i < localStorage.length; i++) {
          const key = localStorage.key(i);
          if (key?.startsWith('opengits_var_')) {
            vars[key.slice('opengits_var_'.length)] = localStorage.getItem(key) ?? '';
          }
        }
      } catch {}
    }

    // 归一化 explainDepth：未知或脏缓存值回退默认「simple」，确保提示词阶梯分支收敛
    const normalizedDepth = normalizeExplainDepth(stringFields.explainDepth);

    set({ ...stringFields, explainDepth: normalizedDepth, vars } as unknown as Partial<SettingsStoreState>);
  },

  setSettings: (patch) => {
    for (const [field, value] of Object.entries(patch)) {
      const key = FIELD_KEYS[field as keyof typeof FIELD_KEYS];
      if (!key) continue;
      writeString(key, Array.isArray(value) ? JSON.stringify(value) : value);
    }
    set(patch as Partial<SettingsStoreState>);
  },

}));
