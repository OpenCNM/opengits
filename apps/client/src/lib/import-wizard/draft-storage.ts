import { STORAGE_KEYS } from '@/lib/constants';
import { safeGetJSON, safeSetJSON, safeRemove } from '@/lib/storage-utils';
import { stripPhaseSuffix } from '@/engine/tree-batch-utils';

export interface WorkbenchDraftOutlineCategory {
  name: string;
  files: Array<{
    path: string;
    shortTitle?: string;
    tokens?: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface WorkbenchDraftData {
  owner: string;
  repo: string;
  sha?: string;
  updatedAt: number;
  customOutline: WorkbenchDraftOutlineCategory[];
  customPrompt?: string;
  transcriptionPreset?: string;
  targetLanguage?: string;
}

export const WORKBENCH_DRAFT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

export function saveWorkbenchDraft(
  owner: string,
  repo: string,
  data: {
    sha?: string;
    customOutline: WorkbenchDraftOutlineCategory[];
    customPrompt?: string;
    transcriptionPreset?: string;
    targetLanguage?: string;
  }
): boolean {
  if (!owner || !repo || !Array.isArray(data.customOutline) || data.customOutline.length === 0) {
    return false;
  }

  const key = STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo);
  const payload: WorkbenchDraftData = {
    owner,
    repo,
    sha: data.sha,
    updatedAt: Date.now(),
    customOutline: data.customOutline,
    customPrompt: data.customPrompt,
    transcriptionPreset: data.transcriptionPreset,
    targetLanguage: data.targetLanguage,
  };

  return safeSetJSON(key, payload);
}

export function loadWorkbenchDraft(
  owner: string,
  repo: string,
  currentSha?: string | null
): WorkbenchDraftData | null {
  if (!owner || !repo) return null;

  const key = STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo);
  const draft = safeGetJSON<WorkbenchDraftData | null>(key, null);

  if (!draft || !Array.isArray(draft.customOutline) || draft.customOutline.length === 0) {
    return null;
  }

  if (draft.owner !== owner || draft.repo !== repo) {
    clearWorkbenchDraft(owner, repo);
    return null;
  }

  const age = Date.now() - (draft.updatedAt || 0);
  if (age > WORKBENCH_DRAFT_MAX_AGE_MS || age < 0) {
    clearWorkbenchDraft(owner, repo);
    return null;
  }

  return draft;
}

export function clearWorkbenchDraft(owner: string, repo: string): void {
  if (!owner || !repo) return;
  const key = STORAGE_KEYS.WORKBENCH_DRAFT(owner, repo);
  safeRemove(key);
}

export function formatDraftTimeAgo(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHour = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHour / 24);

  if (diffMin < 1) {
    return '刚刚';
  }
  if (diffMin < 60) {
    return `${diffMin} 分钟前`;
  }
  if (diffHour < 24) {
    return `${diffHour} 小时前`;
  }
  return `${diffDay} 天前`;
}

export function canonicalizeOutline(
  outline: WorkbenchDraftOutlineCategory[]
): WorkbenchDraftOutlineCategory[] {
  if (!Array.isArray(outline)) return [];

  const result: WorkbenchDraftOutlineCategory[] = [];

  for (const cat of outline) {
    const rawName = (cat.name || (cat as any).title || '').trim();
    const trimmedCatName = stripPhaseSuffix(rawName) || '未命名章节';
    const seenPaths = new Set<string>();
    const cleanedFiles: WorkbenchDraftOutlineCategory['files'] = [];

    for (const f of cat.files || []) {
      if (!f || !f.path) continue;
      const normalizedPath = f.path.trim();
      if (!normalizedPath || seenPaths.has(normalizedPath)) continue;
      seenPaths.add(normalizedPath);

      let shortTitle = (f.shortTitle || '').trim();
      if (!shortTitle) {
        const segments = normalizedPath.split('/');
        const fileName = segments[segments.length - 1] || normalizedPath;
        shortTitle = fileName.replace(/\.[^/.]+$/, '') || fileName;
      }

      cleanedFiles.push({
        ...f,
        path: normalizedPath,
        shortTitle,
      });
    }

    if (cleanedFiles.length > 0) {
      result.push({
        ...cat,
        name: trimmedCatName,
        files: cleanedFiles,
      });
    }
  }

  return result;
}
