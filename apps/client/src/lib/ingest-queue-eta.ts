export interface QueueEtaInput {
  status: string;
  queuePosition?: number | null;
  avgJobSeconds?: number | null;
  savedChunks?: number;
  totalChunks?: number | null;
  concurrency: number;
}

export function computeQueueEtaSeconds(input: QueueEtaInput): number | null {
  const avg = input.avgJobSeconds;
  if (typeof avg !== 'number' || avg <= 0) return null;

  if (input.status === 'QUEUED') {
    const position = input.queuePosition;
    if (typeof position !== 'number' || position < 1) return null;
    const concurrency = Math.max(1, input.concurrency);
    const waitBatches = Math.ceil(position / concurrency);
    return Math.round(waitBatches * avg + avg);
  }

  if (input.status === 'RUNNING') {
    const total = input.totalChunks;
    if (typeof total === 'number' && total > 0) {
      const remaining = Math.max(0, total - (input.savedChunks ?? 0));
      return Math.round((remaining / total) * avg);
    }
    return Math.round(avg * 0.5);
  }

  return null;
}
