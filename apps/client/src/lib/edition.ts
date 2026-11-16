import { randomBytes } from 'crypto';

/**
 * 讲法（edition）域的纯函数集合：key 生成/解析、展示分组。
 * 集中于此供 /api/ingest 路由、首页分组（page.tsx）与单测共用，禁止散落内联。
 *
 * 讲法数据模型：一个讲法 = 一条 Repository 行；'' = 基础讲法（存量默认）；
 * 风格讲法行用 ed_ 前缀短 key，显示名/preset 存 repoProfile。
 */

/** 讲法 key 生成：ed_ + 8 位随机 hex（'' 保留给基础讲法，防两用户同名讲法撞唯一键） */
export function generateEditionKey(): string {
  return `ed_${randomBytes(4).toString('hex')}`;
}

/**
 * 解析本次导入的讲法 key：
 * - 显式传入 edition → 透传（trim）
 * - createEdition=true → 生成新短 key（衍生讲法导入）
 * - 其余 → ''（基础讲法，现状语义）
 */
export function resolveEditionForKey(body: { edition?: unknown; createEdition?: unknown }): string {
  if (typeof body.edition === 'string' && body.edition.trim() !== '') {
    return body.edition.trim();
  }
  if (body.createEdition === true) {
    return generateEditionKey();
  }
  return '';
}

/** 分组输入行的最小形状（page.tsx 的 DisplayRepo 满足之） */
export interface EditionGroupRow {
  id: string;
  owner: string;
  repo: string;
  edition?: string | null;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

/** 分组产出的讲法 chip（展示层消费） */
export interface EditionChipData {
  id: string;
  edition: string;
  isDefault: boolean;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

export interface RepoEditionGroup<Row extends EditionGroupRow> {
  /** 主行：基础讲法（edition=''）优先，无则 updatedAt 最新行 */
  primary: Row;
  /** 其余讲法行（按 edition 字典序） */
  siblings: Row[];
  /** 组内全部行（primary + siblings） */
  all: Row[];
  /** 组内讲法数（含基础） */
  editionCount: number;
}

/** 分组键策略：默认按 (owner, repo) 小写归一；同源簇场景传 sourceClusterKey 优先版 */
export type EditionGroupKeyFn<Row extends EditionGroupRow> = (row: Row) => string;

/** 默认组键：(owner, repo) 小写（历史行为，单测兼容） */
export function defaultEditionGroupKey<Row extends EditionGroupRow>(row: Row): string {
  return `${(row.owner || '').toLowerCase()}/${(row.repo || '').toLowerCase()}`;
}

/** 同源簇组键：sourceClusterKey ?? (owner, repo)——同源仓（clone/fork 转录）归一张卡 */
export function sameSourceEditionGroupKey<Row extends EditionGroupRow>(row: Row): string {
  const cluster = (row as { sourceClusterKey?: string | null }).sourceClusterKey;
  return cluster && cluster !== '' ? cluster : defaultEditionGroupKey(row);
}

function formatGroup<Row extends EditionGroupRow>(bucket: Row[]): RepoEditionGroup<Row> {
  if (bucket.length === 1) {
    const primary = bucket[0];
    return { primary, siblings: [], all: bucket, editionCount: 1 };
  }

  const byEdition = [...bucket].sort((a, b) => (a.edition ?? '').localeCompare(b.edition ?? ''));
  const baseRow = byEdition.find((r) => (r.edition ?? '') === '');

  let primary: Row;
  if (baseRow) {
    primary = baseRow;
  } else {
    // 无基础行：updatedAt 最新为主行（确定性兜底）
    const byUpdated = [...bucket].sort(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    );
    primary = byUpdated[0];
  }
  // siblings = 组内除主行外的全部行（跨仓同源簇中其他仓库的基础行也在其中，按 edition 字典序）
  const siblings = byEdition.filter((r) => r !== primary);

  return { primary, siblings, all: [primary, ...siblings], editionCount: bucket.length };
}

/**
 * 按 (owner, repo)（或调用方提供的组键策略）分组同仓库的多讲法行：
 * - 采用等价类并查集（Disjoint-Set）：同 (owner, repo) 必定属于同一物理仓库，永不分裂（防跨分支簇键漂移）；
 *   同 sourceClusterKey 的行归并到同一簇（跨仓同源衍生归卡）；
 * - 单行组照常返回（editionCount=1，调用方据此隐藏讲法 UI）
 * - 主行选择：基础讲法优先；无基础行时取 updatedAt 最新（保证确定性）
 */
export function buildRepoEditionGroups<Row extends EditionGroupRow>(
  rows: Row[],
  opts?: { groupKey?: EditionGroupKeyFn<Row> }
): RepoEditionGroup<Row>[] {
  const isCustomKey = Boolean(
    opts?.groupKey &&
    opts.groupKey !== defaultEditionGroupKey &&
    opts.groupKey !== sameSourceEditionGroupKey
  );

  if (isCustomKey) {
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = opts!.groupKey!(row);
      const bucket = groups.get(key);
      if (bucket) {
        bucket.push(row);
      } else {
        groups.set(key, [row]);
      }
    }
    return Array.from(groups.values()).map(formatGroup);
  }

  const isSameSourceMode = opts?.groupKey === sameSourceEditionGroupKey;
  const parent = new Map<number, number>();
  function find(i: number): number {
    if (!parent.has(i)) parent.set(i, i);
    const p = parent.get(i)!;
    if (p !== i) {
      const root = find(p);
      parent.set(i, root);
      return root;
    }
    return i;
  }
  function union(i: number, j: number) {
    const rootI = find(i);
    const rootJ = find(j);
    if (rootI !== rootJ) parent.set(rootI, rootJ);
  }

  const repoKeyIndex = new Map<string, number>();
  const clusterKeyIndex = new Map<string, number>();

  for (let idx = 0; idx < rows.length; idx++) {
    const row = rows[idx];
    const repoKey = defaultEditionGroupKey(row);
    if (repoKeyIndex.has(repoKey)) {
      union(idx, repoKeyIndex.get(repoKey)!);
    } else {
      repoKeyIndex.set(repoKey, idx);
    }

    if (isSameSourceMode) {
      const cluster = (row as { sourceClusterKey?: string | null }).sourceClusterKey;
      if (cluster && cluster.trim() !== '') {
        if (clusterKeyIndex.has(cluster)) {
          union(idx, clusterKeyIndex.get(cluster)!);
        } else {
          clusterKeyIndex.set(cluster, idx);
        }
      }
    }
  }

  const clusters = new Map<number, Row[]>();
  for (let idx = 0; idx < rows.length; idx++) {
    const root = find(idx);
    const list = clusters.get(root);
    if (list) {
      list.push(rows[idx]);
    } else {
      clusters.set(root, [rows[idx]]);
    }
  }

  return Array.from(clusters.values()).map(formatGroup);
}

/**
 * 从 EditionChip 推导精简友好的显示标签（纯函数，消除“标准教程”/“默认”含糊与避免模型重复）。
 * 优先级：自定义个性化标题 > 驱动/转录模型名称 > 去掉“版”后缀的预设名 > 兜底标准标签
 */
export function resolveEditionChipDisplayLabel(chip: {
  label?: string | null;
  transcriptionModels?: string[] | null;
  isDefault?: boolean;
}): string {
  const modelName = chip.transcriptionModels?.[0]?.trim() || '';
  const label = chip.label?.trim() || '';

  // 显式个性化标题：排除机生占位符（“讲法 ...”、“ed_...”、“标准教程”、“默认”、“教学解读版”、“教学解读”）
  if (
    label &&
    label !== '标准教程' &&
    label !== '默认' &&
    label !== '教学解读版' &&
    label !== '教学解读' &&
    !/^讲法\s+/i.test(label) &&
    !/^ed_[a-z0-9_]+$/i.test(label) &&
    !label.endsWith('版')
  ) {
    return label;
  }

  // 首选以驱动/转录模型（如 qwen3.8-max、glm-5.3-flash）作为版本区分标识
  if (modelName) return modelName;

  if (label && label.endsWith('版') && label !== '教学解读版') {
    const stripped = label.replace(/版$/, '');
    if (stripped !== '教学解读') {
      return stripped;
    }
  }
  return '标准教程';
}

