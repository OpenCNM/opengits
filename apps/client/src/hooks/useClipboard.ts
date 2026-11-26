import { useState, useCallback, useRef, useEffect } from 'react';
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

export interface UseClipboardOptions {
  timeout?: number;
  showToast?: boolean;
  successTitle?: string;
  successDescription?: string;
  errorTitle?: string;
  errorDescription?: string;
}

export function useClipboard(options: UseClipboardOptions = {}) {
  const {
    timeout = 2000,
    showToast = false,
    successTitle = m.common_copied(),
    successDescription = m.clipboard_success_desc(),
    errorTitle = m.toast_action_failed(),
    errorDescription = m.clipboard_error_desc(),
  } = options;

  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
      }
    };
  }, []);

  const copy = useCallback(
    async (text: string, key: string = 'default'): Promise<boolean> => {
      if (!text) return false;

      try {
        if (navigator?.clipboard?.writeText) {
          await navigator.clipboard.writeText(text);
        } else {
          const textArea = document.createElement('textarea');
          textArea.value = text;
          textArea.style.position = 'fixed';
          textArea.style.opacity = '0';
          document.body.appendChild(textArea);
          textArea.focus();
          textArea.select();
          document.execCommand('copy');
          document.body.removeChild(textArea);
        }

        if (timerRef.current) {
          clearTimeout(timerRef.current);
        }

        setCopiedKey(key);

        if (showToast) {
          toastManager.add({
            title: successTitle,
            description: successDescription,
            type: 'success',
          });
        }

        timerRef.current = setTimeout(() => {
          setCopiedKey(null);
          timerRef.current = null;
        }, timeout);

        return true;
      } catch (err) {
        console.error('Failed to copy to clipboard:', err);
        if (showToast) {
          toastManager.add({
            title: errorTitle,
            description: errorDescription,
            type: 'error',
          });
        }
        return false;
      }
    },
    [timeout, showToast, successTitle, successDescription, errorTitle, errorDescription]
  );

  const isCopied = useCallback(
    (key: string = 'default') => copiedKey === key,
    [copiedKey]
  );

  return {
    copy,
    copiedKey,
    isCopied,
    hasCopied: copiedKey !== null,
  };
}
