'use client';
import * as m from '@/paraglide/messages';

import React, { useState, useEffect } from 'react';
import { useLocale } from '@/lib/i18n/LocaleContext';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import { Sparkles, X, Plus, Activity, ArrowLeft } from 'lucide-react';
import { useSafeSession } from '@/lib/useSafeSession';
import { ProviderCard } from '@/components/preferences/ProviderCard';
import { ProviderForm } from '@/components/preferences/ProviderForm';

import { useModalStore } from '@/lib/stores/modal-store';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { useProviderFormStore } from '@/lib/stores/provider-form-store';

import { useProviderFormManager } from './preferences/hooks/useProviderFormManager';
import { useProviderConnectionTester } from './preferences/hooks/useProviderConnectionTester';
import { useInlineModelManager } from './preferences/hooks/useInlineModelManager';

interface PreferencesModalProps {
  onSaved?: () => void;
}

export default function PreferencesModal({ onSaved }: PreferencesModalProps) {
  useLocale();
  const { data: session } = useSafeSession();
  const userId = session?.user?.id;

  const isOpen = useModalStore((s) => s.preferencesModalOpen);
  const closePreferencesModal = useModalStore((s) => s.closePreferencesModal);

  const userProviders = useModelProviderStore((s) => s.userProviders);
  const dynamicProviders = useModelProviderStore((s) => s.dynamicProviders);
  const loadProviders = useModelProviderStore((s) => s.loadProviders);

  const [mounted, setMounted] = useState(false);

  const formName = useProviderFormStore((s) => s.formName);
  const formApiKey = useProviderFormStore((s) => s.formApiKey);

  const {
    isFormOpen,
    setIsFormOpen,
    editingProviderKey,
    setEditingProviderKey,
    saving,
    handleOpenAddForm,
    handleEditProvider,
    handleDeleteProvider,
    handleSaveForm,
  } = useProviderFormManager({
    userId,
    onSaved,
  });

  const {
    testingKey,
    testResult,
    handleTestProvider,
    handleTestFormValues,
  } = useProviderConnectionTester(userProviders, editingProviderKey);

  const {
    openModelSelectorKey,
    setOpenModelSelectorKey,
    inlineAddingModelKey,
    setInlineAddingModelKey,
    inlineNewModelName,
    setInlineNewModelName,
    handleSetActiveProvider,
    handleSelectModelInProvider,
    handleAddInlineModel,
    handleRemoveInlineModel,
  } = useInlineModelManager(userId);

  useEffect(() => {
    setMounted(true);
    loadProviders(userId);
  }, [userId, loadProviders]);

  useEffect(() => {
    if (isOpen) {
      loadProviders(userId);
    }
  }, [isOpen, userId, loadProviders]);

  if (!mounted) return null;

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={closePreferencesModal}
      size="lg"
      showHeader={false}
      bodyClassName="flex flex-col max-h-[85vh]"
    >
      <div className="flex items-center justify-between px-6 py-3.5 border-b border-theme-border/40 bg-theme-bg/60 shrink-0 select-none w-full text-left gap-4">
        <div className="flex items-center gap-2.5">
          {isFormOpen && userProviders.length > 0 ? (
            <button
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                setEditingProviderKey(null);
              }}
              className="w-7 h-7 rounded-xl bg-theme-surface hover:bg-theme-surface/80 border border-theme-border flex items-center justify-center text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
              title={m.common_back()}
            >
              <ArrowLeft className="w-3.5 h-3.5" />
            </button>
          ) : (
            <span className="flex items-center justify-center w-7 h-7 rounded-xl bg-theme-primary/10 text-theme-primary">
              <Sparkles className="w-4 h-4" />
            </span>
          )}
          <div>
            <h2 className="text-sm font-semibold text-theme-foreground">
              {isFormOpen
                ? editingProviderKey
                  ? m.settings_llm_edit_title({ name: formName })
                  : m.settings_llm_add_title()
                : m.user_menu_api_keys()}
            </h2>
            <p className="text-micro text-theme-muted">
              {isFormOpen ? m.settings_llm_form_subtitle() : m.preferences_model_pool_subtitle()}
            </p>
          </div>
        </div>

        <button
          onClick={closePreferencesModal}
          aria-label={m.common_close()}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
        {isFormOpen ? (
          <ProviderForm
            editingProviderKey={editingProviderKey}
            dynamicProviders={dynamicProviders}
            hasExistingProviders={userProviders.length > 0}
          />
        ) : (
          <div className="space-y-3.5">
            <div className="space-y-3">
              {userProviders.map((p) => (
                <ProviderCard
                  key={p.providerKey}
                  provider={p}
                  isTesting={testingKey === p.providerKey}
                  testResult={testResult}
                  isModelSelectorOpen={openModelSelectorKey === p.providerKey}
                  inlineAddingModelKey={inlineAddingModelKey}
                  inlineNewModelName={inlineNewModelName}
                  onToggleModelSelector={() =>
                    setOpenModelSelectorKey(openModelSelectorKey === p.providerKey ? null : p.providerKey)
                  }
                  onSetActive={() => handleSetActiveProvider(p.providerKey)}
                  onTest={() => handleTestProvider(p)}
                  onEdit={() => handleEditProvider(p)}
                  onDelete={() => handleDeleteProvider(p.providerKey)}
                  onSelectModel={(m) => handleSelectModelInProvider(p.providerKey, m)}
                  onRemoveModel={(m) => handleRemoveInlineModel(p.providerKey, m)}
                  onSetInlineAddingModelKey={setInlineAddingModelKey}
                  onSetInlineNewModelName={setInlineNewModelName}
                  onAddInlineModel={() => handleAddInlineModel(p.providerKey)}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={handleOpenAddForm}
              className="w-full py-4 px-5 rounded-2xl border border-dashed border-theme-foreground/30 hover:border-theme-foreground/80 bg-theme-surface/20 hover:bg-theme-surface/60 transition-all flex items-center justify-center gap-3.5 group cursor-pointer shadow-2xs hover:shadow-xs"
            >
              <span className="w-8 h-8 rounded-xl border border-dashed border-theme-foreground/40 bg-theme-bg/60 flex items-center justify-center text-theme-foreground group-hover:scale-105 group-hover:border-theme-foreground group-hover:bg-theme-foreground group-hover:text-theme-bg transition-all shrink-0">
                <Plus className="w-3.5 h-3.5 transition-transform group-hover:rotate-90 duration-300" />
              </span>
              <div className="text-left">
                <div className="text-xs font-semibold text-theme-foreground tracking-tight">
                  {m.settings_llm_add_more()}
                </div>
                <div className="text-micro text-theme-muted mt-0.5">
                  {m.settings_llm_supported_providers()}
                </div>
              </div>
            </button>
          </div>
        )}
      </div>

      <div className="px-6 py-4 border-t border-theme-border/60 bg-theme-surface/30 flex items-center justify-between">
        {isFormOpen ? (
          <>
            <button
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                setEditingProviderKey(null);
              }}
              className="text-xs text-theme-muted hover:text-theme-foreground transition-colors px-2.5 py-1.5 rounded-lg cursor-pointer"
            >
              {m.common_cancel()}
            </button>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={testingKey === '__form__' || !formApiKey.trim()}
                onClick={handleTestFormValues}
                className="px-3.5 py-2 rounded-xl bg-theme-surface hover:bg-theme-surface/80 border border-theme-border text-theme-foreground font-semibold text-xs flex items-center gap-1.5 transition-all cursor-pointer disabled:opacity-40"
              >
                <Activity
                  className={`w-3.5 h-3.5 text-theme-primary ${
                    testingKey === '__form__' ? 'animate-spin' : ''
                  }`}
                />
                <span>{testingKey === '__form__' ? m.provider_test_testing() : m.provider_test_btn()}</span>
              </button>

              <button
                type="button"
                disabled={saving || !formApiKey.trim()}
                onClick={handleSaveForm}
                className="px-4 py-2 rounded-xl bg-theme-foreground text-theme-bg font-semibold text-xs flex items-center gap-1.5 transition-all hover:opacity-90 shadow-md cursor-pointer disabled:opacity-40"
              >
                <Sparkles className="w-3.5 h-3.5" />
                <span>{saving ? m.onboarding_saving() : m.common_save()}</span>
              </button>
            </div>
          </>
        ) : (
          <button
            type="button"
            onClick={closePreferencesModal}
            className="text-xs text-theme-muted hover:text-theme-foreground transition-colors px-2.5 py-1.5 rounded-lg cursor-pointer ml-auto"
          >
            {m.common_close()}
          </button>
        )}
      </div>
    </AnimatedModal>
  );
}
