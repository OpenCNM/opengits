import { prisma } from '@/lib/db';
import { deriveEditionLabel } from '@/lib/repository-resolver';

/**
 * MCP 检索的讲法（edition）作用域工具：
 * - 扇出折叠：书架内同仓库多讲法行只搜「主讲法」行（最近在读优先，其次基础行），
 *   防止同一知识点多份叙述挤占结果配额与 token 预算；
 * - ref 解析：Hub 的 repository 引用支持 "owner/repo@edition" 精确指定讲法；
 * - 归因：[Source: owner/repo · 讲法: label]。
 */

/** 折叠分组的行最小形状（hub 查询的 savedRepositories select 满足之） */
export interface ScopeRow {
  id: string;
  owner: string;
  repo: string;
  branch?: string | null;
  edition?: string | null;
  [key: string]: unknown;
}

export interface ScopeGroup<Row extends ScopeRow> {
  /** 组键（owner/repo/branch 小写归一；版本正交，不跨分支折叠） */
  key: string;
  /** 主讲法行（最近在读 > 基础行 > edition 字典序） */
  preferred: Row;
  /** 组内全部行（含主讲法） */
  rows: Row[];
}

/** 组键：owner/repo 小写 + branch（版本维度不折叠） */
export function scopeGroupKey(row: ScopeRow): string {
  return `${(row.owner || '').toLowerCase()}/${(row.repo || '').toLowerCase()}@${row.branch || ''}`;
}

/**
 * 纯函数折叠：按组键分组并选主讲法行。
 * latestProgressMs：行 id → 最近阅读时间戳（UserReadingProgress.updatedAt；缺省视为未读）。
 */
export function foldScopeRows<Row extends ScopeRow>(
  rows: Row[],
  latestProgressMs: Map<string, number> = new Map()
): ScopeGroup<Row>[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const key = scopeGroupKey(row);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(row);
    else buckets.set(key, [row]);
  }

  const groups: ScopeGroup<Row>[] = [];
  for (const [key, bucket] of buckets) {
    let preferred: Row;
    if (bucket.length === 1) {
      preferred = bucket[0];
    } else {
      // 讲法优先级：最近在读 > 基础行（''）> edition 字典序 —— 全确定性
      preferred = [...bucket].sort((a, b) => {
        const pa = latestProgressMs.get(a.id) ?? 0;
        const pb = latestProgressMs.get(b.id) ?? 0;
        if (pa !== pb) return pb - pa;
        const ea = a.edition ?? '';
        const eb = b.edition ?? '';
        return ea.localeCompare(eb);
      })[0];
    }
    groups.push({ key, preferred, rows: bucket });
  }
  return groups;
}

/** ref 解析结果：仓库引用 + 可选讲法 key（"owner/repo@ed_xxx" 语法） */
export interface ParsedHubRef {
  /** 原始 ref 去掉 @edition 后缀（"owner/repo" 或仓库 ID） */
  base: string;
  edition: string | null;
}

/** 解析 Hub 引用："owner/repo@edition" / "id@edition" / 普通 "owner/repo" / "id" */
export function parseHubRef(ref: string): ParsedHubRef {
  const at = ref.lastIndexOf('@');
  if (at > 0 && at < ref.length - 1) {
    return { base: ref.slice(0, at), edition: ref.slice(at + 1) };
  }
  return { base: ref, edition: null };
}

/** 归因后缀：讲法行追加「 · 讲法: label」（基础行/无讲法信息返回空） */
export function editionAttribution(repoProfile: unknown, edition?: string | null): string {
  if (!edition) return '';
  return ` · 讲法: ${deriveEditionLabel(repoProfile)}`;
}

/** 讲法显示名（供 header/清单直取） */
/**
 * 书架行的阅读活跃度查询（行 id → 最近阅读时间戳）。
 * 折叠的「最近在读优先」数据源；查询失败静默返回空 Map（退化为基础行优先）。
 */
export async function fetchReadingActivity(userId: string, repositoryIds: string[]): Promise<Map<string, number>> {
  if (repositoryIds.length === 0) return new Map();
  try {
    const progresses = await prisma.userReadingProgress.findMany({
      where: { userId, repositoryId: { in: repositoryIds } },
      select: { repositoryId: true, updatedAt: true },
    });
    return new Map(progressMapEntries(progresses));
  } catch {
    return new Map();
  }
}

function progressMapEntries(
  progresses: Array<{ repositoryId: string; updatedAt: Date }>
): Array<[string, number]> {
  return progresses.map((p) => [p.repositoryId, p.updatedAt.getTime()]);
}

/** 多讲法提示行：折叠后告知 Agent 可用 @edition 精确检索其他讲法 */
export function buildEditionHint<Row extends ScopeRow>(groups: ScopeGroup<Row>[]): string {
  const multi = groups.filter((g) => g.rows.length > 1);
  if (multi.length === 0) return '';
  const example = multi.find((g) => g.rows.some((r) => (r.edition ?? '') !== ''));
  const exampleRef = example
    ? `"${example.preferred.owner}/${example.preferred.repo}@${example.rows.find((r) => (r.edition ?? '') !== '')!.edition}"`
    : '';
  return (
    `\n\n(书架内 ${multi.length} 个仓库存在多种转录讲法，已按你在读的讲法检索。` +
    `可用 repository 参数的 "owner/repo@edition" 形式精确指定讲法${exampleRef ? `，如 ${exampleRef}` : ''}。)`
  );
}
