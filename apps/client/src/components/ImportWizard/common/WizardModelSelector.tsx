'use client';

import React, { useEffect, useMemo } from 'react';
import { useSession } from 'next-auth/react';
import {
  AlertTriangle,
  Settings,
  ChevronDown,
  ExternalLink,
} from 'lucide-react';
import { useModelProviderStore } from '@/lib/stores/model-provider-store';
import { useModalStore } from '@/lib/stores/modal-store';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
  SelectGroup,
  SelectSeparator,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import type { UserModelProviderDTO } from '@/types/user-model-provider';

/**
 * 供应商视觉规范：仅保留前置品牌圆点颜色，保持整体克制中性
 */
export interface ProviderBrand {
  name: string;
  shortName: string;
  dotClass: string;
}

export function getProviderBrand(providerKey: string, fallbackName?: string): ProviderBrand {
  switch (providerKey) {
    case 'zhipu':
      return {
        name: m.provider_zhipu(),
        shortName: m.provider_zhipu_short(),
        dotClass: 'bg-purple-500',
      };
    case 'dashscope':
      return {
        name: m.provider_dashscope(),
        shortName: m.provider_dashscope_short(),
        dotClass: 'bg-amber-500',
      };
    case 'deepseek':
      return {
        name: 'DeepSeek',
        shortName: 'DeepSeek',
        dotClass: 'bg-blue-500',
      };
    case 'google':
      return {
        name: 'Google Gemini',
        shortName: 'Gemini',
        dotClass: 'bg-rose-500',
      };
    case 'openai':
      return {
        name: 'OpenAI',
        shortName: 'OpenAI',
        dotClass: 'bg-emerald-500',
      };
    case 'anthropic':
      return {
        name: 'Anthropic',
        shortName: 'Claude',
        dotClass: 'bg-orange-500',
      };
    default:
      return {
        name: fallbackName || providerKey,
        shortName: fallbackName?.slice(0, 4) || providerKey.slice(0, 4),
        dotClass: 'bg-theme-muted',
      };
  }
}

/**
 * 模型系列识别（仅用于如百炼等多系列聚合厂商的逻辑分类划分）
 */
export interface ModelSeriesInfo {
  id: string;
  name: string;
}

export function detectModelSeries(modelName: string): ModelSeriesInfo {
  const lower = modelName.toLowerCase();
  if (lower.startsWith('deepseek') || lower.includes('deepseek')) {
    return {
      id: 'deepseek',
      name: m.model_series_deepseek(),
    };
  }
  if (lower.startsWith('qwen') || lower.includes('qwen')) {
    return {
      id: 'qwen',
      name: m.model_series_qwen(),
    };
  }
  if (lower.startsWith('glm') || lower.includes('glm')) {
    return {
      id: 'glm',
      name: m.model_series_glm(),
    };
  }
  if (lower.startsWith('gemini') || lower.includes('gemini')) {
    return {
      id: 'gemini',
      name: m.model_series_gemini(),
    };
  }
  if (
    lower.startsWith('claude') ||
    lower.includes('claude') ||
    lower.includes('sonnet') ||
    lower.includes('opus') ||
    lower.includes('haiku')
  ) {
    return {
      id: 'claude',
      name: m.model_series_claude(),
    };
  }
  if (lower.startsWith('gpt') || lower.startsWith('o1') || lower.startsWith('o3') || lower.startsWith('o4')) {
    return {
      id: 'openai',
      name: m.model_series_openai(),
    };
  }
  return {
    id: 'default',
    name: m.model_series_general(),
  };
}

/**
 * 厂商内部模型子分类划分（若包含跨系列如 DashScope 下的 Qwen 与 DeepSeek 则细分分组）
 */
export interface SubGroup {
  seriesId: string;
  seriesName: string;
  showSubHeader: boolean;
  models: string[];
}

export function groupProviderModels(models: string[]): SubGroup[] {
  const seriesMap = new Map<string, { info: ModelSeriesInfo; models: string[] }>();

  models.forEach((mItem) => {
    const s = detectModelSeries(mItem);
    if (!seriesMap.has(s.id)) {
      seriesMap.set(s.id, { info: s, models: [] });
    }
    seriesMap.get(s.id)!.models.push(mItem);
  });

  const distinctSeries = Array.from(seriesMap.values());
  const hasMultiple = distinctSeries.length > 1;

  return distinctSeries.map(({ info, models: groupModels }) => ({
    seriesId: info.id,
    seriesName: info.name,
    showSubHeader: hasMultiple,
    models: groupModels,
  }));
}

export function useActiveWizardModel() {
  const { data: session } = useSession();
  const userId = session?.user?.id;

  const userProviders = useModelProviderStore((s) => s.userProviders);
  const isInitialized = useModelProviderStore((s) => s.isInitialized);
  const loadedUserId = useModelProviderStore((s) => s.loadedUserId);
  const loadProviders = useModelProviderStore((s) => s.loadProviders);

  useEffect(() => {
    if (!isInitialized || (userId && loadedUserId !== userId)) {
      void loadProviders(userId);
    }
  }, [isInitialized, loadedUserId, loadProviders, userId]);

  const configuredProviders = userProviders.filter(
    (p) => Boolean(p.hasApiKey || p.apiKey) && p.models.length > 0
  );
  const activeProvider =
    configuredProviders.find((p) => p.isActive) || configuredProviders[0];
  const activeModel =
    activeProvider?.selectedModel || activeProvider?.models[0] || '';

  return {
    activeProvider,
    activeModel,
    configuredProviders,
    isConfigured: configuredProviders.length > 0,
    isInitialized,
    userId,
  };
}

export interface WizardModelBadgeProps {
  variant?: 'inline' | 'badge' | 'pill';
  className?: string;
  showIcon?: boolean;
  prefixDot?: boolean;
}

export function WizardModelBadge({
  variant = 'badge',
  className,
  prefixDot = false,
}: WizardModelBadgeProps) {
  const { activeProvider, activeModel, isConfigured } = useActiveWizardModel();

  if (!isConfigured || !activeModel) {
    return null;
  }

  const brand = getProviderBrand(activeProvider?.providerKey || '', activeProvider?.name);

  if (variant === 'inline') {
    return (
      <>
        {prefixDot && (
          <span className="text-theme-border text-compact select-none">·</span>
        )}
        <span
          className={cn(
            'inline-flex items-center gap-1.5 font-mono text-caption text-theme-muted select-none',
            className
          )}
          title={m.import_model_preference()}
        >
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', brand.dotClass)} />
          <span className="truncate max-w-44 text-theme-foreground/90 font-medium">{activeModel}</span>
        </span>
      </>
    );
  }

  if (variant === 'pill') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-theme-surface/60 border border-theme-border/40 text-theme-muted text-xs cursor-default select-none',
          className
        )}
        title={m.import_model_preference()}
      >
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', brand.dotClass)} />
        <span className="text-theme-muted font-sans font-medium">{brand.shortName}</span>
        <span className="text-theme-border text-compact select-none">·</span>
        <span className="font-mono text-theme-foreground font-medium">{activeModel}</span>
      </span>
    );
  }

  // default: 'badge' (static grey capsule pill)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full bg-theme-surface border border-theme-border/60 text-caption font-sans text-theme-muted shrink-0 shadow-2xs select-none',
        className
      )}
      title={m.import_model_preference()}
    >
      <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', brand.dotClass)} />
      <span className="truncate max-w-44 text-theme-foreground/90 font-mono font-medium">{activeModel}</span>
    </span>
  );
}

/**
 * 统一的下拉弹层视图：仅保留服务商前置彩色圆点，其余保持克制中性
 */
function WizardModelSelectContent({
  configuredProviders,
  align = 'end',
}: {
  configuredProviders: UserModelProviderDTO[];
  align?: 'start' | 'end';
}) {
  return (
    <SelectContent
      alignItemWithTrigger={false}
      side="bottom"
      align={align}
      sideOffset={6}
      className="max-h-80 overflow-y-auto space-y-1 font-sans text-xs outline-none p-1"
      containerClassName="min-w-[280px] max-w-[360px] rounded-xl border border-theme-border/80 bg-theme-bg/95 backdrop-blur-md shadow-xl p-1 z-[150]"
    >
      {configuredProviders.map((provider, pIdx) => {
        const brand = getProviderBrand(provider.providerKey, provider.name);
        const subGroups = groupProviderModels(provider.models);
        const hasMultipleSubGroups = subGroups.length > 1;

        return (
          <React.Fragment key={provider.providerKey}>
            {pIdx > 0 && <SelectSeparator className="my-1.5 bg-theme-border/40" />}

            <SelectGroup className="space-y-0.5">
              {/* 厂商标题栏：仅保留彩色圆点，其余中性 */}
              <div className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-theme-surface/50 border border-theme-border/30 select-none mb-1">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className={cn('w-2 h-2 rounded-full shrink-0', brand.dotClass)} />
                  <span className="font-sans text-xs font-semibold text-theme-foreground truncate">
                    {provider.name}
                  </span>
                </div>
                <span className="text-micro font-mono text-theme-muted shrink-0">
                  {m.import_model_count({ count: provider.models.length })}
                </span>
              </div>

              {/* 系列子分组（若有跨系列则输出中性微细分割线） */}
              {subGroups.map((subGroup) => (
                <div key={subGroup.seriesId} className="space-y-0.5">
                  {hasMultipleSubGroups && (
                    <div className="px-2.5 pt-1.5 pb-0.5 flex items-center gap-2 select-none">
                      <span className="text-micro font-medium text-theme-muted font-sans shrink-0">
                        {subGroup.seriesName}
                      </span>
                      <div className="h-px flex-1 bg-theme-border/30" />
                    </div>
                  )}

                  {subGroup.models.map((model) => (
                    <SelectItem
                      key={`${provider.providerKey}:${model}`}
                      value={`${provider.providerKey}:${model}`}
                      className="rounded-lg text-xs font-sans cursor-pointer hover:bg-theme-surface data-highlighted:bg-theme-surface data-selected:bg-theme-surface/80 py-1.5 ps-2 pe-2.5 transition-colors"
                    >
                      <span className="font-mono text-xs text-theme-foreground/90 font-medium truncate">
                        {model}
                      </span>
                    </SelectItem>
                  ))}
                </div>
              ))}
            </SelectGroup>
          </React.Fragment>
        );
      })}

      {/* 底部快捷操作：管理 / 添加新模型 */}
      <SelectSeparator className="my-1.5 bg-theme-border/40" />
      <SelectItem
        value="__manage__"
        className="rounded-lg text-xs font-sans text-theme-muted hover:text-theme-foreground cursor-pointer hover:bg-theme-surface data-highlighted:bg-theme-surface py-2 px-2.5 transition-colors font-medium"
      >
        <div className="flex items-center justify-between w-full">
          <div className="flex items-center gap-2">
            <Settings size={13} className="shrink-0 text-theme-muted" />
            <span>{m.import_model_manage()}</span>
          </div>
          <ExternalLink size={12} className="text-theme-muted/60 shrink-0" />
        </div>
      </SelectItem>
    </SelectContent>
  );
}

interface WizardModelSelectorProps {
  variant?: 'card' | 'compact';
  className?: string;
  disabled?: boolean;
}

export function WizardModelSelector({
  variant = 'card',
  className,
  disabled = false,
}: WizardModelSelectorProps) {
  const {
    activeProvider,
    activeModel,
    configuredProviders,
    userId,
  } = useActiveWizardModel();

  const setActiveProvider = useModelProviderStore((s) => s.setActiveProvider);
  const setSelectedModel = useModelProviderStore((s) => s.setSelectedModel);
  const openPreferencesModal = useModalStore((s) => s.openPreferencesModal);

  const currentValue = useMemo(() => {
    return activeProvider && activeModel
      ? `${activeProvider.providerKey}:${activeModel}`
      : '';
  }, [activeProvider, activeModel]);

  const activeBrand = useMemo(() => {
    return getProviderBrand(activeProvider?.providerKey || '', activeProvider?.name);
  }, [activeProvider]);

  const handleValueChange = async (val: string | null) => {
    if (!val) return;
    if (val === '__manage__') {
      openPreferencesModal('llm');
      return;
    }

    const colonIdx = val.indexOf(':');
    if (colonIdx <= 0) return;

    const targetProviderKey = val.slice(0, colonIdx);
    const targetModel = val.slice(colonIdx + 1);

    if (activeProvider && targetProviderKey !== activeProvider.providerKey) {
      await setActiveProvider(targetProviderKey, userId);
    }
    await setSelectedModel(targetProviderKey, targetModel, userId);
  };

  // 1. 无已配置模型时的优雅降级（引导去设置）
  if (configuredProviders.length === 0) {
    if (variant === 'compact') {
      return (
        <button
          type="button"
          onClick={() => openPreferencesModal('llm')}
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-compact font-sans text-amber-600 dark:text-amber-400 shrink-0 shadow-2xs hover:bg-amber-500/20 transition-colors cursor-pointer',
            className
          )}
          title={m.import_model_unconfigured()}
        >
          <AlertTriangle size={11} className="shrink-0" />
          <span>{m.import_model_unconfigured()}</span>
        </button>
      );
    }

    return (
      <button
        type="button"
        onClick={() => openPreferencesModal('llm')}
        className={cn(
          'h-8 px-3 text-xs font-sans font-medium text-amber-600 dark:text-amber-400 bg-amber-500/10 border border-amber-500/30 hover:bg-amber-500/20 rounded-lg flex items-center gap-1.5 cursor-pointer outline-none transition-colors shadow-2xs',
          className
        )}
      >
        <AlertTriangle size={13} className="shrink-0" />
        <span>{m.import_model_unconfigured()}</span>
      </button>
    );
  }

  // 2. 紧凑型胶囊外观（用于向导 Header）
  if (variant === 'compact') {
    return (
      <Select
        value={currentValue}
        onValueChange={handleValueChange}
        disabled={disabled}
      >
        <SelectTrigger
          className={cn(
            'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-theme-surface border border-theme-border/60 text-caption font-sans text-theme-muted shrink-0 shadow-2xs hover:border-theme-border/90 hover:text-theme-foreground transition-all cursor-pointer outline-none',
            className
          )}
          icon={<ChevronDown className="w-3 h-3 text-theme-muted shrink-0 opacity-70" />}
        >
          <SelectValue>
            {() => (
              <div className="flex items-center gap-1.5 min-w-0">
                <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', activeBrand.dotClass)} />
                <span className="font-mono text-compact text-theme-foreground/90 font-medium truncate max-w-36">
                  {activeModel}
                </span>
              </div>
            )}
          </SelectValue>
        </SelectTrigger>

        <WizardModelSelectContent configuredProviders={configuredProviders} align="end" />
      </Select>
    );
  }

  // 3. 卡片行标准外观（用于 Step 1 输入框下方与目标语言并列）
  return (
    <Select
      value={currentValue}
      onValueChange={handleValueChange}
      disabled={disabled}
    >
      <SelectTrigger
        className={cn(
          'h-8 min-h-8 w-auto min-w-0 px-2.5 py-1 rounded-lg border border-theme-border/70 bg-theme-bg hover:bg-theme-surface hover:border-theme-primary/40 text-xs font-sans transition-all cursor-pointer shadow-2xs outline-none focus-visible:ring-1 focus-visible:ring-theme-primary/30 flex items-center gap-2',
          className
        )}
        icon={<ChevronDown className="w-3.5 h-3.5 text-theme-muted shrink-0 opacity-70" />}
      >
        <SelectValue>
          {() => (
            <div className="flex items-center gap-1.5 min-w-0 text-left">
              {/* 仅保留服务商前置彩色小圆点 */}
              <span className={cn('w-2 h-2 rounded-full shrink-0', activeBrand.dotClass)} />
              <span className="text-theme-muted text-xs font-sans font-medium">
                {activeBrand.shortName}
              </span>
              <span className="text-theme-border text-compact select-none">·</span>
              <span className="font-mono text-xs font-semibold text-theme-foreground truncate max-w-48">
                {activeModel}
              </span>
            </div>
          )}
        </SelectValue>
      </SelectTrigger>

      <WizardModelSelectContent configuredProviders={configuredProviders} align="end" />
    </Select>
  );
}
