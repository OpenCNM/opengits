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

/** 单条自定义子项（「换个思路」编排栏菜单可复点保存的短标签指令） */
export interface SavedCustomItem {
  id: string;
  /** 菜单短标签（保存侧钳制 ≤ REORGANIZE_SHORT_LABEL_MAX × 2） */
  label: string;
  /** 完整引擎指令 */
  prompt: string;
  pacing: ReorganizePacing;
  learnerArchetype: ReorganizeLearnerArchetype;
  createdAt: number;
}

/** localStorage 落盘载荷（按仓库作用域隔离，跨仓数据一律驱逐） */
interface ReorganizeCustomPayload {
  owner: string;
  repo: string;
  updatedAt: number;
  items: Record<ReorganizeCategoryId, SavedCustomItem[]>;
}

/** 完整引擎指令最大字符数（保存侧钳制，防超长 prompt 撑爆 localStorage 与下游 LLM 上下文） */
const REORGANIZE_CUSTOM_PROMPT_MAX = 1200;

/** pacing / 画像合法值查表（O(1) 成员判定，避免对 const 元组反复 includes） */
const PACING_VALUE_SET: ReadonlySet<string> = new Set<string>(REORGANIZE_PACING_IDS);
const ARCHETYPE_VALUE_SET: ReadonlySet<string> = new Set<string>(REORGANIZE_ARCHETYPE_IDS);

/**
 * 构造三类空数组的自愈基线。
 * 字面量受 Record<ReorganizeCategoryId, ...> 类型约束——常量增删分类时 tsc 会立即报错，杜绝与 SSOT 漂移。
 */
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

/**
 * 逐字段校验并收敛一条自定义子项（加载自愈与保存防腐共用的确定性网关）。
 * id / label / prompt 须为非空字符串，pacing / learnerArchetype 须命中全量枚举，createdAt 须为有限数值。
 */
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

/** 统一落盘尾部：所有写入收敛到同一载荷形状（Single-Writer 收敛尾） */
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

/**
 * 生成一条自定义子项的稳定唯一 id：优先 crypto.randomUUID，受限环境退化为时间基 + 随机后缀。
 * 供保存侧 UI 在构造 SavedCustomItem 时取用。
 */
export function generateSavedCustomItemId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 读取某仓库的全部分类自定义子项；任何失效/损坏/跨仓数据一律自愈为三类空数组。
 *
 * 设计说明：与草稿缓存不同，此处刻意不做 TTL 时效淘汰——
 * 自定义子项是用户显式保存的资产（非临时中间态），菜单 × 删除即驱逐路径，
 * 加时效反而会造成「刚保存的指令凭空消失」的破窗体验。
 */
export function loadReorganizeCustom(
  owner: string,
  repo: string
): Record<ReorganizeCategoryId, SavedCustomItem[]> {
  const empty = createEmptyItems();
  if (!owner || !repo) return empty;

  const key = STORAGE_KEYS.WORKBENCH_REORG_CUSTOM(owner, repo);
  const raw = safeGetJSON<unknown>(key, null);
  if (!isRecord(raw)) return empty;

  // 校验归属一致性：跨仓数据立即物理驱逐，防止 A 仓库的菜单指令泄漏到 B 仓库
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

/**
 * 保存一条自定义子项到指定分类（去重、容量裁剪、钳制），返回是否写入成功。
 * 1. 同分类内按完整指令精确去重：重存同一条指令即冒泡到顶部而非产生副本
 * 2. 每分类上限 REORGANIZE_CUSTOM_MAX_PER_CATEGORY 条，超出挤掉尾部最旧条目
 * 3. 保存边界确定性钳制：label ≤ REORGANIZE_SHORT_LABEL_MAX × 2，prompt ≤ 1200 字符
 */
export function saveReorganizeCustomItem(
  owner: string,
  repo: string,
  categoryId: ReorganizeCategoryId,
  item: SavedCustomItem
): boolean {
  if (!owner || !repo) return false;

  // 入库防腐网关：与加载侧共用同一套逐字段校验，非法条目直接拒绝落盘（fail-closed）
  const validated = parseSavedItem(item);
  if (!validated) return false;

  const clampedItem: SavedCustomItem = {
    ...validated,
    label: validated.label.slice(0, REORGANIZE_SHORT_LABEL_MAX * 2),
    prompt: validated.prompt.slice(0, REORGANIZE_CUSTOM_PROMPT_MAX),
  };

  const currentItems = loadReorganizeCustom(owner, repo);

  // 置顶插入 + 分类内按钳制后的完整指令去重，再按容量截断（尾部即最旧）
  const nextList = [
    clampedItem,
    ...currentItems[categoryId].filter((existing) => existing.prompt !== clampedItem.prompt),
  ].slice(0, REORGANIZE_CUSTOM_MAX_PER_CATEGORY);

  const nextItems = { ...currentItems };
  nextItems[categoryId] = nextList;

  return persistReorganizeCustom(owner, repo, nextItems);
}

/**
 * 从指定分类删除一条自定义子项，返回是否写入成功。
 * 未命中 itemId 时过滤结果不变，仍按原样落盘（幂等删除，布尔仅反映写入结果）。
 */
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
