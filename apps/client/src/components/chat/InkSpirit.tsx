'use client';

import React, { useState, useRef, useEffect, useMemo } from 'react';
import dynamic from 'next/dynamic';
import { useRouter } from 'next/navigation';
import { useChat } from '@ai-sdk/react';
import { SidecarChatTransport } from '@/lib/ai/sidecar-chat-transport';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowUp, History, Sparkles, ChevronLeft, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useSafeSession } from '@/lib/useSafeSession';
import { useSettingsStore } from '@/lib/stores/settings-store';
import { useModalStore } from '@/lib/stores/modal-store';
import { normalizeExplainDepth } from '@/lib/ai/response-depth';
import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { toastManager } from '@/components/ui/toast';
import { requireAiCapability } from '@/lib/permissions/permission-gateway';
import * as m from '@/paraglide/messages';

import { InkSpiritAvatar } from './InkSpiritAvatar';
import { InkSpiritHeader } from './components/InkSpiritHeader';
// 按需加载（性能修复 2026-10-13）：react-markdown + remark-gfm 随 ChatMessageList
// 静态进入 docs layout 首屏 bundle，但聊天面板仅在用户点开时渲染——改 dynamic
// 后重型渲染依赖随首次打开拉取独立 chunk。
const ChatMessageList = dynamic(() =>
  import('./components/ChatMessageList').then((mod) => mod.ChatMessageList)
);
import { useSplitCanvasPin } from './hooks/useSplitCanvasPin';
import { useConversationHistory, type ChatUIMessage } from './hooks/useConversationHistory';
import { useSpiritActivityState } from './hooks/useSpiritActivityState';
import { useInkSpiritEvents } from './hooks/useInkSpiritEvents';

interface InkSpiritProps {
  owner: string;
  repo: string;
  repositoryId?: string;
}

function getExplainDepthOptions() {
  return [
    { value: 'simple', label: m.chat_depth_simple(), desc: m.chat_depth_simple_desc() },
    { value: 'normal', label: m.chat_depth_normal(), desc: m.chat_depth_normal_desc() },
    { value: 'detailed', label: m.chat_depth_detailed(), desc: m.chat_depth_detailed_desc() },
  ] as const;
}

export function InkSpirit({ owner, repo }: InkSpiritProps) {
  const isChatOpen = useModalStore((s) => s.isChatDrawerOpen);
  const openChatDrawer = useModalStore((s) => s.openChatDrawer);
  const closeChatDrawer = useModalStore((s) => s.closeChatDrawer);
  const setIsChatOpen = (open: boolean) => {
    if (open) openChatDrawer();
    else closeChatDrawer();
  };

  // Split-Canvas Docked State & Mobile Overlay Pin State
  const { isDesktop, panelWidth, isPinned, togglePin } = useSplitCanvasPin({
    isChatOpen,
    setIsChatOpen,
  });

  const [input, setInput] = useState('');
  const router = useRouter();
  const { data: session } = useSafeSession();
  const chatScrollContainerRef = useRef<HTMLDivElement>(null);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const openPreferencesModal = useModalStore((s) => s.openPreferencesModal);

  const explainDepth = useSettingsStore((s) => s.explainDepth);

  // AI SDK useChat setup
  const settingsRef = useRef({
    owner,
    repo,
    feynmanMode: false,
    bypassSocratic: false,
    tutoringStyle: useSettingsStore.getState().tutoringStyle,
    explainDepth: useSettingsStore.getState().explainDepth,
    preferredLang: useSettingsStore.getState().preferredLang,
    responseLang: useSettingsStore.getState().responseLang,
    customInstructions: useSettingsStore.getState().customInstructions,
    provider: useSettingsStore.getState().provider,
    model: useSettingsStore.getState().model,
    currentPath: typeof window !== 'undefined' ? window.location.pathname : '',
  });

  // Sync settings from store
  useEffect(() => {
    useSettingsStore.getState().initSettings();
    const syncFromStore = () => {
      const s = useSettingsStore.getState();
      settingsRef.current = {
        ...settingsRef.current,
        tutoringStyle: s.tutoringStyle,
        explainDepth: s.explainDepth,
        preferredLang: s.preferredLang,
        responseLang: s.responseLang,
        customInstructions: s.customInstructions,
        provider: s.provider,
        model: s.model,
        currentPath: window.location.pathname,
      };
    };
    syncFromStore();
    return useSettingsStore.subscribe(syncFromStore);
  }, []);

  const transport = useMemo(() => {
    return new SidecarChatTransport({
      api: '/api/chat',
      body: {
        get owner() { return settingsRef.current.owner; },
        get repo() { return settingsRef.current.repo; },
        get feynmanMode() { return settingsRef.current.feynmanMode; },
        get bypassSocratic() { return settingsRef.current.bypassSocratic; },
        get tutoringStyle() { return settingsRef.current.tutoringStyle; },
        get explainDepth() { return settingsRef.current.explainDepth; },
        get preferredLang() { return settingsRef.current.preferredLang; },
        get responseLang() { return settingsRef.current.responseLang; },
        get customInstructions() { return settingsRef.current.customInstructions; },
        get provider() { return settingsRef.current.provider; },
        get model() { return settingsRef.current.model; },
        get currentPath() { return settingsRef.current.currentPath; },
      },
    });
  }, []);

  const { messages, status, sendMessage, error, setMessages } = useChat({
    transport,
  });

  const isLoading = status === 'submitted' || status === 'streaming';

  const [isHovered] = useState(false);

  // User activity tracking & Spirit Emotion State
  const { spiritState } = useSpiritActivityState({
    isLoading,
    status,
    isChatOpen,
    isHovered,
  });

  // Conversation history management
  const {
    historyOpen,
    setHistoryOpen,
    historyList,
    historyLoading,
    loadHistoryList,
    handleLoadConversation,
    handleDeleteConversation,
  } = useConversationHistory({
    owner,
    repo,
    session,
    setMessages: setMessages as (messages: ChatUIMessage[]) => void,
  });

  // Global events & keyboard shortcuts
  useInkSpiritEvents({
    session,
    isChatOpen,
    setIsChatOpen,
    chatInputRef,
    sendMessage,
  });

  // Keep chat scrolled to bottom（rAF 节流：流式期间 messages 每 token 更新一次，
  // 直接同步赋值每 token 强制 reflow——节流到每帧至多一次，钉底语义不变）
  useEffect(() => {
    if (!chatScrollContainerRef.current) return;
    const el = chatScrollContainerRef.current;
    const raf = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [messages, isLoading]);

  const handleLocalSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input || input.trim() === '' || isLoading) return;
    requireAiCapability(() => {
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: input }],
      });
      setInput('');
    }, m.gate_reason_ai_chat());
  };

  const handleNewChat = () => {
    setMessages([]);
    setInput('');
    setHistoryOpen(false);
  };

  const handleSelectPrompt = (promptText: string) => {
    requireAiCapability(() => {
      setIsChatOpen(true);
      sendMessage({
        role: 'user',
        parts: [{ type: 'text', text: promptText }],
      });
    }, m.gate_reason_ai_chat());
  };

  const panelContent = (
    <>
      {/* Header Control Bar */}
      <InkSpiritHeader
        isPinned={isPinned}
        showPin={!isDesktop}
        isLoading={isLoading}
        onTogglePin={togglePin}
        onClose={() => setIsChatOpen(false)}
        onNewChat={handleNewChat}
      />

      {/* Message Scroll Area */}
      <ChatMessageList
        messages={messages as ChatUIMessage[]}
        isLoading={isLoading}
        error={error}
        historyOpen={historyOpen}
        historyList={historyList}
        historyLoading={historyLoading}
        chatScrollContainerRef={chatScrollContainerRef}
        onCloseHistory={() => setHistoryOpen(false)}
        onLoadConversation={handleLoadConversation}
        onDeleteConversation={handleDeleteConversation}
        onOpenApiKeyModal={() => openPreferencesModal('llm')}
        onSelectPrompt={handleSelectPrompt}
      />

      {/* Integrated Bottom Input Bar */}
      <div className="p-3.5 border-t border-theme-border/50 bg-theme-bg/95 backdrop-blur-md flex flex-col gap-2 shrink-0">
        <div className="flex items-center justify-between gap-2 px-1 text-micro text-theme-muted select-none">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1 font-mono">
              <kbd className="px-1 py-0.2 rounded border border-theme-border/40 bg-theme-surface text-micro">Enter</kbd> {m.chat_send_btn()}
            </span>
            <span aria-hidden="true" className="text-theme-border">·</span>
            <span className="flex items-center gap-1 font-mono">
              <kbd className="px-1 py-0.2 rounded border border-theme-border/40 bg-theme-surface text-micro">Esc</kbd> {m.common_collapse()}
            </span>
          </div>

          <Select
            value={explainDepth}
            onValueChange={(val) => {
              if (!val) return;
              useSettingsStore.getState().setSettings({
                explainDepth: normalizeExplainDepth(val),
              });
            }}
          >
            <SelectTrigger
              size="sm"
              aria-label={m.chat_depth_aria()}
              icon={<ChevronDown className="size-3 text-theme-muted shrink-0" />}
              className="h-6 min-h-0 sm:min-h-0 w-auto min-w-0 bg-theme-surface/70 hover:bg-theme-surface border-theme-border/60 rounded-md px-2 py-0 text-micro font-sans gap-1 shadow-none text-theme-muted hover:text-theme-foreground cursor-pointer"
            >
              <SelectValue>
                {getExplainDepthOptions().find((o) => o.value === explainDepth)?.label ?? m.chat_depth_simple()}
              </SelectValue>
            </SelectTrigger>
            <SelectContent side="top" align="end" alignItemWithTrigger={false} className="min-w-44">
              {getExplainDepthOptions().map((opt) => (
                <SelectItem key={opt.value} value={opt.value} className="text-xs py-1.5">
                  <div className="flex flex-col gap-0.5">
                    <span className="font-medium text-theme-foreground">{opt.label}</span>
                    <span className="text-micro text-theme-muted">{opt.desc}</span>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <form
          onSubmit={handleLocalSubmit}
          className="flex items-center gap-2 bg-theme-surface border border-theme-border/70 rounded-xl px-2.5 py-1.5 shadow-2xs focus-within:border-theme-primary/50 focus-within:ring-1 focus-within:ring-theme-primary/20 transition-all"
        >
          <button
            type="button"
            onClick={() => {
              const next = !historyOpen;
              setHistoryOpen(next);
              if (next) void loadHistoryList();
            }}
            title={m.chat_history_title()}
            className={cn(
              'p-1.5 rounded-lg flex items-center justify-center transition-colors cursor-pointer shrink-0',
              historyOpen
                ? 'text-theme-primary bg-theme-surface shadow-2xs'
                : 'text-theme-muted hover:text-theme-foreground hover:bg-theme-surface/80'
            )}
          >
            <History size={15} />
          </button>

          <input
            ref={chatInputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={m.chat_input_placeholder()}
            className="flex-1 min-w-0 bg-transparent border-none text-xs text-theme-foreground placeholder:text-theme-muted font-sans outline-none focus:outline-none p-0"
            disabled={isLoading}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleLocalSubmit(e);
              }
            }}
          />

          <button
            type="submit"
            disabled={!input || input.trim() === '' || isLoading}
            className={cn(
              'p-1.5 rounded-lg flex items-center justify-center transition-all cursor-pointer font-sans text-xs shrink-0',
              input && input.trim() !== ''
                ? 'bg-theme-foreground text-theme-bg hover:scale-105 shadow-2xs'
                : 'text-theme-muted/50 bg-theme-surface/50 border border-theme-border/30 cursor-not-allowed'
            )}
            aria-label={m.chat_send_btn()}
          >
            <ArrowUp size={14} />
          </button>
        </form>
      </div>
    </>
  );

  return (
    <AnimatePresence initial={false}>
      {isChatOpen && (
        isDesktop ? (
          /* Desktop Docked Mode: Embedded inline sticky split column (read & ask side-by-side) */
          <motion.aside
            key="ink-spirit-docked"
            aria-label={m.chat_title()}
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelWidth, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="sticky top-0 h-dvh self-start shrink-0 overflow-hidden border-l border-theme-border bg-theme-bg z-30"
          >
            <div
              id="ink-spirit-container"
              style={{ width: panelWidth }}
              className="h-dvh flex flex-col font-sans select-text min-h-0 bg-theme-bg"
            >
              {panelContent}
            </div>
          </motion.aside>
        ) : (
          /* Mobile / Narrow Viewport Fallback: Slide-over Drawer */
          <React.Fragment key="ink-spirit-overlay">
            {!isPinned && (
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                transition={{ duration: 0.2 }}
                onClick={() => setIsChatOpen(false)}
                className="fixed inset-0 z-[95] bg-black/25 dark:bg-black/50 backdrop-blur-[2px]"
              />
            )}

            <motion.div
              id="ink-spirit-container"
              initial={{ x: '100%', opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: '100%', opacity: 0 }}
              transition={{ type: 'spring', stiffness: 280, damping: 28 }}
              className="fixed top-0 right-0 h-dvh w-[400px] max-w-[calc(100vw-1rem)] z-[100] bg-theme-bg border-l border-theme-border shadow-[-12px_0_36px_rgba(0,0,0,0.12)] dark:shadow-[-12px_0_36px_rgba(0,0,0,0.45)] flex flex-col font-sans select-text min-h-0"
            >
              {panelContent}
            </motion.div>
          </React.Fragment>
        )
      )}
    </AnimatePresence>
  );
}
