'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Check,
  Plus,
  X,
  Activity,
  Edit3,
  Trash2,
  ChevronDown,
  ArrowRight,
  Cpu,
  ShieldCheck,
  Globe,
} from 'lucide-react';
import { UserModelProviderDTO } from '@/types/user-model-provider';
import * as m from '@/paraglide/messages';

interface ProviderCardProps {
  provider: UserModelProviderDTO;
  isTesting: boolean;
  testResult: { key: string; success: boolean; message: string; latencyMs?: number } | null;
  isModelSelectorOpen: boolean;
  inlineAddingModelKey: string | null;
  inlineNewModelName: string;
  onToggleModelSelector: () => void;
  onSetActive: () => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onSelectModel: (model: string) => void;
  onRemoveModel: (model: string) => void;
  onSetInlineAddingModelKey: (key: string | null) => void;
  onSetInlineNewModelName: (name: string) => void;
  onAddInlineModel: () => void;
}

export function ProviderCard({
  provider: p,
  isTesting,
  testResult,
  isModelSelectorOpen,
  inlineAddingModelKey,
  inlineNewModelName,
  onToggleModelSelector,
  onSetActive,
  onTest,
  onEdit,
  onDelete,
  onSelectModel,
  onRemoveModel,
  onSetInlineAddingModelKey,
  onSetInlineNewModelName,
  onAddInlineModel,
}: ProviderCardProps) {
  const isActive = p.isActive;
  const hasTested = testResult && testResult.key === p.providerKey;

  return (
    <div
      className={`p-4.5 rounded-2xl border transition-all space-y-3 relative overflow-hidden ${
        isActive
          ? 'bg-theme-surface/70 border-theme-primary/40 shadow-xs ring-1 ring-theme-primary/20'
          : 'bg-theme-surface/30 border-theme-border/70 hover:border-theme-border'
      }`}
    >
      {/* Card Top: Provider Name, Active Status & Default Switch */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-theme-foreground">{p.name}</span>
          {isActive ? (
            <span className="flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-500 border border-emerald-500/20 text-micro font-semibold">
              <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
              <span>{m.provider_card_active_badge()}</span>
            </span>
          ) : (
            <button
              type="button"
              onClick={onSetActive}
              className="px-2.5 py-0.5 rounded-full bg-theme-surface hover:bg-theme-foreground hover:text-theme-bg text-theme-muted border border-theme-border text-micro font-medium transition-all flex items-center gap-1 cursor-pointer"
            >
              <span>{m.provider_card_set_default()}</span>
              <ArrowRight className="w-2.5 h-2.5" />
            </button>
          )}
        </div>

        {/* Card Top Right: Actions */}
        <div className="flex items-center gap-1">
          <button
            type="button"
            disabled={isTesting}
            onClick={onTest}
            title={m.provider_test_btn()}
            className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer disabled:opacity-50"
          >
            <Activity className={`w-3.5 h-3.5 text-theme-primary ${isTesting ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={onEdit}
            title={m.common_edit()}
            className="p-1.5 rounded-lg text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-colors cursor-pointer"
          >
            <Edit3 className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={onDelete}
            title={m.common_delete()}
            className="p-1.5 rounded-lg text-rose-400 hover:text-rose-500 hover:bg-rose-500/10 transition-colors cursor-pointer"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Model Selector Dropdown Trigger */}
      <div className="space-y-2 pt-1 border-t border-theme-border/30">
        <div className="flex items-center justify-between gap-2 p-2 rounded-xl bg-theme-surface/50 border border-theme-border/50">
          <div className="flex items-center gap-2">
            <Cpu className="w-3.5 h-3.5 text-theme-muted shrink-0" />
            <span className="text-micro text-theme-muted font-medium">{m.provider_card_current_model()}</span>
            <span className="font-mono text-xs font-semibold text-theme-primary bg-theme-primary/10 px-2 py-0.5 rounded-md border border-theme-primary/20">
              {p.selectedModel}
            </span>
          </div>

          <button
            type="button"
            onClick={onToggleModelSelector}
            className="px-2 py-1 rounded-lg text-micro font-medium text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all flex items-center gap-1 cursor-pointer"
          >
            <span>{isModelSelectorOpen ? m.provider_card_collapse_model_pool() : m.provider_card_switch_model()}</span>
            <ChevronDown className={`w-3 h-3 transition-transform ${isModelSelectorOpen ? 'rotate-180' : ''}`} />
          </button>
        </div>

        {/* Dropdown Panel for Models */}
        <AnimatePresence>
          {isModelSelectorOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: 'auto' }}
              exit={{ opacity: 0, height: 0 }}
              className="p-2.5 rounded-xl bg-theme-surface/80 border border-theme-border/60 space-y-2 overflow-hidden"
            >
              <div className="flex items-center justify-between text-micro text-theme-muted">
                <span>{m.provider_card_select_primary_hint()}</span>
                {inlineAddingModelKey !== p.providerKey && (
                  <button
                    type="button"
                    onClick={() => onSetInlineAddingModelKey(p.providerKey)}
                    className="text-theme-muted hover:text-theme-foreground flex items-center gap-0.5 cursor-pointer font-medium"
                  >
                    <Plus className="w-2.5 h-2.5" />
                    <span>{m.provider_card_add_custom_model()}</span>
                  </button>
                )}
              </div>

              {/* Models Chips Grid */}
              <div className="flex flex-wrap gap-1.5">
                {p.models.map((model) => {
                  const isSelected = p.selectedModel === model;
                  return (
                    <div
                      key={model}
                      onClick={() => onSelectModel(model)}
                      className={`group flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-micro font-mono border transition-all cursor-pointer select-none hover:scale-[1.02] active:scale-[0.98] ${
                        isSelected
                          ? 'bg-theme-primary/10 text-theme-primary border-theme-primary/40 font-bold shadow-2xs'
                          : 'bg-theme-surface border-theme-border text-theme-muted hover:text-theme-foreground'
                      }`}
                    >
                      <span>{model}</span>
                      {isSelected && <Check className="w-2.5 h-2.5 text-theme-primary" />}
                      {p.models.length > 1 && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onRemoveModel(model);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-theme-muted hover:text-rose-500 transition-opacity ml-0.5 cursor-pointer"
                          title={m.provider_card_remove_from_list()}
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>

              {/* Inline Add Model Input Form */}
              {inlineAddingModelKey === p.providerKey && (
                <div className="flex items-center gap-1.5 pt-1 border-t border-theme-border/30">
                  <input
                    type="text"
                    value={inlineNewModelName}
                    autoFocus
                    onChange={(e) => onSetInlineNewModelName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') onAddInlineModel();
                    }}
                    placeholder={m.provider_form_model_id_placeholder()}
                    className="flex-1 px-2 py-1 bg-theme-bg border border-theme-border rounded-lg text-micro font-mono focus:outline-none focus:border-theme-primary"
                  />
                  <button
                    type="button"
                    onClick={onAddInlineModel}
                    className="px-2.5 py-1 bg-theme-foreground text-theme-bg rounded-lg text-micro font-semibold cursor-pointer"
                  >
                    {m.provider_form_add()}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      onSetInlineAddingModelKey(null);
                      onSetInlineNewModelName('');
                    }}
                    className="px-2 py-1 text-theme-muted hover:text-theme-foreground text-micro cursor-pointer"
                  >
                    {m.common_cancel()}
                  </button>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Card Bottom: Base URL & Key Status */}
      <div className="flex flex-wrap items-center justify-between text-micro text-theme-muted pt-1 border-t border-theme-border/30 gap-2">
        <div className="flex items-center gap-1.5 min-w-0 max-w-[70%]">
          <Globe className="w-3 h-3 shrink-0" />
          <span className="truncate font-mono">{p.baseUrl}</span>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <ShieldCheck className="w-3 h-3 text-emerald-500" />
          <span>{p.apiKey ? (p.apiKey.startsWith('••••') ? m.provider_card_key_encrypted() : m.provider_card_key_configured()) : m.provider_card_key_missing()}</span>
        </div>
      </div>

      {/* Test Result Indicator */}
      {hasTested && (
        <div
          className={`px-3 py-1.5 rounded-xl text-micro font-medium flex items-center justify-between border animate-in fade-in duration-200 ${
            testResult.success
              ? 'bg-emerald-500/10 text-emerald-500 border-emerald-500/20'
              : 'bg-rose-500/10 text-rose-500 border-rose-500/20'
          }`}
        >
          <span>{testResult.message}</span>
          {testResult.latencyMs !== undefined && <span>{testResult.latencyMs}ms</span>}
        </div>
      )}
    </div>
  );
}
