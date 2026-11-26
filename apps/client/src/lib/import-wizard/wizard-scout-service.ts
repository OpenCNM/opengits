import { readSseJsonStream } from '@/lib/sse';
import { matchScoutVersion, fallbackPrefix } from '@/lib/import-wizard/version-matchers';
import type { DedupResult } from '@/lib/repo-dedup';
import * as m from '@/paraglide/messages';

export interface ScoutCompletePayload {
  owner?: string;
  repo?: string;
  branch?: string;
  currentSha?: string | null;
  fileCount?: number;
  starCount?: number;
  pushedAt?: string | null;
  versions?: Array<{ prefix: string; totalFiles?: number; isOversized?: boolean; role?: string; lang?: string }>;
  sameSource?: { owner: string; repo: string; similarity: number; method: string } | null;
  dedupInfo?: DedupResult | null;
  aiCategory?: string;
  aiTags?: unknown;
  outlinesByPrefix?: Record<string, unknown[]>;
  prefixTimings?: Record<string, number>;
  profile?: {
    ingestMode?: string;
    textRoot?: string;
    docCodeRatio?: { ratio?: number; codeFiles?: number };
  };
  [key: string]: unknown;
}

export interface ScoutErrorPayload {
  status?: string;
  error?: string;
  diagnosticDescription?: string;
  httpStatus?: number;
}

export interface RunScoutOptions {
  url: string;
  importScopeMode: 'full_repo' | 'single_doc';
  filePath?: string;
  targetLanguage: string;
  onStep: (step: { stage: string; tag: string; title: string; detail: string }) => void;
}

export type ScoutExecutionResult =
  | { ok: true; data: ScoutCompletePayload; matchedPrefix: string }
  | { ok: false; error: ScoutErrorPayload };

export async function executeScoutPipeline(opts: RunScoutOptions): Promise<ScoutExecutionResult> {
  const res = await fetch('/api/scout?stream=1', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
    body: JSON.stringify({
      url: opts.url,
      importScopeMode: opts.importScopeMode,
      filePath: opts.filePath,
      targetLanguage: opts.targetLanguage,
    }),
  });

  if (!res.ok) {
    if (res.status === 401) {
      return {
        ok: false,
        error: {
          status: 'AUTH_REQUIRED',
          error: m.toast_login_required(),
          diagnosticDescription: '未登录状态仅可浏览公开教程。登录后可导入仓库、使用 MCP 功能并管理你的教程。',
        },
      };
    }
    if (res.headers.get('content-type')?.includes('application/json')) {
      const err = await res.json();
      return { ok: false, error: err };
    }
    return {
      ok: false,
      error: {
        status: 'SERVER_ERROR',
        error: `探测请求失败 (${res.status})`,
        diagnosticDescription: res.statusText,
      },
    };
  }

  const stream: { complete: ScoutCompletePayload | null; error: ScoutErrorPayload | null } = {
    complete: null,
    error: null,
  };

  if (res.body) {
    await readSseJsonStream<ScoutCompletePayload & ScoutErrorPayload>(res.body, async ({ event, data: payload }) => {
      if (event === 'step') {
        opts.onStep(payload as never);
      } else if (event === 'complete') {
        stream.complete = payload;
      } else if (event === 'error') {
        stream.error = payload;
      }
    });
  }

  if (stream.error) {
    return {
      ok: false,
      error: {
        status: stream.error.status || 'REPO_TOO_LARGE',
        error: stream.error.error || '探测错误',
        diagnosticDescription: stream.error.diagnosticDescription || '该仓库遇到问题无法导入。',
        httpStatus: stream.error.httpStatus || 413,
      },
    };
  }

  const data = stream.complete;
  if (!data) {
    return {
      ok: false,
      error: {
        status: 'SERVER_ERROR',
        error: '未收到完整的探测结果',
        diagnosticDescription: '服务端未能完成全路径探测与解析，请检查网络联通性或稍后再试。',
      },
    };
  }

  let matchedPrefix = '/';
  if (data.versions && data.versions.length > 0) {
    const matched = matchScoutVersion(data.versions, { filePath: opts.filePath });
    matchedPrefix = matched ? matched.prefix : fallbackPrefix(opts.filePath);
  }

  return { ok: true, data, matchedPrefix };
}
