import { ApiClientError } from '@/lib/api/client';
import { readSseStream } from '@/lib/sse';
import { SUPPORTED_LANGUAGES, TRANSLATION_LANGUAGES } from '@/lib/constants';
import { toastManager } from '@/components/ui/toast';
import type { UpstreamErrorMeta } from '@/lib/llm-gateway/upstream-error';
import { resolveUpstreamErrorPresentation } from '@/lib/llm-gateway/upstream-error-ui';
import { useModalStore } from '@/lib/stores/modal-store';
import * as m from '@/paraglide/messages';

interface TranslateSseEvent {
  type?: string;
  field?: string;
  catIdx?: number;
  fileIdx?: number;
  translated?: string;
  code?: string;
  message?: string;
  provider?: string;
  model?: string;
  upstreamStatus?: number;
  upstreamCode?: string;
}

async function parseTranslateHttpError(res: Response): Promise<ApiClientError> {
  let errJson: Record<string, unknown> | null = null;
  try {
    errJson = (await res.json()) as Record<string, unknown>;
  } catch {
  }

  const rawError = typeof errJson?.error === 'string' ? errJson.error : undefined;
  const rawMessage = typeof errJson?.message === 'string' ? errJson.message : undefined;
  const rawCode =
    typeof errJson?.code === 'string'
      ? errJson.code
      : rawError === 'MISSING_API_KEY' || rawError === 'KEY_DECRYPT_FAILED'
        ? rawError
        : res.status === 429
          ? 'RATE_LIMITED'
          : undefined;
  const rawDetail = typeof errJson?.detail === 'string' ? errJson.detail : undefined;
  const rawMeta =
    errJson?.meta && typeof errJson.meta === 'object' && !Array.isArray(errJson.meta)
      ? (errJson.meta as UpstreamErrorMeta)
      : undefined;

  return new ApiClientError(
    res.status,
    rawMessage || rawError || `HTTP ${res.status}`,
    {
      code: rawCode,
      detail: rawDetail,
      meta: rawMeta,
    }
  );
}

function buildTranslateSseError(event: Record<string, unknown>): Error {
  const msg =
    typeof event.message === 'string' && event.message.trim()
      ? event.message.trim()
      : 'Failed to translate outline';
  return Object.assign(new Error(msg), {
    ...(typeof event.code === 'string' ? { code: event.code } : {}),
    ...(typeof event.provider === 'string' ? { provider: event.provider } : {}),
    ...(typeof event.model === 'string' ? { model: event.model } : {}),
    ...(typeof event.upstreamStatus === 'number' ? { upstreamStatus: event.upstreamStatus } : {}),
    ...(typeof event.upstreamCode === 'string' ? { upstreamCode: event.upstreamCode } : {}),
    upstreamMessage: msg,
  });
}

function notifyTranslateError(err: unknown): void {
  const presentation = resolveUpstreamErrorPresentation(err, {
    offline: typeof navigator !== 'undefined' && !navigator.onLine,
    fallbackTitle: m.toast_action_failed(),
    fallbackDesc: m.common_retry_later(),
  });

  const metaParts = [
    presentation.provider && presentation.model
      ? `[${presentation.provider}/${presentation.model}]`
      : presentation.provider || presentation.model
        ? `[${presentation.provider || presentation.model}]`
        : undefined,
    presentation.upstreamStatus ? `HTTP ${presentation.upstreamStatus}` : undefined,
    presentation.upstreamCode,
  ].filter(Boolean);

  const detailLine = presentation.upstreamMessage
    ? metaParts.length > 0
      ? `${metaParts.join(' · ')} ${presentation.upstreamMessage}`
      : presentation.upstreamMessage
    : undefined;

  const description = detailLine
    ? `${presentation.description}\n${detailLine}`
    : presentation.description;

  const needsKeyOrModelAction =
    presentation.showConfigKey ||
    presentation.showModelSwitcher ||
    presentation.code === 'MISSING_API_KEY' ||
    presentation.code === 'KEY_DECRYPT_FAILED' ||
    presentation.code === 'UPSTREAM_AUTH_ERROR' ||
    presentation.code === 'UPSTREAM_QUOTA_EXCEEDED' ||
    presentation.code === 'UPSTREAM_MODEL_NOT_FOUND';

  toastManager.add({
    type: 'error',
    title: presentation.title,
    description,
    ...(needsKeyOrModelAction
      ? {
          actionProps: {
            children:
              presentation.code === 'MISSING_API_KEY' || presentation.code === 'KEY_DECRYPT_FAILED'
                ? m.chat_configure_apikey()
                : m.upstream_err_config_key(),
            onClick: () => {
              if (
                presentation.code === 'MISSING_API_KEY' ||
                presentation.code === 'KEY_DECRYPT_FAILED'
              ) {
                useModalStore.getState().openApiKeyModal();
              } else {
                useModalStore.getState().openPreferencesModal('llm');
              }
            },
          },
        }
      : {}),
  });
}

export interface TranslateOutlineParams {
  outline: any[];
  targetLanguage: string;
  selectedPrefix: string;
  onSetTranslatingIndices: (indices: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  onSetOutline: (updater: (prev: any[]) => any[]) => void;
  onSetDirty: (dirty: boolean) => void;
  manual?: boolean;
  signal?: AbortSignal;
}

export async function executeTranslateOutline({
  outline,
  targetLanguage,
  selectedPrefix,
  onSetTranslatingIndices,
  onSetOutline,
  onSetDirty,
  manual = false,
  signal,
}: TranslateOutlineParams): Promise<boolean> {
  if (outline.length === 0) return true;

  let lang = 'none';
  if (targetLanguage !== TRANSLATION_LANGUAGES.NONE_CODE) {
    lang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.name || TRANSLATION_LANGUAGES.DEFAULT_NAME;
  } else if (selectedPrefix.toLowerCase().includes(TRANSLATION_LANGUAGES.DEFAULT_CODE.toLowerCase())) {
    lang = TRANSLATION_LANGUAGES.DEFAULT_NAME;
  } else if (selectedPrefix.toLowerCase().includes('zh-tw') || selectedPrefix.toLowerCase().includes('zh-hk')) {
    lang = '繁体中文';
  } else if (selectedPrefix.toLowerCase().includes('ja')) {
    lang = '日文';
  }

  const allKeys = new Set<string>();
  for (let ci = 0; ci < outline.length; ci++) {
    allKeys.add(`name-${ci}`);
    for (let fi = 0; fi < (outline[ci].files?.length || 0); fi++) {
      allKeys.add(`file-${ci}-${fi}`);
    }
  }
  onSetTranslatingIndices(allKeys);

  try {
    const res = await fetch('/api/translate-outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outline, targetLanguage: lang }),
      signal,
    });

    if (!res.ok) {
      throw await parseTranslateHttpError(res);
    }

    if (res.body) {
      await readSseStream(res.body, async ({ data }) => {
        let event: TranslateSseEvent | null = null;
        try {
          event = JSON.parse(data) as TranslateSseEvent;
        } catch (e) {
          console.error('Failed to parse SSE JSON', e);
          return;
        }
        if (!event) return;
        if (event.type === 'error') {
          throw buildTranslateSseError(event as Record<string, unknown>);
        }
        if (event.type === 'translation') {
          const { field, catIdx, fileIdx, translated } = event;
          if (typeof catIdx !== 'number') return;
          onSetOutline((prev) => {
            const updated = [...prev];
            if (field === 'name' && updated[catIdx]) {
              updated[catIdx] = {
                ...updated[catIdx],
                name: translated,
              };
            } else if (
              field === 'shortTitle' &&
              typeof fileIdx === 'number' &&
              updated[catIdx]?.files?.[fileIdx]
            ) {
              const updatedFiles = [...updated[catIdx].files];
              updatedFiles[fileIdx] = {
                ...updatedFiles[fileIdx],
                shortTitle: translated,
              };
              updated[catIdx] = { ...updated[catIdx], files: updatedFiles };
            }
            return updated;
          });
          onSetDirty(true);

          onSetTranslatingIndices((prev) => {
            const n = new Set(prev);
            if (field === 'shortTitle' && typeof fileIdx === 'number') {
              n.delete(`file-${catIdx}-${fileIdx}`);
            } else if (field === 'name') {
              n.delete(`name-${catIdx}`);
            }
            return n;
          });
        }
      });
    }

    if (manual) {
      toastManager.add({ type: 'success', title: m.import_translate_done_title(), description: m.import_translate_done_desc() });
    }
    return true;
  } catch (e: unknown) {
    if (signal?.aborted) return false;
    console.warn('[outline-translator] executeTranslateOutline failed:', e);
    notifyTranslateError(e);
    return false;
  } finally {
    onSetTranslatingIndices(new Set());
  }
}

export interface ReextractFileTitleParams {
  catIdx: number;
  fileIdx: number;
  outline: any[];
  targetLanguage: string;
  onSetTranslatingIndices: (updater: (prev: Set<string>) => Set<string>) => void;
  onSetOutline: (updater: (prev: any[]) => any[]) => void;
  onSetDirty: (dirty: boolean) => void;
  signal?: AbortSignal;
}

export async function reextractSingleFileTitle({
  catIdx,
  fileIdx,
  outline,
  targetLanguage,
  onSetTranslatingIndices,
  onSetOutline,
  onSetDirty,
  signal,
}: ReextractFileTitleParams): Promise<void> {
  const file = outline[catIdx]?.files?.[fileIdx];
  if (!file) return;

  const key = `file-${catIdx}-${fileIdx}`;
  onSetTranslatingIndices((prev) => new Set(prev).add(key));

  let lang = 'none';
  if (targetLanguage !== TRANSLATION_LANGUAGES.NONE_CODE) {
    lang = SUPPORTED_LANGUAGES.find((l) => l.code === targetLanguage)?.name || TRANSLATION_LANGUAGES.DEFAULT_NAME;
  }

  const singleOutline = [
    {
      name: outline[catIdx].name,
      files: [{ shortTitle: file.shortTitle || file.path.split('/').pop() }],
    },
  ];

  let polishApplied = false;
  try {
    const res = await fetch('/api/translate-outline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ outline: singleOutline, targetLanguage: lang }),
      signal,
    });

    if (!res.ok) {
      throw await parseTranslateHttpError(res);
    }

    if (res.body) {
      await readSseStream(res.body, async ({ data }) => {
        let event: TranslateSseEvent | null = null;
        try {
          event = JSON.parse(data) as TranslateSseEvent;
        } catch (e) {
          console.error('Failed to parse SSE JSON', e);
          return;
        }
        if (!event) return;
        if (event.type === 'error') {
          throw buildTranslateSseError(event as Record<string, unknown>);
        }
        if (event.type === 'translation' && event.field === 'shortTitle') {
          polishApplied = true;
          onSetOutline((prev) => {
            const updated = [...prev];
            if (updated[catIdx]?.files?.[fileIdx]) {
              const updatedFiles = [...updated[catIdx].files];
              updatedFiles[fileIdx] = {
                ...updatedFiles[fileIdx],
                shortTitle: event.translated,
              };
              updated[catIdx] = { ...updated[catIdx], files: updatedFiles };
            }
            return updated;
          });
          onSetDirty(true);
        }
      });
    }
    if (polishApplied) {
      toastManager.add({
        type: 'success',
        title: m.import_title_polished_title(),
        description: file.path.split('/').pop(),
      });
    }
  } catch (e: unknown) {
    if (signal?.aborted) return;
    console.warn('[outline-translator] reextractSingleFileTitle failed:', e);
    notifyTranslateError(e);
  } finally {
    onSetTranslatingIndices((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }
}
