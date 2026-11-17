'use client';

import { useEffect, RefObject } from 'react';
import { CUSTOM_EVENTS } from '@/lib/constants';
import { useModalStore } from '@/lib/stores/modal-store';
import { serializeExplainCodePayload } from '@/lib/code-viewport/explain-context';
import { requireAiCapability } from '@/lib/permissions/permission-gateway';
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
  const askAiPayload = useModalStore((s) => s.askAiPayload);
  const clearAskAi = useModalStore((s) => s.clearAskAi);
  const deepDivePayload = useModalStore((s) => s.deepDivePayload);
  const clearDeepDive = useModalStore((s) => s.clearDeepDive);

  // Handle Ask AI Store Updates
  useEffect(() => {
    if (!askAiPayload) return;
    const payload = askAiPayload;
    clearAskAi();

    requireAiCapability(() => {
      setIsChatOpen(true);
      const queryPayload = JSON.stringify({
        type: 'explain_selection',
        text: payload.text,
      });
      sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
    }, m.gate_reason_ai_chat());
  }, [askAiPayload, sendMessage, clearAskAi, setIsChatOpen]);

  // Handle Deep Dive Store Updates
  useEffect(() => {
    if (!deepDivePayload) return;
    const payload = deepDivePayload;
    clearDeepDive();

    requireAiCapability(() => {
      setIsChatOpen(true);
      const queryPayload = serializeExplainCodePayload(payload);
      sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
    }, m.gate_reason_ai_chat());
  }, [deepDivePayload, sendMessage, clearDeepDive, setIsChatOpen]);

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
      requireAiCapability(() => {
        setIsChatOpen(true);
        if (e.detail?.text) {
          const queryPayload = JSON.stringify({
            type: 'explain_selection',
            text: e.detail.text,
          });
          sendMessage({ role: 'user', parts: [{ type: 'text', text: queryPayload }] });
        }
      }, m.gate_reason_ai_chat());
    };

    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener(CUSTOM_EVENTS.ASK_AI, handleAskAiEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener(CUSTOM_EVENTS.ASK_AI, handleAskAiEvent);
    };
  }, [isChatOpen, sendMessage, chatInputRef, setIsChatOpen]);
}
