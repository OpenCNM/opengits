'use client';

import { useState, useCallback } from 'react';
import * as m from '@/paraglide/messages';
import { toastManager } from '@/components/ui/toast';

export interface ChatMessagePart {
  type: string;
  text?: string;
}

export interface ChatUIMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  parts?: ChatMessagePart[];
  content?: string;
}

interface UseConversationHistoryOptions {
  owner: string;
  repo: string;
  session: { user?: unknown } | null;
  setMessages: (messages: ChatUIMessage[]) => void;
}

export function useConversationHistory({
  owner,
  repo,
  session,
  setMessages,
}: UseConversationHistoryOptions) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyList, setHistoryList] = useState<Array<{ id: string; title: string; updatedAt: string }>>([]);
  const [historyLoading, setHistoryLoading] = useState(false);

  const loadHistoryList = useCallback(async () => {
    if (!session?.user) {
      toastManager.add({
        type: 'info',
        title: m.chat_history_title(),
        description: m.chat_history_login_required(),
      });
      return;
    }
    setHistoryLoading(true);
    try {
      const { api } = await import('@/lib/api/client');
      const list = await api.get<Array<{ id: string; title: string; updatedAt: string }>>(
        `/api/conversations?owner=${encodeURIComponent(owner)}&repo=${encodeURIComponent(repo)}`,
        { onUnauthorized: 'throw' }
      );
      setHistoryList(Array.isArray(list) ? list : []);
    } catch (err) {
      console.warn('[conversation-history] fetch failed:', err);
      setHistoryList([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [session?.user, owner, repo]);

  const handleLoadConversation = useCallback(
    async (conversationId: string) => {
      setHistoryLoading(true);
      try {
        const { api } = await import('@/lib/api/client');
        const msgs = await api.get<Array<{ id: string; role: string; content: any }>>(
          `/api/conversations/${conversationId}`,
          { onUnauthorized: 'throw' }
        );
        setMessages(
          (Array.isArray(msgs) ? msgs : [])
            .filter((msg) => typeof msg.content === 'string' && msg.content.trim())
            .map((msg) => ({
              id: msg.id,
              role: msg.role as 'user' | 'assistant',
              parts: [{ type: 'text' as const, text: msg.content }],
            }))
        );
        setHistoryOpen(false);
      } catch {
        toastManager.add({
          type: 'error',
          title: m.chat_history_title(),
          description: m.common_retry_later(),
        });
      } finally {
        setHistoryLoading(false);
      }
    },
    [setMessages]
  );

  const handleDeleteConversation = useCallback(
    async (conversationId: string, event: React.MouseEvent) => {
      event.stopPropagation();
      try {
        const { api } = await import('@/lib/api/client');
        await api.delete(`/api/conversations/${conversationId}`, { onUnauthorized: 'throw' });
        setHistoryList((prev) => prev.filter((c) => c.id !== conversationId));
      } catch {
      }
    },
    []
  );

  return {
    historyOpen,
    setHistoryOpen,
    historyList,
    historyLoading,
    loadHistoryList,
    handleLoadConversation,
    handleDeleteConversation,
  };
}
