'use client';

import { useEffect, RefObject } from 'react';
import { useRouter } from 'next/navigation';
import { toastManager } from '@/components/ui/toast';
import { CUSTOM_EVENTS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { serializeExplainCodePayload } from '@/lib/code-viewport/explain-context';
import * as m from '@/paraglide/messages';

interface UseInkSpiritEventsOptions {
  session: { user?: unknown } | null;
  isChatOpen: boolean;
  setIsChatOpen: (open: boolean) => void;
  chatInputRef: RefObject<HTMLInputElement | null>;
  sendMessage: (message: any) => void;
}

export function useInkSpiritEvents({
  session,
  isChatOpen,
  setIsChatOpen,
  chatInputRef,
  sendMessage,
}: UseInkSpiritEventsOptions) {
  const router = useRouter();

  const askAiPayload = useModalStore((s) => s.askAiPayload);
  const clearAskAi = useModalStore((s) => s.clearAskAi);
  const deepDivePayload = useModalStore((s) => s.deepDivePayload);
  const clearDeepDive = useModalStore((s) => s.clearDeepDive);

  // Handle Ask AI Store Updates
  useEffect(() => {
    if (!askAiPayload) return;
    if (!session?.user) {
      toastManager.add({
        type: 'info',
        title: m.toast_login_required(),
        description: m.toast_login_required_desc(),
      });
      router.push('/auth/signin');
      clearAskAi();
      return;
    }
    setIsChatOpen(true);
    const queryPayload = JSON.stringify({
      type: 'explain_selection',
      text: askAiPayload.text,
    });
    sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
    clearAskAi();
  }, [askAiPayload, session?.user, router, sendMessage, clearAskAi, setIsChatOpen]);

  // Handle Deep Dive Store Updates
  useEffect(() => {
    if (!deepDivePayload) return;
    if (!session?.user) {
      toastManager.add({
        type: 'info',
        title: m.toast_login_required(),
        description: m.toast_login_required_desc(),
      });
      router.push('/auth/signin');
      clearDeepDive();
      return;
    }
    setIsChatOpen(true);
    const queryPayload = serializeExplainCodePayload(deepDivePayload);
    sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
    clearDeepDive();
  }, [deepDivePayload, session?.user, router, sendMessage, clearDeepDive, setIsChatOpen]);

  // Handle Keyboard Escape, Cmd+I & Ask AI Legacy Custom Events
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isChatOpen) {
        setIsChatOpen(false);
      }
      // Cmd/Ctrl+I: toggle embedded AI panel & focus input on open
      if ((e.metaKey || e.ctrlKey) && (e.key === 'i' || e.key === 'I')) {
        e.preventDefault();
        if (isChatOpen) {
          setIsChatOpen(false);
        } else {
          setIsChatOpen(true);
          requestAnimationFrame(() => chatInputRef.current?.focus());
        }
      }
    };

    const handleAskAiEvent = (e: any) => {
      if (!session?.user) {
        toastManager.add({
          type: 'info',
          title: m.toast_login_required(),
          description: m.toast_login_required_desc(),
        });
        router.push('/auth/signin');
        return;
      }
      setIsChatOpen(true);
      if (e.detail?.text) {
        const queryPayload = JSON.stringify({
          type: 'explain_selection',
          text: e.detail.text,
        });
        sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(CUSTOM_EVENTS.ASK_AI, handleAskAiEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(CUSTOM_EVENTS.ASK_AI, handleAskAiEvent);
    };
  }, [isChatOpen, sendMessage, session?.user, router, chatInputRef, setIsChatOpen]);
}
