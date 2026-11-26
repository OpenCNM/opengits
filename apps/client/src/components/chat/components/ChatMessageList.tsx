'use client';

import React from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { History, X, ChevronRight, Sparkles } from 'lucide-react';
import { cn } from '@/lib/utils';
import * as m from '@/paraglide/messages';
import { parseExplainCodePayload } from '@/lib/code-viewport/explain-context';
import { extractStreamableAssistantText } from '@/lib/ai/unwrap-chat-response';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { UpstreamErrorNotice } from '@/components/common/UpstreamErrorNotice';
import type { ChatUIMessage } from '../hooks/useConversationHistory';

function getPromptSuggestions(): string[] {
  return [
    m.chat_prompt_summary(),
    m.chat_prompt_path(),
    m.chat_prompt_plain(),
  ];
}

const REMARK_PLUGINS = [remarkGfm];

interface ChatMessageListProps {
  messages: ChatUIMessage[];
  isLoading: boolean;
  error: Error | null | undefined;
  historyOpen: boolean;
  historyList: Array<{ id: string; title: string; updatedAt: string }>;
  historyLoading: boolean;
  chatScrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onCloseHistory: () => void;
  onLoadConversation: (id: string) => void;
  onDeleteConversation: (id: string, e: React.MouseEvent) => void;
  onRetry?: () => void;
  onModelSwitched?: () => void;
  onOpenApiKeyModal: () => void;
  onOpenPreferencesModal?: () => void;
  onSelectPrompt?: (prompt: string) => void;
}

function renderUserMessage(text: string) {
  try {
    if (text.startsWith('{') && text.endsWith('}')) {
      const data = JSON.parse(text);
      if (data.type === 'explain_selection' && data.text) {
        return (
          <div className="space-y-1.5 text-left min-w-0">
            <div className="flex items-center gap-1 text-caption text-theme-muted font-sans font-medium">
              <span>{m.chat_discuss_selected_text()}</span>
            </div>
            <div className="border-l-2 border-theme-primary/40 pl-2.5 italic text-xs leading-relaxed text-theme-foreground/90">
              “{data.text}”
            </div>
          </div>
        );
      }
      const explainCode = parseExplainCodePayload(text);
      if (explainCode) {
        const contextLabel =
          explainCode.filePath || explainCode.title || explainCode.sectionTitle || explainCode.language;
        const lineBadge = explainCode.lineRange
          ? `L${explainCode.lineRange.startLine}${
              explainCode.lineRange.endLine && explainCode.lineRange.endLine !== explainCode.lineRange.startLine
                ? `-L${explainCode.lineRange.endLine}`
                : ''
            }`
          : null;

        return (
          <div className="space-y-1.5 text-left min-w-0 max-w-full">
            <div className="flex flex-wrap items-center gap-1.5 text-caption text-theme-muted font-sans font-medium min-w-0">
              <span className="shrink-0">{m.chat_analyze_code_snippet()}</span>
              {contextLabel && (
                <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-theme-surface border border-theme-border/70 text-theme-foreground/80 font-mono text-micro truncate max-w-full min-w-0">
                  {contextLabel}
                  {lineBadge ? `:${lineBadge}` : ''}
                </span>
              )}
            </div>
            <pre className="text-micro font-mono bg-theme-bg/75 border border-theme-border/60 text-theme-foreground p-2.5 rounded-lg overflow-x-auto max-w-full max-h-36">
              {explainCode.code}
            </pre>
          </div>
        );
      }
    }
  } catch {
  }
  return text;
}

const ChatMessageRow = React.memo(function ChatMessageRow({
  mItem,
  isStreaming = false,
}: {
  mItem: ChatUIMessage;
  isStreaming?: boolean;
}) {
  const reasoningScrollRef = React.useRef<HTMLDivElement>(null);
  const rawMessageText =
    mItem.content ||
    (mItem.parts
      ? mItem.parts.map((p) => (p.type === 'text' ? p.text || '' : '')).join('')
      : '');
  const isUser = mItem.role === 'user';
  const messageText = isUser ? rawMessageText : extractStreamableAssistantText(rawMessageText);
  const reasoningText = mItem.parts
    ? mItem.parts.map((p) => (p.type === 'reasoning' ? p.text || '' : '')).join('')
    : '';

  React.useEffect(() => {
    const el = reasoningScrollRef.current;
    if (!el || messageText) return;
    el.scrollTop = el.scrollHeight;
  }, [reasoningText, messageText]);

  return (
    <div
      className={cn(
        'flex flex-col min-w-0 text-xs sm:text-[13px] leading-relaxed transition-all',
        isUser ? 'items-end' : 'items-start'
      )}
    >
      {isUser ? (
        <div className="min-w-0 max-w-[92%] overflow-hidden bg-theme-primary/[0.08] border border-theme-border text-theme-foreground rounded-2xl rounded-tr-xs px-3.5 py-2.5 shadow-2xs font-sans break-words">
          {renderUserMessage(messageText)}
        </div>
      ) : (
        <div className="w-full min-w-0 flex items-start gap-2.5">
          <div className="w-6 h-6 rounded-lg bg-theme-surface border border-theme-border/70 flex items-center justify-center shrink-0 mt-0.5 text-theme-primary shadow-2xs">
            <Sparkles size={12} />
          </div>
          <div className="flex-1 min-w-0 max-w-[92%] bg-theme-surface/80 border border-theme-border/60 text-theme-foreground rounded-2xl rounded-tl-xs px-3.5 py-3 shadow-2xs font-sans space-y-2">
            {reasoningText && !messageText && (
              <div className="rounded-lg border border-theme-border/50 bg-theme-bg/50 px-2.5 py-2 space-y-1.5">
                <div className="flex items-center gap-1.5 text-caption font-medium text-theme-muted select-none">
                  {isStreaming && (
                    <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-pulse shrink-0" />
                  )}
                  <span>{isStreaming ? m.chat_thinking() : m.quiz_mode_thinking()}</span>
                </div>
                <div
                  ref={reasoningScrollRef}
                  className="max-h-48 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words text-caption text-theme-muted/90 italic leading-relaxed"
                >
                  {reasoningText}
                </div>
              </div>
            )}
            {reasoningText && messageText && (
              <details className="rounded-lg border border-theme-border/50 bg-theme-bg/40 px-2.5 py-1.5">
                <summary className="cursor-pointer select-none text-caption text-theme-muted hover:text-theme-foreground transition-colors flex items-center gap-1.5">
                  <ChevronRight size={12} className="shrink-0" />
                  <span>{m.quiz_mode_thinking()}</span>
                </summary>
                <div className="mt-1.5 pt-1.5 border-t border-theme-border/40 max-h-48 overflow-y-auto custom-scrollbar whitespace-pre-wrap break-words text-caption text-theme-muted/90 italic leading-relaxed">
                  {reasoningText}
                </div>
              </details>
            )}
            {messageText ? (
              <div className="prose prose-sm dark:prose-invert max-w-none text-xs sm:text-[13px] leading-relaxed break-words [&_pre]:overflow-x-auto [&_pre]:max-w-full">
                <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>{messageText}</ReactMarkdown>
              </div>
            ) : isStreaming ? (
              <div className="flex items-center gap-1 py-1">
                <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce [animation-delay:-0.3s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce [animation-delay:-0.15s]" />
                <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce" />
              </div>
            ) : null}
          </div>
        </div>
      )}
    </div>
  );
});

export function ChatMessageList({
  messages,
  isLoading,
  error,
  historyOpen,
  historyList,
  historyLoading,
  chatScrollContainerRef,
  onCloseHistory,
  onLoadConversation,
  onDeleteConversation,
  onRetry,
  onModelSwitched,
  onOpenApiKeyModal,
  onOpenPreferencesModal,
  onSelectPrompt,
}: ChatMessageListProps) {
  return (
    <div
      ref={chatScrollContainerRef}
      className="relative flex-1 min-h-0 overflow-y-auto overscroll-contain p-4 space-y-4 custom-scrollbar flex flex-col bg-theme-bg"
    >
      {historyOpen && (
        <div className="absolute inset-0 z-10 bg-theme-bg flex flex-col font-sans">
          <div className="flex items-center justify-between px-4 py-3 border-b border-theme-border/40 shrink-0">
            <span className="text-xs font-bold text-theme-foreground flex items-center gap-1.5">
              <History size={13} className="text-theme-primary" />
              {m.chat_history_title()}
            </span>
            <button
              type="button"
              onClick={onCloseHistory}
              className="p-1 rounded-md text-theme-muted hover:text-theme-foreground hover:bg-theme-surface cursor-pointer"
              aria-label={m.common_close()}
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto custom-scrollbar p-2 space-y-1">
            {historyLoading ? (
              <p className="text-xs text-theme-muted text-center py-8">{m.common_loading()}</p>
            ) : historyList.length === 0 ? (
              <p className="text-xs text-theme-muted text-center py-8">{m.chat_history_empty()}</p>
            ) : (
              historyList.map((c) => (
                <div
                  key={c.id}
                  onClick={() => void onLoadConversation(c.id)}
                  className="group flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-theme-surface cursor-pointer transition-colors"
                >
                  <ChevronRight size={13} className="text-theme-muted shrink-0" />
                  <span className="flex-1 text-xs text-theme-foreground truncate">
                    {c.title || m.chat_history_untitled()}
                  </span>
                  <span className="text-micro text-theme-muted shrink-0 font-mono">
                    {new Date(c.updatedAt).toLocaleDateString()}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => void onDeleteConversation(c.id, e)}
                    className="p-1 rounded text-theme-muted/50 hover:text-theme-accent opacity-0 group-hover:opacity-100 transition-opacity cursor-pointer"
                    title={m.common_delete()}
                    aria-label={m.common_delete()}
                  >
                    <X size={12} />
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {messages.length === 0 && !historyOpen && (
        <div className="flex-1 flex flex-col items-center justify-center text-center px-2 py-8 space-y-5 select-none">
          <div className="w-12 h-12 rounded-2xl bg-theme-surface border border-theme-border/70 flex items-center justify-center text-theme-primary shadow-xs">
            <Sparkles size={22} />
          </div>

          <div className="space-y-1.5 max-w-[280px]">
            <h3 className="text-sm font-bold text-theme-foreground tracking-wide">
              {m.chat_title()}
            </h3>
            <p className="text-xs text-theme-muted leading-relaxed">
              {m.chat_welcome_intro()}
            </p>
          </div>

          <div className="w-full pt-1 flex flex-col gap-2">
            <div className="flex items-center gap-1.5 px-1 text-caption font-medium text-theme-muted">
              <span>💡</span>
              <span>{m.chat_quick_suggestions()}</span>
            </div>
            {getPromptSuggestions().map((item, idx) => (
              <button
                key={idx}
                type="button"
                onClick={() => onSelectPrompt?.(item)}
                className="w-full text-left text-xs text-theme-foreground/85 hover:text-theme-foreground bg-theme-surface/60 hover:bg-theme-surface border border-theme-border/60 hover:border-theme-border rounded-xl px-3 py-2.5 transition-all cursor-pointer shadow-2xs group flex items-center justify-between"
              >
                <span className="truncate pr-2">{item}</span>
                <ChevronRight size={13} className="text-theme-muted group-hover:text-theme-foreground transition-colors shrink-0" />
              </button>
            ))}
          </div>
        </div>
      )}

      {messages.map((mItem, idx) => (
        <ChatMessageRow
          key={mItem.id}
          mItem={mItem}
          isStreaming={isLoading && idx === messages.length - 1}
        />
      ))}

      {isLoading && messages[messages.length - 1]?.role === 'user' && (
        <div className="w-full flex items-start gap-2.5">
          <div className="w-6 h-6 rounded-lg bg-theme-surface border border-theme-border/70 flex items-center justify-center shrink-0 mt-0.5 text-theme-primary shadow-2xs">
            <Sparkles size={12} />
          </div>
          <div className="bg-theme-surface/80 border border-theme-border/60 text-theme-muted rounded-2xl rounded-tl-xs px-3.5 py-2.5 text-xs sm:text-[13px] font-sans shadow-2xs flex items-center">
            <div className="flex items-center gap-1">
              <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce [animation-delay:-0.3s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce [animation-delay:-0.15s]" />
              <span className="w-1.5 h-1.5 rounded-full bg-theme-primary animate-bounce" />
            </div>
          </div>
        </div>
      )}

      {error && (() => {
        const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;
        const errInfo = resolveUpstreamErrorPresentation(error, {
          offline: isOffline,
          fallbackTitle: m.toast_action_failed(),
          fallbackDesc: m.common_retry_later(),
        });
        return (
          <div className="self-start w-full max-w-[92%]">
            <UpstreamErrorNotice
              variant="inline"
              isOffline={isOffline}
              error={errInfo}
              onRetry={onRetry}
              onModelSwitched={onModelSwitched}
              onOpenApiKeyModal={onOpenApiKeyModal}
              onOpenPreferencesModal={onOpenPreferencesModal}
            />
          </div>
        );
      })()}
    </div>
  );
}
