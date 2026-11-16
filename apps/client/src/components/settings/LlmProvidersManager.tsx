'use client';

import React, { useState, useEffect } from 'react';
import { Sparkles, Plus, Activity, ArrowLeft } from 'lucide-react';
import { useSafeSession } from '@/lib/useSafeSession';
import { ProviderCard } from '@/components/preferences/ProviderCard';
import { ProviderForm } from '@/components/preferences/ProviderForm';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { useProviderFormStore } from '@/lib/stores/provider-form-store';
import { useProviderFormManager } from '@/components/preferences/hooks/useProviderFormManager';
import { useProviderConnectionTester } from '@/components/preferences/hooks/useProviderConnectionTester';
import { useInlineModelManager } from '@/components/preferences/hooks/useInlineModelManager';
import * as m from '@/paraglide/messages';

interface LlmProvidersManagerProps {
  isModal?: boolean;
  onSaved?: () => void;
  onCloseModal?: () => void;
}

export function LlmProvidersManager({
  isModal = false,
  onSaved,
  onCloseModal,
}: LlmProvidersManagerProps) {
  const { data: session } = useSafeSession();
  const userId = session?.user?.id;

  const userProviders = useModelProviderStore((s) => s.userProviders);
  const dynamicProviders = useModelProviderStore((s) => s.dynamicProviders);
  const loadProviders = useModelProviderStore((s) => s.loadProviders);

  const [mounted, setMounted] = useState(false);

  const formName = useProviderFormStore((s) => s.formName);
  const formApiKey = useProviderFormStore((s) => s.formApiKey);

  // 1. Provider Form Hook
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

  // 2. Connection Tester Hook
  const {
    testingKey,
    testResult,
    handleTestProvider,
    handleTestFormValues,
  } = useProviderConnectionTester(userProviders, editingProviderKey);

  // 3. Inline Model Manager Hook
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

  if (!mounted) return null;

  return (
    <div className="space-y-4 font-sans text-theme-foreground">
      {/* 仅在非弹窗页面下展示大标题 */}
      {!isModal && (
        <div className="border-b border-theme-border/40 pb-4">
          <h1 className="text-2xl font-bold text-theme-foreground tracking-tight flex items-center gap-2.5">
            <Sparkles size={22} className="text-theme-primary" />
            {m.user_menu_api_keys()}
          </h1>
          <p className="text-sm text-theme-muted mt-1.5 leading-relaxed">
            {m.settings_llm_description()}
          </p>
        </div>
      )}

      {isFormOpen ? (
        <div className="p-4 sm:p-5 rounded-xl border border-theme-border/60 bg-theme-surface/30 space-y-4">
          <div className="flex items-center justify-between border-b border-theme-border/40 pb-3">
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setIsFormOpen(false);
                  setEditingProviderKey(null);
                }}
                className="w-8 h-8 rounded-lg bg-theme-surface hover:bg-theme-surface/80 border border-theme-border flex items-center justify-center text-theme-muted hover:text-theme-foreground transition-colors cursor-pointer"
                title={m.common_cancel()}
              >
                <ArrowLeft size={16} />
              </button>
              <div>
                <h2 className="text-sm font-semibold text-theme-foreground">
                  {editingProviderKey ? m.settings_llm_edit_title({ name: formName }) : m.settings_llm_add_title()}
                </h2>
                <p className="text-xs text-theme-muted">
                  {m.settings_llm_form_subtitle()}
                </p>
              </div>
            </div>
          </div>

          <ProviderForm
            editingProviderKey={editingProviderKey}
            dynamicProviders={dynamicProviders}
            hasExistingProviders={userProviders.length > 0}
          />

          <div className="flex items-center justify-between pt-3 border-t border-theme-border/40">
            <button
              type="button"
              onClick={() => {
                setIsFormOpen(false);
                setEditingProviderKey(null);
              }}
              className="text-sm text-theme-muted hover:text-theme-foreground transition-colors px-3 py-1.5 rounded-lg cursor-pointer"
            >
              {m.common_cancel()}
            </button>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                disabled={testingKey === '__form__' || !formApiKey.trim()}
                onClick={handleTestFormValues}
                className="px-4 py-2 rounded-xl bg-theme-surface hover:bg-theme-surface/80 border border-theme-border text-theme-foreground font-medium text-sm flex items-center gap-2 transition-all cursor-pointer disabled:opacity-40"
              >
                <Activity
                  className={`w-4 h-4 text-theme-primary ${
                    testingKey === '__form__' ? 'animate-spin' : ''
                  }`}
                />
                <span>{testingKey === '__form__' ? m.provider_test_testing() : m.provider_test_btn()}</span>
              </button>
              <button
                type="button"
                disabled={saving || !formApiKey.trim()}
                onClick={handleSaveForm}
                className="px-4 py-2 rounded-xl bg-theme-primary text-theme-bg font-semibold text-sm flex items-center gap-2 transition-all hover:opacity-90 shadow-xs cursor-pointer disabled:opacity-40"
              >
                <Sparkles className="w-4 h-4" />
                <span>{saving ? m.onboarding_saving() : m.common_save()}</span>
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
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
                onSelectModel={(mod) => handleSelectModelInProvider(p.providerKey, mod)}
                onRemoveModel={(mod) => handleRemoveInlineModel(p.providerKey, mod)}
                onSetInlineAddingModelKey={setInlineAddingModelKey}
                onSetInlineNewModelName={setInlineNewModelName}
                onAddInlineModel={() => handleAddInlineModel(p.providerKey)}
              />
            ))}
          </div>

          <button
            type="button"
            onClick={handleOpenAddForm}
            className="w-full py-4 px-5 rounded-xl border border-dashed border-theme-border hover:border-theme-primary/60 bg-theme-surface/30 hover:bg-theme-surface/70 transition-all flex items-center justify-center gap-3 group cursor-pointer shadow-2xs"
          >
            <span className="w-8 h-8 rounded-lg border border-dashed border-theme-border bg-theme-bg flex items-center justify-center text-theme-foreground group-hover:border-theme-primary group-hover:text-theme-primary transition-all shrink-0">
              <Plus className="w-4 h-4 transition-transform group-hover:rotate-90 duration-300" />
            </span>
            <div className="text-left">
              <div className="text-sm font-semibold text-theme-foreground tracking-tight">
                {m.settings_llm_add_more()}
              </div>
              <div className="text-xs text-theme-muted mt-0.5">
                {m.settings_llm_supported_providers()}
              </div>
            </div>
          </button>
        </div>
      )}
    </div>
  );
}
