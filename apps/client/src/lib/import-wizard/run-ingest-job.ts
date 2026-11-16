/**
 * 入库提交模板（模板方法模式）：GitHub 主管线与 web-doc 管线共用的
 * POST → 额度错误识别 → jobId 校验 → LAST_IMPORT_JOB 落盘 前段逻辑。
 * 五段式中的其余段（API Key 守卫递归 / abort 编排 / followImportJob / 失败结算）
 * 依赖组件闭包（requireApiKey 递归、followImportJob、setLogs/toast），留在调用方。
 */
import { api, ApiClientError } from '@/lib/api/client';
import { STORAGE_KEYS } from '@/lib/constants';

/** 仓库数量超限（ tiers 体系的结构化错误码）——调用方据此给出升级引导 */
export const TIER_REPO_LIMIT_CODE = 'TIER_REPO_LIMIT';

export function isTierRepoLimitError(err: unknown): err is ApiClientError {
  return err instanceof ApiClientError && err.code === TIER_REPO_LIMIT_CODE;
}

export interface IngestJobResponse {
  jobId?: string;
  deduped?: boolean;
  /** web-doc：命中已有公共文档库（非 Job 成功路径） */
  reused?: boolean;
  repositoryId?: string;
  owner?: string;
  repo?: string;
  message?: string;
}

export interface LastImportJobMeta {
  jobId: string;
  owner: string;
  repo: string;
  edition?: string;
}

/** 提交入库请求。onUnauthorized 固定 'throw'：调用方用自身的 401 分支展示文案 */
export async function submitIngestRequest(
  endpoint: '/api/ingest' | '/api/ingest/web-doc',
  payload: Record<string, unknown>,
  opts?: { signal?: AbortSignal }
): Promise<IngestJobResponse> {
  const created = await api.post<IngestJobResponse>(endpoint, payload, {
    onUnauthorized: 'throw',
    signal: opts?.signal,
  });
  if (!created?.jobId && !created?.reused) {
    throw new Error('Ingest endpoint returned no job id');
  }
  return created;
}

/** 落盘最近导入任务（向导重开续看进度用）；隐私模式静默失败 */
export function persistLastImportJob(meta: LastImportJobMeta): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  try {
    window.localStorage.setItem(
      STORAGE_KEYS.LAST_IMPORT_JOB,
      JSON.stringify({ ...meta, createdAt: Date.now() })
    );
  } catch {}
}
