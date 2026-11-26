'use client';

import React from 'react';
import { motion } from 'framer-motion';
import { Check, Plus, X, Eye, EyeOff } from 'lucide-react';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { GlobalModelProviderDTO } from '@/types/model-provider';
import { useProviderFormStore } from '@/lib/stores/provider-form-store';
import * as m from '@/paraglide/messages';

interface ProviderFormProps {
  editingProviderKey: string | null;
  dynamicProviders: GlobalModelProviderDTO[];
  hasExistingProviders: boolean;
}

export function ProviderForm({
  editingProviderKey,
  dynamicProviders,
  hasExistingProviders,
}: ProviderFormProps) {
  const formProviderKey = useProviderFormStore((s) => s.formProviderKey);
  const formName = useProviderFormStore((s) => s.formName);
  const formBaseUrl = useProviderFormStore((s) => s.formBaseUrl);
  const formApiKey = useProviderFormStore((s) => s.formApiKey);
  const formModels = useProviderFormStore((s) => s.formModels);
  const formSelectedModel = useProviderFormStore((s) => s.formSelectedModel);
  const formIsActive = useProviderFormStore((s) => s.formIsActive);
  const showApiKey = useProviderFormStore((s) => s.showApiKey);
  const isAddingFormModel = useProviderFormStore((s) => s.isAddingFormModel);
  const formNewModelName = useProviderFormStore((s) => s.formNewModelName);

  const patchDraft = useProviderFormStore((s) => s.patchDraft);
  const loadPreset = useProviderFormStore((s) => s.loadPreset);
  const addFormModel = useProviderFormStore((s) => s.addFormModel);

  const allPresetKeys = [
    ...dynamicProviders.map((dp) => dp.providerKey),
    ...Object.keys(AI_PROVIDER_PRESETS),
  ];
  const uniquePresetKeys = Array.from(new Set(allPresetKeys));

  return (
    <motion.div
      initial={{ opacity: 0, y: 15 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: 15 }}
      className="space-y-4"
    >
      {!editingProviderKey && (
        <div className="space-y-1.5">
          <label className="text-micro text-theme-muted font-medium">{m.provider_form_select_provider()}</label>
          <div className="flex flex-wrap gap-1.5">
            {uniquePresetKeys.map((k) => {
              const preset = AI_PROVIDER_PRESETS[k];
              const dynamic = dynamicProviders.find((p) => p.providerKey === k);
              const name = dynamic?.name || preset?.name || k;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => loadPreset({ providerKey: k })}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium transition-all border flex items-center gap-1.5 cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${
                    formProviderKey === k
                      ? 'bg-theme-foreground text-theme-bg border-theme-foreground font-semibold shadow-xs'
                      : 'bg-theme-surface border-theme-border text-theme-muted hover:text-theme-foreground'
                  }`}
                >
                  <span>{name}</span>
                  {formProviderKey === k && <Check className="w-3 h-3" />}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {formProviderKey === 'custom' && (
        <div className="space-y-1">
          <label className="text-xs text-theme-muted font-medium">{m.provider_form_custom_name_label()}</label>
          <input
            type="text"
            value={formName}
            onChange={(e) => patchDraft({ formName: e.target.value })}
            placeholder={m.provider_form_custom_name_placeholder()}
            className="w-full px-3 py-2 bg-theme-surface border border-theme-border rounded-xl text-xs text-theme-foreground focus:outline-none focus:border-theme-primary transition-all"
          />
        </div>
      )}

      <div className="space-y-1">
        <label className="text-xs text-theme-muted font-medium">2. API Key</label>
        <div className="relative">
          <input
            type="text"
            value={formApiKey}
            autoFocus
            onChange={(e) => patchDraft({ formApiKey: e.target.value })}
            placeholder={
              formProviderKey === 'custom'
                ? m.provider_form_api_key_custom_placeholder()
                : m.provider_form_api_key_placeholder({ name: formName })
            }
            style={{ WebkitTextSecurity: showApiKey ? 'none' : 'disc' } as React.CSSProperties}
            className="w-full pl-3.5 pr-10 py-2.5 bg-theme-surface border border-theme-border rounded-xl text-xs text-theme-foreground font-mono focus:outline-none focus:border-theme-primary transition-all shadow-2xs placeholder:text-theme-muted/60"
          />
          <button
            type="button"
            onClick={() => patchDraft({ showApiKey: !showApiKey })}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
          >
            {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
          </button>
        </div>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-theme-muted font-medium">{m.provider_form_base_url_label()}</label>
        <input
          type="text"
          value={formBaseUrl}
          onChange={(e) => patchDraft({ formBaseUrl: e.target.value })}
          placeholder="https://api.your-domain.com/v1"
          className="w-full px-3 py-2 bg-theme-surface border border-theme-border rounded-xl text-xs text-theme-foreground font-mono focus:outline-none focus:border-theme-primary transition-all placeholder:text-theme-muted/50"
        />
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between text-xs text-theme-muted font-medium">
          <span>{m.provider_form_default_model_label()}</span>
          {formModels.length > 0 && !isAddingFormModel && (
            <button
              type="button"
              onClick={() => patchDraft({ isAddingFormModel: true })}
              className="text-micro text-theme-muted hover:text-theme-foreground flex items-center gap-0.5 cursor-pointer"
            >
              <Plus className="w-3 h-3" />
              <span>{m.provider_form_add_more_models()}</span>
            </button>
          )}
        </div>

        {formModels.length > 0 ? (
          <div className="flex flex-wrap gap-1.5">
            {formModels.map((model) => (
              <div
                key={model}
                className={`group flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-mono transition-all border cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${
                  formSelectedModel === model
                    ? 'bg-theme-primary/10 text-theme-primary border-theme-primary font-semibold shadow-2xs'
                    : 'bg-theme-surface border-theme-border text-theme-muted hover:text-theme-foreground'
                }`}
                onClick={() => patchDraft({ formSelectedModel: model })}
              >
                <span>{model}</span>
                {formSelectedModel === model && <Check className="w-3 h-3 text-theme-primary" />}
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    const rem = formModels.filter((item) => item !== model);
                    patchDraft({
                      formModels: rem,
                      formSelectedModel:
                        formSelectedModel === model ? rem[0] || '' : formSelectedModel,
                    });
                  }}
                  className="opacity-0 group-hover:opacity-100 text-theme-muted hover:text-rose-500 transition-opacity ml-1"
                  title={m.provider_form_remove_model()}
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={formSelectedModel}
              onChange={(e) => {
                const value = e.target.value;
                patchDraft({
                  formSelectedModel: value,
                  formModels: value.trim() ? [value.trim()] : [],
                });
              }}
              placeholder={m.provider_form_model_id_placeholder()}
              className="w-full px-3 py-2 bg-theme-surface border border-theme-border rounded-xl text-xs text-theme-foreground font-mono focus:outline-none focus:border-theme-primary transition-all placeholder:text-theme-muted/50"
            />
          </div>
        )}

        {isAddingFormModel && formModels.length > 0 && (
          <div className="flex items-center gap-1.5 pt-1">
            <input
              type="text"
              value={formNewModelName}
              autoFocus
              onChange={(e) => patchDraft({ formNewModelName: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') addFormModel();
              }}
              placeholder={m.provider_form_model_id_placeholder()}
              className="flex-1 px-2.5 py-1.5 bg-theme-surface border border-theme-border rounded-lg text-xs font-mono focus:outline-none focus:border-theme-primary"
            />
            <button
              type="button"
              onClick={addFormModel}
              className="px-3 py-1.5 bg-theme-foreground text-theme-bg rounded-lg text-micro font-semibold cursor-pointer"
            >
              {m.provider_form_add()}
            </button>
            <button
              type="button"
              onClick={() => patchDraft({ isAddingFormModel: false })}
              className="px-2.5 py-1.5 text-theme-muted hover:text-theme-foreground text-micro cursor-pointer"
            >
              {m.common_cancel()}
            </button>
          </div>
        )}
      </div>

      <label className="flex items-center gap-2 pt-1 text-xs text-theme-foreground cursor-pointer select-none">
        <input
          type="checkbox"
          checked={formIsActive || !hasExistingProviders}
          disabled={!hasExistingProviders}
          onChange={(e) => patchDraft({ formIsActive: e.target.checked })}
          className="rounded border-theme-border text-theme-primary focus:ring-theme-primary/30"
        />
        <span className="font-medium">{m.provider_form_set_default_provider()}</span>
      </label>
    </motion.div>
  );
}
