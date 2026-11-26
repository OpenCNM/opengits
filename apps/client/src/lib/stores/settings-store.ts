import { create } from 'zustand';
import {
  STORAGE_KEYS,
  AGENT_DEFAULTS,
  type ExplainDepth,
} from '@/lib/constants';
import { normalizeExplainDepth } from '@/lib/ai/response-depth';

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
  vars: Record<string, string>;
}

interface SettingsStoreState extends AgentSettings {
  initSettings: () => void;
  setSettings: (patch: Partial<Omit<AgentSettings, 'vars'>>) => void;
}

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
