import { WebDocDiffResult } from './types';
import { detectWebDocDiff, PreviousSyncState } from './diff-detector';

export * from './types';
export * from './diff-detector';

export class WebDocEngine {
  async detectDiff(
    url: string,
    previousState: PreviousSyncState = {},
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<WebDocDiffResult> {
    return detectWebDocDiff(url, previousState, options);
  }
}

export const webDocEngine = new WebDocEngine();
