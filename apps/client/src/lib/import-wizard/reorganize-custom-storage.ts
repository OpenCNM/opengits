import {
  REORGANIZE_ARCHETYPE_IDS,
  REORGANIZE_CATEGORY_IDS,
  REORGANIZE_PACING_IDS,
  REORGANIZE_SHORT_LABEL_MAX,
  REORGANIZE_CUSTOM_MAX_PER_CATEGORY,
  STORAGE_KEYS,
  type ReorganizeCategoryId,
  type ReorganizeLearnerArchetype,
  type ReorganizePacing,
} from '@/lib/constants';
import { safeGetJSON, safeRemove, safeSetJSON } from '@/lib/storage-utils';

export interface SavedCustomItem {
  id: string;
  label: string;
  prompt: string;
  pacing: ReorganizePacing;
  learnerArchetype: ReorganizeLearnerArchetype;
  createdAt: number;
}

interface ReorganizeCustomPayload {
  owner: string;
  repo: string;
  updatedAt: number;
  items: Record<ReorganizeCategoryId, SavedCustomItem[]>;
}

const REORGANIZE_CUSTOM_PROMPT_MAX = 1200;

const PACING_VALUE_SET: ReadonlySet<string> = new Set<string>(REORGANIZE_PACING_IDS);
const ARCHETYPE_VALUE_SET: ReadonlySet<string> = new Set<string>(REORGANIZE_ARCHETYPE_IDS);

function createEmptyItems(): Record<ReorganizeCategoryId, SavedCustomItem[]> {
  return { clarify: [], compact: [], expand: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isReorganizePacing(value: unknown): value is ReorganizePacing {
  return typeof value === 'string' && PACING_VALUE_SET.has(value);
}

function isReorganizeLearnerArchetype(value: unknown): value is ReorganizeLearnerArchetype {
  return typeof value === 'string' && ARCHETYPE_VALUE_SET.has(value);
}

function parseSavedItem(raw: unknown): SavedCustomItem | null {
  if (!isRecord(raw)) return null;

  const id = raw.id;
  const label = raw.label;
  const prompt = raw.prompt;
  const pacing = raw.pacing;
  const learnerArchetype = raw.learnerArchetype;
  const createdAt = raw.createdAt;

  if (typeof id !== 'string' || id.trim() === '') return null;
  if (typeof label !== 'string' || label.trim() === '') return null;
  if (typeof prompt !== 'string' || prompt.trim() === '') return null;
  if (!isReorganizePacing(pacing)) return null;
  if (!isReorganizeLearnerArchetype(learnerArchetype)) return null;
  if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return null;

  return { id, label, prompt, pacing, learnerArchetype, createdAt };
}

function persistReorganizeCustom(
  owner: string,
  repo: string,
  items: Record<ReorganizeCategoryId, SavedCustomItem[]>
): boolean {
  const key = STORAGE_KEYS.WORKBENCH_REORG_CUSTOM(owner, repo);
  const payload: ReorganizeCustomPayload = {
    owner,
    repo,
    updatedAt: Date.now(),
    items,
  };
  return safeSetJSON(key, payload);
}

export function generateSavedCustomItemId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function loadReorganizeCustom(
  owner: string,
  repo: string
): Record<ReorganizeCategoryId, SavedCustomItem[]> {
  const empty = createEmptyItems();
  if (!owner || !repo) return empty;

  const key = STORAGE_KEYS.WORKBENCH_REORG_CUSTOM(owner, repo);
  const raw = safeGetJSON<unknown>(key, null);
  if (!isRecord(raw)) return empty;

  if (raw.owner !== owner || raw.repo !== repo) {
    safeRemove(key);
    return empty;
  }

  const rawItems = raw.items;
  if (!isRecord(rawItems)) return empty;

  const items = createEmptyItems();
  let droppedCount = 0;

  for (const categoryId of REORGANIZE_CATEGORY_IDS) {
    const list = rawItems[categoryId];
    if (!Array.isArray(list)) continue;

    for (const rawItem of list) {
      const parsed = parseSavedItem(rawItem);
      if (!parsed) {
        droppedCount += 1;
        continue;
      }
      items[categoryId].push(parsed);
    }
  }

  if (droppedCount > 0) {
    console.warn(`[reorganizeCustom] ${owner}/${repo} 检测到 ${droppedCount} 条无效自定义子项，已自动剔除`);
  }

  return items;
}

export function saveReorganizeCustomItem(
  owner: string,
  repo: string,
  categoryId: ReorganizeCategoryId,
  item: SavedCustomItem
): boolean {
  if (!owner || !repo) return false;

  const validated = parseSavedItem(item);
  if (!validated) return false;

  const clampedItem: SavedCustomItem = {
    ...validated,
    label: validated.label.slice(0, REORGANIZE_SHORT_LABEL_MAX * 2),
    prompt: validated.prompt.slice(0, REORGANIZE_CUSTOM_PROMPT_MAX),
  };

  const currentItems = loadReorganizeCustom(owner, repo);

  const nextList = [
    clampedItem,
    ...currentItems[categoryId].filter((existing) => existing.prompt !== clampedItem.prompt),
  ].slice(0, REORGANIZE_CUSTOM_MAX_PER_CATEGORY);

  const nextItems = { ...currentItems };
  nextItems[categoryId] = nextList;

  return persistReorganizeCustom(owner, repo, nextItems);
}

export function removeReorganizeCustomItem(
  owner: string,
  repo: string,
  categoryId: ReorganizeCategoryId,
  itemId: string
): boolean {
  if (!owner || !repo || !itemId) return false;

  const currentItems = loadReorganizeCustom(owner, repo);
  const nextList = currentItems[categoryId].filter((existing) => existing.id !== itemId);

  const nextItems = { ...currentItems };
  nextItems[categoryId] = nextList;

  return persistReorganizeCustom(owner, repo, nextItems);
}
