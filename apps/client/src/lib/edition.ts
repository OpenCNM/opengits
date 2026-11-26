import { randomBytes } from 'crypto';

export function generateEditionKey(): string {
  return `ed_${randomBytes(4).toString('hex')}`;
}

export function resolveEditionForKey(body: { edition?: unknown; createEdition?: unknown }): string {
  if (typeof body.edition === 'string' && body.edition.trim() !== '') {
    return body.edition.trim();
  }
  if (body.createEdition === true) {
    return generateEditionKey();
  }
  return '';
}

export interface EditionGroupRow {
  id: string;
  owner: string;
  repo: string;
  edition?: string | null;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

export interface EditionChipData {
  id: string;
  edition: string;
  isDefault: boolean;
  updatedAt?: Date | string;
  [key: string]: unknown;
}

export interface RepoEditionGroup<Row extends EditionGroupRow> {
  primary: Row;
  siblings: Row[];
  all: Row[];
  editionCount: number;
}

export type EditionGroupKeyFn<Row extends EditionGroupRow> = (row: Row) => string;

export function defaultEditionGroupKey<Row extends EditionGroupRow>(row: Row): string {
  return `${(row.owner || '').toLowerCase()}/${(row.repo || '').toLowerCase()}`;
}

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
    const byUpdated = [...bucket].sort(
      (a, b) => new Date(b.updatedAt ?? 0).getTime() - new Date(a.updatedAt ?? 0).getTime()
    );
    primary = byUpdated[0];
  }
  const siblings = byEdition.filter((r) => r !== primary);

  return { primary, siblings, all: [primary, ...siblings], editionCount: bucket.length };
}

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

export function resolveEditionChipDisplayLabel(chip: {
  label?: string | null;
  transcriptionModels?: string[] | null;
  isDefault?: boolean;
}): string {
  const modelName = chip.transcriptionModels?.[0]?.trim() || '';
  const label = chip.label?.trim() || '';

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

  if (modelName) return modelName;

  if (label && label.endsWith('版') && label !== '教学解读版') {
    const stripped = label.replace(/版$/, '');
    if (stripped !== '教学解读') {
      return stripped;
    }
  }
  return '标准教程';
}

