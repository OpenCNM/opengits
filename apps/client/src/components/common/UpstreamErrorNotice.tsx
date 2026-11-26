'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  Check,
  Copy,
  Settings,
  WifiOff,
} from 'lucide-react';
import * as m from '@/paraglide/messages';
import type { UpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import {
  WizardModelSelector,
  getProviderBrand,
} from '@/components/ImportWizard/common/WizardModelSelector';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { cn } from '@/lib/utils';

export type UpstreamErrorNoticeVariant = 'card' | 'banner' | 'inline';

export interface UpstreamErrorNoticeProps {
  error: UpstreamErrorPresentation;
  variant?: UpstreamErrorNoticeVariant;
  isOffline?: boolean;
  onRetry?: () => void;
  retryLabel?: string;
  onRestart?: () => void;
  restartLabel?: string;
  onOpenApiKeyModal?: () => void;
  onOpenPreferencesModal?: () => void;
  onModelSwitched?: () => void;
  extraInfo?: React.ReactNode;
  extraActions?: React.ReactNode;
  className?: string;
}

interface UpstreamDetailBoxProps {
  error: UpstreamErrorPresentation;
  compact: boolean;
  showCopy: boolean;
  copied: boolean;
  onCopy: () => void;
  statusBadgeParts: string[];
  className?: string;
}

function UpstreamDetailBox({
  error,
  compact,
  showCopy,
  copied,
  onCopy,
  statusBadgeParts,
  className,
}: UpstreamDetailBoxProps) {
  const brand = error.provider ? getProviderBrand(error.provider) : null;
  const hasProviderOrModel = Boolean(brand || error.provider || error.model);
  const hasDetail = Boolean(
    error.upstreamMessage || hasProviderOrModel || statusBadgeParts.length > 0
  );

  if (!hasDetail) {
    return null;
  }

  return (
    <div
      className={cn(
        'text-left border border-theme-border/80',
        compact
          ? 'rounded-lg bg-theme-bg/80 p-2.5 space-y-1.5'
          : 'w-full rounded-xl bg-theme-surface/50 p-3.5 space-y-2 shadow-2xs',
        className
      )}
    >
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
          {!compact && (
            <span className="text-micro font-semibold text-theme-muted uppercase tracking-wide">
              {m.upstream_err_detail_label()}
            </span>
          )}
          {hasProviderOrModel && (
            <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-theme-bg border border-theme-border/70 text-micro text-theme-foreground font-mono">
              {brand && (
                <span
                  className={cn('w-1.5 h-1.5 rounded-full shrink-0', brand.dotClass)}
                />
              )}
              <span>{brand ? brand.shortName : error.provider}</span>
              {error.model && (
                <>
                  {(brand || error.provider) && (
                    <span className="text-theme-border">·</span>
                  )}
                  <span className="break-all">{error.model}</span>
                </>
              )}
            </span>
          )}
          {statusBadgeParts.length > 0 && (
            <span className="px-2 py-0.5 rounded-md bg-theme-accent/10 border border-theme-accent/20 text-micro font-mono text-theme-accent">
              {statusBadgeParts.join(' · ')}
            </span>
          )}
        </div>

        {showCopy && (
          <button
            type="button"
            onClick={onCopy}
            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-micro text-theme-muted hover:text-theme-foreground hover:bg-theme-bg border border-transparent hover:border-theme-border/60 transition-colors cursor-pointer shrink-0"
          >
            {copied ? (
              <Check size={12} className="text-theme-primary" />
            ) : (
              <Copy size={12} />
            )}
            <span>{copied ? m.upstream_err_copied() : m.upstream_err_copy()}</span>
          </button>
        )}
      </div>

      {error.upstreamMessage && (
        <p className="text-xs text-theme-foreground/90 leading-relaxed break-words select-text font-sans">
          {error.upstreamMessage}
        </p>
      )}
    </div>
  );
}

interface UpstreamModelSwitcherRowProps {
  show: boolean;
  onModelSwitched?: () => void;
  centered?: boolean;
}

function UpstreamModelSwitcherRow({
  show,
  onModelSwitched,
  centered = false,
}: UpstreamModelSwitcherRowProps) {
  if (!show || !onModelSwitched) {
    return null;
  }

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        centered ? 'justify-center pt-0.5' : 'justify-start'
      )}
    >
      <span className="text-xs text-theme-muted font-serif">
        {m.upstream_err_switch_model()}:
      </span>
      <WizardModelSelector variant="card" onModelChanged={onModelSwitched} />
    </div>
  );
}

interface UpstreamActionsProps {
  error: UpstreamErrorPresentation;
  compact: boolean;
  align: 'center' | 'start' | 'end';
  onRetry?: () => void;
  retryLabel?: string;
  onRestart?: () => void;
  restartLabel?: string;
  onOpenApiKeyModal?: () => void;
  onOpenPreferencesModal?: () => void;
  extraActions?: React.ReactNode;
}

function UpstreamActions({
  error,
  compact,
  align,
  onRetry,
  retryLabel,
  onRestart,
  restartLabel,
  onOpenApiKeyModal,
  onOpenPreferencesModal,
  extraActions,
}: UpstreamActionsProps) {
  const isKeyMissingOrCorrupt =
    error.code === 'KEY_DECRYPT_FAILED' || error.code === 'MISSING_API_KEY';

  const keyConfigHandler = onOpenApiKeyModal ?? onOpenPreferencesModal;
  const preferencesHandler = onOpenPreferencesModal ?? onOpenApiKeyModal;

  const showKeyOnlyAction = isKeyMissingOrCorrupt && Boolean(keyConfigHandler);
  const showConfigButton =
    !isKeyMissingOrCorrupt && error.showConfigKey && Boolean(preferencesHandler);
  const showRetryButton = Boolean(onRetry) && !showKeyOnlyAction;

  if (!onRestart && !showKeyOnlyAction && !showConfigButton && !showRetryButton && !extraActions) {
    return null;
  }

  const sizePad = compact ? 'px-2.5 py-1 rounded-md' : 'px-3.5 py-1.5 rounded-lg';
  const primaryBtnClass = cn(
    'inline-flex items-center justify-center gap-1.5 text-xs font-medium bg-theme-primary text-theme-primary-fg hover:opacity-90 transition-all cursor-pointer font-serif shadow-2xs',
    sizePad
  );
  const secondaryBtnClass = cn(
    'inline-flex items-center justify-center gap-1.5 text-xs font-medium border border-theme-border text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer font-serif',
    sizePad
  );
  const mutedBtnClass = cn(
    'inline-flex items-center justify-center gap-1.5 text-xs border border-theme-border text-theme-muted hover:text-theme-foreground hover:bg-theme-surface transition-all cursor-pointer font-serif',
    sizePad
  );

  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-2',
        align === 'center' && 'justify-center pt-1 gap-2.5',
        align === 'end' && 'justify-end shrink-0',
        align === 'start' && 'justify-start'
      )}
    >
      {onRestart && (
        <button type="button" onClick={onRestart} className={mutedBtnClass}>
          <ArrowLeft size={13} />
          <span>{restartLabel ?? m.import_outline_restart()}</span>
        </button>
      )}

      {showKeyOnlyAction && keyConfigHandler && (
        <button type="button" onClick={keyConfigHandler} className={primaryBtnClass}>
          {m.toast_config_model_hint()}
        </button>
      )}

      {showConfigButton && preferencesHandler && (
        <button
          type="button"
          onClick={preferencesHandler}
          className={
            error.primaryAction === 'config_key' ? primaryBtnClass : secondaryBtnClass
          }
        >
          <Settings size={13} />
          <span>{m.upstream_err_config_key()}</span>
        </button>
      )}

      {showRetryButton && onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className={
            error.primaryAction === 'retry' || !showConfigButton
              ? primaryBtnClass
              : secondaryBtnClass
          }
        >
          {retryLabel ?? m.common_retry()}
        </button>
      )}

      {extraActions}
    </div>
  );
}

export function UpstreamErrorNotice({
  error,
  variant = 'card',
  isOffline = false,
  onRetry,
  retryLabel,
  onRestart,
  restartLabel,
  onOpenApiKeyModal,
  onOpenPreferencesModal,
  onModelSwitched,
  extraInfo,
  extraActions,
  className,
}: UpstreamErrorNoticeProps) {
  const [copied, setCopied] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
    };
  }, []);

  const statusBadgeParts = [
    error.upstreamStatus ? `HTTP ${error.upstreamStatus}` : undefined,
    error.upstreamCode ? error.upstreamCode : undefined,
  ].filter((part): part is string => Boolean(part));

  const showModelSwitcher = Boolean(!isOffline && error.showModelSwitcher && onModelSwitched);

  const handleCopy = async () => {
    const providerLabel =
      error.provider && error.model
        ? `[${error.provider}/${error.model}]`
        : error.provider || error.model
          ? `[${error.provider || error.model}]`
          : undefined;
    const textParts = [
      providerLabel,
      statusBadgeParts.length > 0 ? `(${statusBadgeParts.join(' · ')})` : undefined,
      error.upstreamMessage || error.description,
    ].filter(Boolean);
    try {
      await navigator.clipboard.writeText(textParts.join(' '));
      setCopied(true);
      if (copyTimerRef.current) {
        clearTimeout(copyTimerRef.current);
      }
      copyTimerRef.current = setTimeout(() => setCopied(false), 1800);
    } catch {
    }
  };

  const StatusIcon = isOffline ? WifiOff : AlertTriangle;

  if (variant === 'inline') {
    return (
      <Alert
        variant="error"
        className={cn(
          'rounded-xl border border-theme-border/80 border-l-2 bg-theme-surface px-3.5 py-3 text-xs font-sans shadow-2xs',
          className
        )}
      >
        <StatusIcon size={15} className="shrink-0 mt-0.5" />
        <AlertTitle className="text-xs font-semibold text-theme-accent leading-snug">
          {error.title}
        </AlertTitle>
        <AlertDescription className="space-y-2 text-xs text-theme-muted">
          <p className="leading-relaxed">{error.description}</p>

          <UpstreamDetailBox
            error={error}
            compact
            showCopy={false}
            copied={copied}
            onCopy={handleCopy}
            statusBadgeParts={statusBadgeParts}
          />

          {extraInfo && <div className="text-xs text-theme-muted">{extraInfo}</div>}

          <UpstreamModelSwitcherRow
            show={showModelSwitcher}
            onModelSwitched={onModelSwitched}
          />

          <UpstreamActions
            error={error}
            compact
            align="start"
            onRetry={onRetry}
            retryLabel={retryLabel}
            onRestart={onRestart}
            restartLabel={restartLabel}
            onOpenApiKeyModal={onOpenApiKeyModal}
            onOpenPreferencesModal={onOpenPreferencesModal}
            extraActions={extraActions}
          />
        </AlertDescription>
      </Alert>
    );
  }

  if (variant === 'banner') {
    return (
      <div
        role="alert"
        className={cn(
          'w-full rounded-xl border border-theme-accent/30 bg-theme-surface p-4 shadow-xs font-sans text-theme-foreground space-y-3 animate-in fade-in duration-200',
          className
        )}
      >
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <div className="inline-flex items-center justify-center w-9 h-9 rounded-xl bg-theme-accent/10 border border-theme-accent/25 text-theme-accent shrink-0">
              <StatusIcon size={18} />
            </div>
            <div className="min-w-0 space-y-0.5">
              <h4 className="text-sm font-semibold text-theme-foreground font-sans leading-snug">
                {error.title}
              </h4>
              <p className="text-xs text-theme-muted leading-relaxed">
                {error.description}
              </p>
            </div>
          </div>

          <UpstreamActions
            error={error}
            compact={false}
            align="end"
            onRetry={onRetry}
            retryLabel={retryLabel}
            onRestart={onRestart}
            restartLabel={restartLabel}
            onOpenApiKeyModal={onOpenApiKeyModal}
            onOpenPreferencesModal={onOpenPreferencesModal}
            extraActions={extraActions}
          />
        </div>

        <UpstreamDetailBox
          error={error}
          compact={false}
          showCopy
          copied={copied}
          onCopy={handleCopy}
          statusBadgeParts={statusBadgeParts}
        />

        {extraInfo && <div className="text-xs text-theme-muted">{extraInfo}</div>}

        <UpstreamModelSwitcherRow
          show={showModelSwitcher}
          onModelSwitched={onModelSwitched}
        />
      </div>
    );
  }

  return (
    <div
      role="alert"
      className={cn(
        'flex-1 min-h-0 flex flex-col items-center justify-center p-6 sm:p-8 bg-theme-bg border border-theme-border/80 rounded-xl shadow-2xs text-center space-y-5 animate-in fade-in duration-200 overflow-y-auto custom-scrollbar',
        className
      )}
    >
      <div className="p-3.5 rounded-full bg-theme-accent/10 border border-theme-accent/20 text-theme-accent">
        <StatusIcon size={26} />
      </div>

      <div className="space-y-1.5 max-w-lg">
        <h3 className="text-sm font-semibold text-theme-foreground font-sans">
          {error.title}
        </h3>
        <p className="text-xs text-theme-muted leading-relaxed">
          {error.description}
        </p>
      </div>

      <UpstreamDetailBox
        error={error}
        compact={false}
        showCopy
        copied={copied}
        onCopy={handleCopy}
        statusBadgeParts={statusBadgeParts}
        className="max-w-lg"
      />

      {extraInfo && (
        <div className="max-w-lg text-xs text-theme-muted">{extraInfo}</div>
      )}

      <UpstreamModelSwitcherRow
        show={showModelSwitcher}
        onModelSwitched={onModelSwitched}
        centered
      />

      <UpstreamActions
        error={error}
        compact={false}
        align="center"
        onRetry={onRetry}
        retryLabel={retryLabel}
        onRestart={onRestart}
        restartLabel={restartLabel}
        onOpenApiKeyModal={onOpenApiKeyModal}
        onOpenPreferencesModal={onOpenPreferencesModal}
        extraActions={extraActions}
      />
    </div>
  );
}
