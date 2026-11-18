'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { AnimatedModal } from '@/components/ui/AnimatedModal';
import * as m from '@/paraglide/messages';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { cn } from '@/lib/utils';
import {
  Copy,
  Check,
  KeyRound,
  BookOpen,
  Layers,
  Info,
  ChevronDown,
  Eye,
  EyeOff,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { McpConnectDialogProps } from './types';
import { McpTokensManager } from '@/components/settings/McpTokensManager';
import { api, ApiClientError } from '@/lib/api/client';

import {
  type ClientType,
  CLIENT_LABEL_MAP,
  SUPPORTED_CLIENT_TYPES,
  getClientConfigJson,
  getClientAiPrompt,
  maskToken,
} from './mcp-client-configs';

import { useClipboard } from '@/hooks/useClipboard';
import { getClientOrigin } from '@/lib/url-utils';

interface SavedRepoItem {
  id: string;
  owner: string;
  repo: string;
  mcpStatus?: string;
  totalDocs?: number;
  processedDocs?: number;
  isProcessed?: boolean;
  progress?: number;
}

interface ActiveMcpToken {
  id?: string | null;
  token: string;
  name: string;
  prefix?: string | null;
}

export function McpConnectWizardDialog({
  isOpen,
  onClose,
  owner,
  repo,
}: McpConnectDialogProps) {
  const [activeClient, setActiveClient] = useState<ClientType>('cursor');
  const [savedRepos, setSavedRepos] = useState<SavedRepoItem[]>([]);
  const [disabledMcpRepoIds, setDisabledMcpRepoIds] = useState<string[]>([]);
  const [isTokensExpanded, setIsTokensExpanded] = useState(false);
  const [activeToken, setActiveToken] = useState<ActiveMcpToken | null>(null);
  const [isLoadingToken, setIsLoadingToken] = useState(false);
  const [isCreatingToken, setIsCreatingToken] = useState(false);
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [createdJustNow, setCreatedJustNow] = useState(false);
  const [copyNeedsRetry, setCopyNeedsRetry] = useState(false);
  const [tokensRefreshTrigger, setTokensRefreshTrigger] = useState(0);
  const [showPlainToken, setShowPlainToken] = useState(false);

  const { copy, isCopied } = useClipboard({ showToast: false });
  const aiPromptCopied = isCopied('ai-prompt');

  const isGlobalHub = !owner || owner === 'bookshelf' || owner === 'global' || owner === 'hub';
  const origin = getClientOrigin();

  const fetchDefaultToken = useCallback(async () => {
    setIsLoadingToken(true);
    setTokenError(null);
    try {
      const res = await api.get<{
        id?: string | null;
        token?: string | null;
        name?: string | null;
        prefix?: string | null;
      }>('/api/mcp/tokens/default', {
        onUnauthorized: 'throw',
        skipDedup: true,
      });

      if (res?.token) {
        setActiveToken({
          id: res.id ?? null,
          token: res.token,
          name: res.name || 'Default',
          prefix: res.prefix ?? null,
        });
      } else {
        setActiveToken(null);
      }
    } catch (err) {
      setActiveToken(null);
      setTokenError(err instanceof Error && err.message ? err.message : m.mcp_token_load_error_hint());
    } finally {
      setIsLoadingToken(false);
    }
  }, []);

  useEffect(() => {
    if (!aiPromptCopied) {
      setCreatedJustNow(false);
    }
  }, [aiPromptCopied]);

  useEffect(() => {
    if (!isOpen) {
      setShowPlainToken(false);
      setTokenError(null);
      setCreatedJustNow(false);
      setCopyNeedsRetry(false);
      return;
    }

    api
      .get<{ savedRepositories?: SavedRepoItem[]; disabledMcpRepoIds?: string[] }>('/api/user/preferences', {
        onUnauthorized: 'throw',
      })
      .then((prefData) => {
        setSavedRepos(prefData?.savedRepositories ?? []);
        setDisabledMcpRepoIds(prefData?.disabledMcpRepoIds ?? []);
      })
      .catch((err) => {
        console.error('Failed to load MCP repo preferences:', err);
      });

    void fetchDefaultToken();
  }, [isOpen, fetchDefaultToken]);

  const endpointUrl = isGlobalHub
    ? `${origin}/api/mcp/hub`
    : `${origin}/api/mcp/${owner}/${repo}`;

  const handlePrimaryCopyAction = async () => {
    if (isLoadingToken || isCreatingToken) return;
    setTokenError(null);

    if (activeToken?.token) {
      const wasRetryAfterCreate = copyNeedsRetry;
      const copied = await copy(
        getClientAiPrompt(activeClient, endpointUrl, activeToken.token),
        'ai-prompt'
      );
      if (copied) {
        setCopyNeedsRetry(false);
        if (wasRetryAfterCreate) {
          setCreatedJustNow(true);
        }
      }
      return;
    }

    setIsCreatingToken(true);
    try {
      const res = await api.post<{
        id?: string | null;
        token?: string | null;
        name?: string | null;
        prefix?: string | null;
      }>('/api/mcp/tokens/default', undefined, {
        onUnauthorized: 'throw',
      });

      if (!res?.token) {
        throw new Error(m.mcp_token_load_error_hint());
      }

      const nextToken: ActiveMcpToken = {
        id: res.id ?? null,
        token: res.token,
        name: res.name || 'Default',
        prefix: res.prefix ?? null,
      };
      setActiveToken(nextToken);
      setTokensRefreshTrigger((prev) => prev + 1);

      const copied = await copy(
        getClientAiPrompt(activeClient, endpointUrl, nextToken.token),
        'ai-prompt'
      );
      if (copied) {
        setCreatedJustNow(true);
        setCopyNeedsRetry(false);
      } else {
        setCreatedJustNow(false);
        setCopyNeedsRetry(true);
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'MAX_TOKENS_EXCEEDED') {
        setIsTokensExpanded(true);
      }
      setTokenError(err instanceof Error && err.message ? err.message : m.toast_action_failed());
    } finally {
      setIsCreatingToken(false);
    }
  };

  const handleToggleRepoMcp = async (repoId: string, enable: boolean) => {
    const newDisabled = enable
      ? disabledMcpRepoIds.filter((id) => id !== repoId)
      : [...disabledMcpRepoIds, repoId];

    setDisabledMcpRepoIds(newDisabled);

    try {
      await api.post('/api/user/preferences', { disabledMcpRepoIds: newDisabled });
    } catch (e) {
      console.error('Failed to save MCP repo preferences:', e);
    }
  };

  const defaultToken = activeToken?.token ?? null;
  const displayToken = defaultToken
    ? (showPlainToken ? defaultToken : maskToken(defaultToken))
    : undefined;
  const displaySnippet = getClientConfigJson(activeClient, endpointUrl, displayToken);

  const handlePreCopy = (e: React.ClipboardEvent<HTMLPreElement>) => {
    if (!defaultToken || showPlainToken) return;
    const selection = window.getSelection()?.toString();
    if (selection) {
      const masked = maskToken(defaultToken);
      if (selection.includes(masked)) {
        e.preventDefault();
        const unmaskedSelection = selection.replaceAll(masked, defaultToken);
        e.clipboardData.setData('text/plain', unmaskedSelection);
      }
    }
  };

  // 区分已开启连接项目数
  const connectedRepos = savedRepos.filter(
    (r) =>
      r.isProcessed &&
      !disabledMcpRepoIds.includes(r.id) &&
      !disabledMcpRepoIds.includes(`${r.owner}/${r.repo}`)
  );

  return (
    <AnimatedModal
      isOpen={isOpen}
      onClose={onClose}
      size="5xl"
      icon={<Layers className="w-4 h-4" />}
      title={isGlobalHub ? m.dialog_mcp_connect_title() : m.mcp_connect_repo_title({ repo })}
      subtitle={m.mcp_connect_desc()}
      bodyClassName="p-5 sm:p-6 space-y-4 max-h-[85vh]"
    >

        {/* 💡 CossUI Alert 规范提醒 */}
        <Alert
          variant="default"
          className="border border-theme-border/70 bg-theme-surface/50 px-4 py-2.5 rounded-xl flex items-center gap-2.5 text-sm text-theme-muted font-sans"
        >
          <Info className="w-4 h-4 text-theme-primary shrink-0" />
          <AlertDescription className="text-sm text-theme-muted font-sans leading-normal">
            {m.mcp_connect_banner_hint()}
          </AlertDescription>
        </Alert>

        {/* 宽屏左右双栏栅格 (左右两块双卡片完美绝对对齐) */}
        <div className="grid grid-cols-1 md:grid-cols-12 gap-5 items-stretch">
          {/* 左栏：客户端接入与配置卡片 (占 7 列) */}
          <div className="md:col-span-7 flex flex-col">
            <div className="p-4 rounded-xl border border-theme-border/60 bg-theme-surface/30 flex-1 flex flex-col justify-between space-y-3">
              {/* 客户端选择器 (高质感现代胶囊栏 - 固定高度/禁止折行/超长省略号) */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between text-sm text-theme-muted gap-2">
                  <span className="font-semibold text-theme-foreground">{m.mcp_client_config_heading()}</span>
                  {activeToken && (
                    <span
                      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-mono bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border border-emerald-500/20 truncate max-w-[220px]"
                      title={`${activeToken.name} (${maskToken(activeToken.token)})`}
                    >
                      <KeyRound className="w-3 h-3 shrink-0" />
                      <span className="truncate">{m.mcp_active_token_badge({ name: activeToken.name })}</span>
                    </span>
                  )}
                </div>
                <div className="flex items-center h-9 p-1 bg-theme-bg border border-theme-border/70 rounded-xl gap-1">
                  {SUPPORTED_CLIENT_TYPES.map((type) => {
                    const isActive = activeClient === type;
                    const label = CLIENT_LABEL_MAP[type];
                    return (
                      <button
                        key={type}
                        type="button"
                        onClick={() => setActiveClient(type)}
                        title={label}
                        className={cn(
                          'flex-1 h-7 min-w-0 px-1.5 sm:px-2 flex items-center justify-center text-xs sm:text-sm rounded-lg transition-all duration-150 cursor-pointer select-none font-medium text-center',
                          isActive
                            ? 'bg-theme-surface text-theme-foreground font-semibold shadow-xs border border-theme-border/80'
                            : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/50 border border-transparent'
                        )}
                      >
                        <span className="truncate whitespace-nowrap">{label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

                <div className="relative rounded-lg bg-theme-bg border border-theme-border/70 p-3 flex-1 min-h-[140px]">
                  <pre
                    onCopy={handlePreCopy}
                    className="text-xs font-mono text-theme-foreground/90 overflow-x-auto custom-scrollbar whitespace-pre leading-relaxed pr-8"
                  >
                    {displaySnippet}
                  </pre>
                  {defaultToken && (
                    <button
                      type="button"
                      onClick={() => setShowPlainToken((prev) => !prev)}
                      className="absolute top-2 right-2 p-1.5 rounded-md bg-theme-surface/80 hover:bg-theme-surface text-theme-muted hover:text-theme-foreground border border-theme-border/40 transition-all cursor-pointer shadow-2xs"
                      title={showPlainToken ? m.tokens_hide_plain() : m.common_view()}
                      aria-label={showPlainToken ? m.tokens_hide_plain() : m.common_view()}
                    >
                      {showPlainToken ? (
                        <EyeOff className="w-4 h-4" />
                      ) : (
                        <Eye className="w-4 h-4" />
                      )}
                    </button>
                  )}
                </div>

                {/* 底部快速配置行动条 */}
                <div className="space-y-1.5 pt-0.5">
                  <button
                    type="button"
                    disabled={isLoadingToken || isCreatingToken}
                    onClick={() => void handlePrimaryCopyAction()}
                    className={cn(
                      'w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-lg border text-sm font-medium transition-all cursor-pointer shadow-2xs disabled:opacity-60 disabled:cursor-not-allowed',
                      copyNeedsRetry
                        ? 'border-emerald-500/50 bg-emerald-500/15 hover:bg-emerald-500/20 text-emerald-600 dark:text-emerald-400'
                        : 'border-theme-primary/40 bg-theme-primary/10 hover:bg-theme-primary/20 text-theme-primary'
                    )}
                  >
                    {isCreatingToken ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>{m.mcp_creating_token_and_copying()}</span>
                      </>
                    ) : isLoadingToken ? (
                      <>
                        <RefreshCw className="w-4 h-4 animate-spin" />
                        <span>{m.common_loading()}</span>
                      </>
                    ) : aiPromptCopied ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-600" />
                        <span className="text-emerald-600">
                          {createdJustNow
                            ? m.mcp_token_created_and_copied()
                            : m.common_copied()}
                        </span>
                      </>
                    ) : copyNeedsRetry ? (
                      <>
                        <Copy className="w-4 h-4" />
                        <span>{m.mcp_token_ready_click_copy()}</span>
                      </>
                    ) : defaultToken ? (
                      <>
                        <Copy className="w-4 h-4" />
                        <span>{m.mcp_copy_config_with_token()}</span>
                      </>
                    ) : (
                      <>
                        <KeyRound className="w-4 h-4" />
                        <span>{m.mcp_create_token_and_copy()}</span>
                      </>
                    )}
                  </button>
                  <p className="text-xs text-theme-muted text-center flex items-center justify-center gap-1.5 pt-0.5">
                    {tokenError ? (
                      <>
                        <AlertTriangle className="w-3.5 h-3.5 text-theme-accent shrink-0" />
                        <span className="text-theme-accent">{tokenError}</span>
                      </>
                    ) : isLoadingToken ? (
                      <span>{m.common_loading()}</span>
                    ) : defaultToken ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>{m.mcp_token_included_hint()}</span>
                      </>
                    ) : (
                      <span>{m.mcp_no_token_auto_create_hint()}</span>
                    )}
                  </p>
                </div>
            </div>
          </div>

          {/* 右栏：我的项目 · 作用范围管理卡片 (占 5 列) */}
          <div className="md:col-span-5 flex flex-col">
            <div className="p-4 rounded-xl border border-theme-border/60 bg-theme-surface/30 flex-1 flex flex-col space-y-2.5">
              <div className="flex items-center justify-between text-sm border-b border-theme-border/40 pb-2">
                <div className="flex items-center gap-1.5 font-semibold text-theme-foreground">
                  <BookOpen className="w-4 h-4 text-theme-primary shrink-0" />
                  <span>{m.mcp_scope_heading()}</span>
                </div>
                <span
                  className={cn(
                    'text-xs font-mono px-2 py-0.5 rounded font-medium border transition-colors',
                    connectedRepos.length > 0
                      ? 'text-emerald-600 bg-emerald-500/10 border-emerald-500/20'
                      : 'text-theme-muted bg-theme-surface border-theme-border/40'
                  )}
                >
                  {m.mcp_connected_count_badge({ connected: connectedRepos.length, total: savedRepos.length })}
                </span>
              </div>

              {savedRepos.length > 0 ? (
                <div className="space-y-1 max-h-60 overflow-y-auto custom-scrollbar pr-1 flex-1">
                  {savedRepos.map((r) => {
                    const isConnected =
                      r.isProcessed &&
                      !disabledMcpRepoIds.includes(r.id) &&
                      !disabledMcpRepoIds.includes(`${r.owner}/${r.repo}`);
                    const isIncomplete = !r.isProcessed;
                    const progress = r.progress ?? 0;

                    return (
                      <div
                        key={r.id}
                        className="flex items-center justify-between px-2.5 py-2 rounded-lg hover:bg-theme-surface/60 transition-colors text-xs sm:text-sm"
                      >
                        <div className="flex items-center gap-2 min-w-0 pr-2">
                          {/* 状态圆点：已连接为绿色圆点，断开后为灰色圆点，未转录为黄色圆点 */}
                          {isConnected ? (
                            <span className="w-2 h-2 rounded-full bg-emerald-500 shrink-0" />
                          ) : isIncomplete ? (
                            <span className="w-2 h-2 rounded-full bg-amber-500 shrink-0" />
                          ) : (
                            <span className="w-2 h-2 rounded-full bg-theme-muted/50 shrink-0" />
                          )}

                          <span
                            className={cn(
                              'font-mono text-xs sm:text-sm truncate',
                              isConnected
                                ? 'font-medium text-theme-foreground'
                                : 'text-theme-muted'
                            )}
                            title={`${r.owner}/${r.repo}`}
                          >
                            {r.owner}/{r.repo}
                          </span>

                          {isIncomplete && (
                            <span className="text-xs font-mono px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-600 font-medium border border-amber-500/20 shrink-0">
                              {progress > 0 ? `${progress}%` : m.status_queued()}
                            </span>
                          )}
                        </div>

                        {isConnected ? (
                          <button
                            type="button"
                            onClick={() => handleToggleRepoMcp(r.id, false)}
                            className="text-xs px-2.5 py-1 rounded border border-theme-border/60 text-theme-muted hover:text-rose-600 hover:border-rose-500/40 hover:bg-rose-500/5 transition-all cursor-pointer shrink-0 font-medium"
                            title={m.mcp_action_disconnect()}
                          >{m.mcp_action_disconnect()}</button>
                        ) : isIncomplete ? (
                          <a
                            href={`/docs/${r.owner}/${r.repo}`}
                            target="_blank"
                            rel="noreferrer"
                            className="text-xs px-2.5 py-1 rounded border border-theme-border/40 text-theme-muted hover:text-theme-foreground transition-colors shrink-0 font-medium"
                          >{m.common_view()}</a>
                        ) : (
                          <button
                            type="button"
                            onClick={() => handleToggleRepoMcp(r.id, true)}
                            className="text-xs px-2.5 py-1 rounded border border-theme-primary/40 text-theme-primary hover:bg-theme-primary/10 transition-all cursor-pointer shrink-0 font-medium"
                            title={m.mcp_action_connect()}
                          >{m.mcp_action_connect()}</button>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="text-center py-8 space-y-1">
                  <p className="text-sm font-medium text-theme-foreground">{m.empty_no_data()}</p>
                  <p className="text-xs text-theme-muted leading-relaxed">
                    {m.mcp_empty_bookshelf_hint()}
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 4. 可展开的 MCP 访问令牌管理区域 */}
        {isTokensExpanded && (
          <div className="pt-3 border-t border-theme-border/40 space-y-3">
            <McpTokensManager
              isModal={true}
              refreshTrigger={tokensRefreshTrigger}
              onTokenCreated={(created) => {
                setActiveToken({
                  id: created.id ?? null,
                  token: created.plainToken,
                  name: created.name,
                  prefix: created.prefix,
                });
                setTokenError(null);
                setCopyNeedsRetry(false);
              }}
              onTokenRevoked={() => {
                setCreatedJustNow(false);
                setCopyNeedsRetry(false);
                void fetchDefaultToken();
              }}
            />
          </div>
        )}

        {/* 5. 底部快捷导航 */}
        <div className="pt-2 flex items-center justify-between border-t border-theme-border/40 gap-3">
          <button
            type="button"
            onClick={() => setIsTokensExpanded((prev) => !prev)}
            className={cn(
              "flex items-center gap-1.5 px-3 py-1.5 text-xs font-serif rounded-md border transition-all cursor-pointer",
              isTokensExpanded
                ? "bg-theme-surface border-theme-primary/60 text-theme-primary font-medium shadow-2xs"
                : "border-theme-border hover:border-theme-primary/60 text-theme-foreground hover:text-theme-primary"
            )}
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>{isTokensExpanded ? m.mcp_collapse_tokens() : m.mcp_manage_tokens()}</span>
            <ChevronDown className={cn("w-3.5 h-3.5 transition-transform duration-200", isTokensExpanded && "rotate-180")} />
          </button>

          <button
            type="button"
            onClick={onClose}
            className="flex items-center gap-1.5 px-4 py-1.5 text-xs font-serif rounded-md bg-theme-foreground text-theme-bg font-bold hover:opacity-90 transition-all cursor-pointer shadow-2xs"
          >
            <span>{m.common_close()}</span>
          </button>
        </div>
      </AnimatedModal>
  );
}

export default McpConnectWizardDialog;
