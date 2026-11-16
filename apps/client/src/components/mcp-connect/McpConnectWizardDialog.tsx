'use client';

import React, { useState, useEffect } from 'react';
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
  Sparkles,
  ChevronDown,
  Eye,
  EyeOff,
} from 'lucide-react';
import { McpConnectDialogProps } from './types';
import { McpTokensManager } from '@/components/settings/McpTokensManager';
import { api } from '@/lib/api/client';

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
  const [defaultToken, setDefaultToken] = useState<string | null>(null);
  const [showPlainToken, setShowPlainToken] = useState(false);

  const { copy, isCopied } = useClipboard({ showToast: false });

  const isGlobalHub = !owner || owner === 'bookshelf' || owner === 'global' || owner === 'hub';
  const origin = getClientOrigin();

  useEffect(() => {
    if (isOpen) {
      api
        .get<{ savedRepositories?: SavedRepoItem[]; disabledMcpRepoIds?: string[] }>('/api/user/preferences', {
          onUnauthorized: 'throw',
        })
        .then((prefData) => {
          setSavedRepos(prefData?.savedRepositories ?? []);
          setDisabledMcpRepoIds(prefData?.disabledMcpRepoIds ?? []);
        })
        .catch(() => {});

      api
        .get<{ token?: string }>('/api/mcp/tokens/default', {
          onUnauthorized: 'throw',
        })
        .then((res) => {
          if (res?.token) {
            setDefaultToken(res.token);
          }
        })
        .catch(() => {});
    }
  }, [isOpen]);

  const endpointUrl = isGlobalHub
    ? `${origin}/api/mcp/hub`
    : `${origin}/api/mcp/${owner}/${repo}`;

  const handleCopy = (text: string, key: string) => {
    copy(text, key);
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

  const tokenValue = defaultToken || undefined;
  const rawSnippet = getClientConfigJson(activeClient, endpointUrl, tokenValue);
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
                <div className="flex items-center justify-between text-sm text-theme-muted">
                  <span className="font-semibold text-theme-foreground">{m.mcp_client_config_heading()}</span>
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
                    onClick={() => handleCopy(getClientAiPrompt(activeClient, endpointUrl, tokenValue), 'ai-prompt')}
                    className="w-full flex items-center justify-center gap-2 py-2 px-3.5 rounded-lg border border-theme-primary/40 bg-theme-primary/10 hover:bg-theme-primary/20 text-theme-primary text-sm font-medium transition-all cursor-pointer shadow-2xs"
                  >
                    {isCopied('ai-prompt') ? (
                      <>
                        <Check className="w-4 h-4 text-emerald-600" />
                        <span className="text-emerald-600">
                          {defaultToken
                            ? m.common_copied()
                            : m.common_copied()}
                        </span>
                      </>
                    ) : (
                      <>
                        <Copy className="w-4 h-4" />
                        <span>
                          {defaultToken
                            ? m.mcp_copy_config_with_token()
                            : m.mcp_copy_config()}
                        </span>
                      </>
                    )}
                  </button>
                  <p className="text-xs text-theme-muted text-center flex items-center justify-center gap-1.5 pt-0.5">
                    {defaultToken ? (
                      <>
                        <Check className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                        <span>{m.mcp_token_included_hint()}</span>
                      </>
                    ) : (
                      <span>{m.mcp_replace_token_hint()}</span>
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
            <McpTokensManager isModal={true} onTokenCreated={(t) => setDefaultToken(t)} />
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
