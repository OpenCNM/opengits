export type RepoIngestStageKey =
  | 'init'
  | 'sha'
  | 'archive'
  | 'scan'
  | 'outline'
  | 'persist'
  | 'done';

export interface RepoIngestProgress {
  percent: number;
  stageKey: RepoIngestStageKey;
  downloadMeta?: string;
}

export function resolveRepoIngestProgress(
  logs: readonly string[],
  ingestSuccess: boolean,
): RepoIngestProgress {
  if (ingestSuccess) {
    return { percent: 100, stageKey: 'done' };
  }

  if (!logs || logs.length === 0) {
    return { percent: 10, stageKey: 'init' };
  }

  let hasDone = false;
  let hasPhase5 = false;
  let hasPhase4 = false;
  let hasPhase3 = false;
  let hasPhase2 = false;
  let hasPhase1 = false;
  let downloadMeta: string | undefined;

  for (const line of logs) {
    if (
      line.includes('导入完成') ||
      line.includes('Ingestion pipeline completed') ||
      line.includes('✓')
    ) {
      hasDone = true;
    }
    if (line.includes('[5/5]')) {
      hasPhase5 = true;
    }
    if (line.includes('[4/5]')) {
      hasPhase4 = true;
    }
    if (line.includes('[3/5]')) {
      hasPhase3 = true;
    }
    if (line.includes('[2/5]')) {
      hasPhase2 = true;
      const rateMatch = line.match(/(\d+(?:\.\d+)?\s*(?:KB|MB|GB|B)\/s)/i);
      const pctMatch = line.match(/\((\d+(?:\.\d+)?%)\)/);
      if (rateMatch && pctMatch) {
        downloadMeta = `${rateMatch[1]} · ${pctMatch[1]}`;
      } else if (rateMatch) {
        downloadMeta = rateMatch[1];
      }
    }
    if (line.includes('[1/5]')) {
      hasPhase1 = true;
    }
  }

  if (hasDone) {
    return { percent: 100, stageKey: 'done', downloadMeta };
  }
  if (hasPhase5) {
    return { percent: 95, stageKey: 'persist', downloadMeta };
  }
  if (hasPhase4) {
    return { percent: 80, stageKey: 'outline', downloadMeta };
  }
  if (hasPhase3) {
    return { percent: 60, stageKey: 'scan', downloadMeta };
  }
  if (hasPhase2) {
    return { percent: 35, stageKey: 'archive', downloadMeta };
  }
  if (hasPhase1) {
    return { percent: 18, stageKey: 'sha', downloadMeta };
  }

  return { percent: 10, stageKey: 'init' };
}
