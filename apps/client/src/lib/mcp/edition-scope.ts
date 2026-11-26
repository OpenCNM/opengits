import { prisma } from '@/lib/db';
import { deriveEditionLabel } from '@/lib/repository-resolver';

// Collapse multi-edition repos to one preferred edition (recently read > base > lexical) to preserve search budget.

export interface ScopeRow {
  id: string;
  owner: string;
  repo: string;
  branch?: string | null;
  edition?: string | null;
  [key: string]: unknown;
}

export interface ScopeGroup<Row extends ScopeRow> {
  key: string;
  preferred: Row;
  rows: Row[];
}

export function scopeGroupKey(row: ScopeRow): string {
  return `${(row.owner || '').toLowerCase()}/${(row.repo || '').toLowerCase()}@${row.branch || ''}`;
}

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

export interface ParsedHubRef {
  base: string;
  edition: string | null;
}

export function parseHubRef(ref: string): ParsedHubRef {
  const at = ref.lastIndexOf('@');
  if (at > 0 && at < ref.length - 1) {
    return { base: ref.slice(0, at), edition: ref.slice(at + 1) };
  }
  return { base: ref, edition: null };
}

export function editionAttribution(repoProfile: unknown, edition?: string | null): string {
  if (!edition) return '';
  return ` · 讲法: ${deriveEditionLabel(repoProfile)}`;
}

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
