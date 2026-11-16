'use client';
import * as m from '@/paraglide/messages';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Key, 
  Sparkles, 
  Eye, 
  EyeOff, 
  Check, 
  ChevronDown, 
  Activity, 
  CheckCircle2, 
  AlertCircle,
  Plus,
  X
} from 'lucide-react';
import { AI_PROVIDER_PRESETS } from '@/lib/constants';
import { useSafeSession } from '@/lib/useSafeSession';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { useModalStore } from '@/lib/stores/modal-store';

import { useOnboardingProviderForm } from './onboarding/hooks/useOnboardingProviderForm';
import { useOnboardingConnectionTester } from './onboarding/hooks/useOnboardingConnectionTester';

interface OnboardingWizardModalProps {
  onDismiss?: () => void;
}

export default function OnboardingWizardModal({ onDismiss }: OnboardingWizardModalProps) {
  useLocale();
  const { data: session } = useSafeSession();
  const userId = session?.user?.id;
  const isOpen = useModalStore((s) => s.apiKeyModalOpen);

  const [mounted, setMounted] = useState(false);

  // 1. Provider Form Hook
  const {
    dynamicProviders,
    modalOptions,
    saving,
    apiKey,
    showApiKey,
    setShowApiKey,
    provider,
    baseUrl,
    setBaseUrl,
    apiFormat,
    model,
    setModel,
    modelList,
    showAdvancedUrl,
    setShowAdvancedUrl,
    isAddingModel,
    setIsAddingModel,
    newModelName,
    setNewModelName,
    handleAddCustomModel,
    handleRemoveModel,
    handleProviderSelect,
    handleApiKeyChange,
    handleFinish,
    handleDismiss,
  } = useOnboardingProviderForm({
    userId,
    isOpen,
    onDismiss,
  });

  // 2. Connection Tester Hook
  const { isTesting, testResult, handleTestConnection } =
    useOnboardingConnectionTester({
      provider,
      baseUrl,
      apiKey,
      apiFormat,
      model,
    });

  const contextSubtitle = modalOptions?.contextSubtitle || modalOptions?.contextText || null;

  useEffect(() => {
    setMounted(true);
  }, []);

  const combinedProviders = [
    ...dynamicProviders.map((p) => ({
      id: p.providerKey,
      name: p.name,
      badgeLabel: p.badgeLabel,
    })),
    ...Object.entries(AI_PROVIDER_PRESETS)
      .filter(([key]) => !dynamicProviders.some((dp) => dp.providerKey === key))
      .map(([key, preset]) => ({
        id: preset.id,
        name: preset.name,
        badgeLabel: preset.badgeLabel,
      })),
  ];

  const hasKey = apiKey.trim().length > 0;

  if (!mounted) return null;

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={handleDismiss}
      size="sm"
      showHeader={false}
      bodyClassName="flex flex-col"
    >
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-theme-border/40 bg-theme-bg/60 shrink-0 select-none w-full text-left gap-4">
        <div className="flex items-center gap-2.5">
          <span className="flex items-center justify-center w-7 h-7 rounded-xl bg-theme-primary/10 text-theme-primary shrink-0">
            <Key className="w-4 h-4" />
          </span>
          <div>
            <h2 className="text-sm font-semibold text-theme-foreground font-sans leading-tight">
              {m.chat_configure_apikey()}
            </h2>
            <p className="text-xs text-theme-muted font-sans mt-0.5 leading-snug">
              {contextSubtitle || m.onboarding_subtitle_default()}
            </p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          aria-label={m.common_close()}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Body */}
      <div className="p-5 space-y-4">
        {/* Provider Quick Selector Pills */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-theme-muted">
            <span className="font-medium">{m.onboarding_provider()}</span>
            <button
              type="button"
              onClick={() => setShowAdvancedUrl(!showAdvancedUrl)}
              className="text-micro text-theme-muted hover:text-theme-foreground flex items-center gap-0.5 cursor-pointer transition-colors"
            >
              <span>Base URL</span>
              <ChevronDown className={`w-3 h-3 transition-transform ${showAdvancedUrl ? 'rotate-180' : ''}`} />
            </button>
          </div>
          <div className="flex flex-wrap gap-1.5">
            {combinedProviders.map((item) => {
              const isSelected = provider === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => handleProviderSelect(item.id)}
                  className={`px-2.5 py-1.5 rounded-lg text-xs font-medium transition-all border flex items-center gap-1 cursor-pointer hover:scale-[1.02] active:scale-[0.98] ${
                    isSelected
                      ? 'bg-theme-foreground text-theme-bg border-theme-foreground font-semibold shadow-xs'
                      : 'bg-theme-surface border-theme-border text-theme-muted hover:text-theme-foreground hover:border-theme-border/80'
                  }`}
                >
                  <span>{item.name}</span>
                  {isSelected && <Check className="w-3 h-3" />}
                </button>
              );
            })}
          </div>
        </div>

        {/* Base URL collapsible input */}
        {showAdvancedUrl && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
          >
            <input
              type="text"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="Base URL (https://...)"
              className="w-full px-3 py-1.5 bg-theme-surface border border-theme-border rounded-lg text-xs text-theme-foreground font-mono focus:outline-none focus:border-theme-primary"
            />
          </motion.div>
        )}

        {/* Hero API Key Input */}
        <div>
          <div className="relative">
            <input
              type="text"
              value={apiKey}
              autoFocus
              onChange={(e) => handleApiKeyChange(e.target.value)}
              placeholder={m.onboarding_api_key_placeholder()}
              style={{ WebkitTextSecurity: showApiKey ? 'none' : 'disc' } as React.CSSProperties}
              className="w-full pl-3.5 pr-10 py-3 bg-theme-surface border border-theme-border rounded-xl text-xs text-theme-foreground font-mono focus:outline-none focus:border-theme-primary transition-all shadow-2xs placeholder:text-theme-muted/60"
            />
            <button
              type="button"
              onClick={() => setShowApiKey(!showApiKey)}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
            >
              {showApiKey ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
            </button>
          </div>
        </div>

        {/* Smooth Expansion: Models & Testing when Key is typed */}
        <AnimatePresence>
          {hasKey && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="space-y-4 overflow-hidden pt-1"
            >
              {/* Model Section */}
              <div>
                <div className="flex items-center justify-between text-xs text-theme-muted mb-1.5 font-medium">
                  <span>{m.onboarding_model()}</span>
                  {!isAddingModel && (
                    <button
                      type="button"
                      onClick={() => setIsAddingModel(true)}
                      className="text-micro text-theme-muted hover:text-theme-foreground flex items-center gap-0.5 cursor-pointer font-medium transition-colors"
                    >
                      <Plus className="w-3 h-3" />
                      <span>{m.provider_card_add_custom_model()}</span>
                    </button>
                  )}
                </div>

                {modelList.length > 0 ? (
                  <div className="flex flex-wrap gap-1.5">
                    {modelList.map((mName) => (
                      <div
                        key={mName}
                        onClick={() => setModel(mName)}
                        className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-mono transition-all border cursor-pointer select-none hover:scale-[1.02] active:scale-[0.98] ${
                          model === mName
                            ? 'bg-theme-primary/10 text-theme-primary border-theme-primary font-semibold shadow-2xs'
                            : 'bg-theme-surface border-theme-border text-theme-muted hover:text-theme-foreground hover:border-theme-border/80'
                        }`}
                      >
                        <span>{mName}</span>
                        {model === mName && <Check className="w-3 h-3 text-theme-primary" />}
                        {modelList.length > 1 && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleRemoveModel(mName);
                            }}
                            className="opacity-0 group-hover:opacity-100 text-theme-muted hover:text-rose-500 transition-opacity ml-0.5 cursor-pointer"
                            title={m.provider_card_remove_from_list()}
                          >
                            <X className="w-2.5 h-2.5" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={model}
                      onChange={(e) => {
                        const val = e.target.value;
                        setModel(val);
                        if (val.trim()) {
                          handleAddCustomModel(val.trim());
                        }
                      }}
                      placeholder={m.provider_form_model_id_placeholder()}
                      className="w-full px-3 py-1.5 bg-theme-surface border border-theme-border rounded-lg text-xs font-mono text-theme-foreground focus:outline-none focus:border-theme-primary transition-all"
                    />
                  </div>
                )}

                {/* Inline Add Model Input Form */}
                {isAddingModel && (
                  <div className="flex items-center gap-1.5 pt-2">
                    <input
                      type="text"
                      value={newModelName}
                      autoFocus
                      onChange={(e) => setNewModelName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleAddCustomModel();
                        } else if (e.key === 'Escape') {
                          setIsAddingModel(false);
                        }
                      }}
                      placeholder={m.provider_form_model_id_placeholder()}
                      className="flex-1 px-2.5 py-1.5 bg-theme-surface border border-theme-border rounded-lg text-xs font-mono text-theme-foreground focus:outline-none focus:border-theme-primary transition-all"
                    />
                    <button
                      type="button"
                      onClick={() => handleAddCustomModel()}
                      disabled={!newModelName.trim()}
                      className="px-3 py-1.5 bg-theme-foreground text-theme-bg rounded-lg text-micro font-semibold cursor-pointer disabled:opacity-40 transition-all"
                    >
                      {m.provider_form_add()}
                    </button>
                    <button
                      type="button"
                      onClick={() => setIsAddingModel(false)}
                      className="px-2.5 py-1.5 text-theme-muted hover:text-theme-foreground text-micro cursor-pointer transition-colors"
                    >
                      {m.common_cancel()}
                    </button>
                  </div>
                )}
              </div>

              {/* Test Connection Button & Result */}
              <div className="flex items-center justify-between pt-1">
                <button
                  type="button"
                  disabled={isTesting}
                  onClick={handleTestConnection}
                  className="px-3 py-1.5 rounded-lg border border-theme-border bg-theme-surface hover:bg-theme-surface/80 text-theme-foreground text-xs font-medium flex items-center gap-1.5 transition-all disabled:opacity-50 cursor-pointer"
                >
                  <Activity className={`w-3 h-3 text-theme-primary ${isTesting ? 'animate-spin' : ''}`} />
                  <span>{isTesting ? m.onboarding_testing() : m.onboarding_test_connection()}</span>
                </button>

                {testResult && (
                  <div className={`flex items-center gap-1 text-xs font-medium ${testResult.success ? 'text-emerald-500' : 'text-rose-500'}`}>
                    {testResult.success ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertCircle className="w-3.5 h-3.5" />}
                    <span>{testResult.message}</span>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Footer */}
      <div className="px-5 py-3.5 border-t border-theme-border/60 bg-theme-surface/30 flex items-center justify-between">
        <button
          type="button"
          onClick={handleDismiss}
          className="text-xs text-theme-muted hover:text-theme-foreground transition-colors px-2.5 py-1.5 rounded-lg cursor-pointer"
        >
          {m.onboarding_skip()}
        </button>

        <button
          type="button"
          disabled={saving || !hasKey}
          onClick={handleFinish}
          className="px-4 py-2 rounded-xl bg-theme-foreground text-theme-bg font-semibold text-xs flex items-center gap-1.5 transition-all hover:opacity-90 shadow-md cursor-pointer disabled:opacity-40"
        >
          <Sparkles className="w-3.5 h-3.5" />
          <span>{saving ? m.onboarding_saving() : m.onboarding_save_and_start()}</span>
        </button>
      </div>
    </AnimatedModal>
  );
}
