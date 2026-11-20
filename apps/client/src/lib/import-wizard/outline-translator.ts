import { api, ApiClientError } from '@/lib/api/client';
import { readSseStream, readSseJsonStream } from '@/lib/sse';
import { SUPPORTED_LANGUAGES, TRANSLATION_LANGUAGES } from '@/lib/constants';
import { toastManager } from '@/components/ui/toast';
import * as m from '@/paraglide/messages';

export interface TranslateOutlineParams {
  outline: any[];
  targetLanguage: string;
  selectedPrefix: string;
  onSetTranslatingIndices: (indices: Set<string> | ((prev: Set<string>) => Set<string>)) => void;
  onSetOutline: (updater: (prev: any[]) => any[]) => void;
  onSetDirty: (dirty: boolean) => void;
  manual?: boolean;
  /** 向导卸载/取消时 abort：断开 fetch 即触发服务端 AbortSignal 级联停 LLM */
  signal?: AbortSignal;
}

/**
 * 翻译并润色大纲目录
 */
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
      const err = await res.json().catch(() => ({}));
      // route 对密钥类故障返回本地化 message（批次 B i18n 收口）——
      // toast 展示根因文案而非裸错误码（err.error 是 'KEY_DECRYPT_FAILED' 等 code）
      throw new Error(err.message || err.error || 'Failed to translate outline');
    }

    if (res.body) {
      await readSseStream(res.body, async ({ data }) => {
        try {
          const event = JSON.parse(data);
          if (event.type === 'translation') {
            onSetOutline((prev) => {
              const updated = [...prev];
              if (event.field === 'name' && updated[event.catIdx]) {
                updated[event.catIdx] = {
                  ...updated[event.catIdx],
                  name: event.translated,
                };
              } else if (event.field === 'shortTitle' && updated[event.catIdx]?.files?.[event.fileIdx]) {
                const updatedFiles = [...updated[event.catIdx].files];
                updatedFiles[event.fileIdx] = {
                  ...updatedFiles[event.fileIdx],
                  shortTitle: event.translated,
                };
                updated[event.catIdx] = { ...updated[event.catIdx], files: updatedFiles };
              }
              return updated;
            });
            onSetDirty(true);

            onSetTranslatingIndices((prev) => {
              const n = new Set(prev);
              if (event.field === 'shortTitle') {
                n.delete(`file-${event.catIdx}-${event.fileIdx}`);
              } else if (event.field === 'name') {
                n.delete(`name-${event.catIdx}`);
              }
              return n;
            });
          }
        } catch (e) {
          console.error('Failed to parse SSE JSON', e);
        }
      });
    }

    if (manual) {
      toastManager.add({ type: 'success', title: m.import_translate_done_title(), description: m.import_translate_done_desc() });
    }
    return true;
  } catch (e: any) {
    if (signal?.aborted) return false; // 主动取消（向导关闭/新翻译顶替）静默收尾
    toastManager.add({ type: 'error', title: m.toast_action_failed(), description: e.message });
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
  /** 向导卸载/取消时 abort：断开 fetch 即触发服务端 AbortSignal 级联停 LLM */
  signal?: AbortSignal;
}

/**
 * 针对单个文件标题重新提取或润色
 */
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

    if (res.ok && res.body) {
      await readSseStream(res.body, async ({ data }) => {
        try {
          const event = JSON.parse(data);
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
        } catch {}
      });
    }
    if (!res.ok) {
      // 非 2xx（如 400 MISSING_API_KEY / 429 限流）：按失败提示，不再误报"润色成功"
      const err = await res.json().catch(() => null);
      throw new Error(err?.error || `HTTP ${res.status}`);
    }
    if (polishApplied) {
      toastManager.add({
        type: 'success',
        title: m.import_title_polished_title(),
        description: file.path.split('/').pop(),
      });
    }
  } catch (e: any) {
    if (signal?.aborted) return; // 主动取消静默收尾
    toastManager.add({ type: 'error', title: m.toast_action_failed(), description: e.message });
  } finally {
    onSetTranslatingIndices((prev) => {
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
  }
}
