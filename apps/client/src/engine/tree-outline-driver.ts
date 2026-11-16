/**
 * engine/tree-outline-driver.ts
 *
 * 统一树大纲 driver（P3b）：POST /v1/outline/tree（Go worker-sidecar）。
 * 深度路由在 Go 侧——小仓单发（depth 1），巨仓骨架规划→并行下钻
 * （depth 2,课程树形态）。Fail-Closed：任何故障抛 SidecarError。
 */

import { callSidecar, callSidecarStream } from '@/lib/sidecar-client';

/** 章节形状(原 outline-draft-generator 的类型;D3 收刀后此处为 SSOT) */
export interface CandidateOutlineFile {
  path: string;
  isDoc: boolean;
  role?: string;
  weight?: number;
  anchor?: string;
  kind?: string;
}

export interface DraftModule {
  name: string;
  summary: string;
  directories: string[];
  granularity?: string;
}

export interface OutlineChapter {
  name: string;
  summary: string;
  files: Array<{ path: string; shortTitle: string; anchor?: string; companionFiles?: string[] }>;
  partTitle?: string;
}

export interface MacroTopologyNode {
  id: string;
  path: string;
  name: string;
  role?: string;
  fileCount: number;
  loc: number;
  hotness: number;
  topExports?: string[];
  primaryLang?: string;
}

export interface MacroTopologyEdge {
  from: string;
  to: string;
  weight: number;
  symbols?: string[];
  label?: string;
}

export interface MacroTopology {
  scope: string;
  scale: number;
  strategy: string;
  nodes: MacroTopologyNode[];
  edges: MacroTopologyEdge[];
  rawMermaid: string;
  mermaid: string;
  summary?: string;
}

/** 子课程（深度 2 产物；深度 1 无此结构） */
interface TreeSubCourse {
  name: string;
  summary: string;
  phase?: string;
  sourcePaths: string[];
  chapters: OutlineChapter[];
  topology?: MacroTopology;
}

/** 课程树：总览课 + 分区子课 */
interface TreeCourseTree {
  repo: string;
  overviewCourse?: TreeSubCourse;
  subCourses: TreeSubCourse[];
  skippedTrees?: string[];
  droppedPlan?: string[];
  replanned?: boolean;
  macroTopology?: MacroTopology;
}

export interface SidecarTreeOutlineResponse {
  ok: boolean;
  depth: 1 | 2;
  repo: string;
  chapters?: OutlineChapter[];
  courseTree?: TreeCourseTree;
  macroTopology?: MacroTopology;
  droppedPaths?: string[];
  excludedFiles?: Array<{ path: string; reason: string; note?: string }>;
  /** 采样路由观测（契约 C4）：仅日志与接口观测，任何前端组件不得渲染这些字段（最小文案公理） */
  stats?: {
    files?: number;
    allFiles?: number;
    durationMs?: number;
    promptTokens?: number;
    /** full-ast | stratified | stratified-partial | partial-ast | fallback-8 */
    samplingStrategy?: 'full-ast' | 'stratified' | 'stratified-partial' | 'partial-ast' | 'fallback-8';
    sampledFileCount?: number;
    astCoverageRatio?: number;
  };
  /** 冷启动准备中（HTTP 202）：巨仓归档下载+建图在后台进行，本响应无大纲产物，
   *  调用方按 retryAfterMs 轮询直至 preparing 消失 */
  preparing?: boolean;
  status?: string;
  detail?: string;
  retryAfterMs?: number;
}

const TREE_OUTLINE_TIMEOUT_MS = 900_000; // 15 分钟（对齐 Go sidecar handlerBudget = 15m）

interface TreeOutlineRequest {
  owner: string;
  repo: string;
  sha: string;
  token?: string;
  githubToken?: string;
  targetLanguage?: string;
  /** 子目录作用域(D2):非空时仅该前缀入图 */
  prefix?: string;
  /** 单次平铺地图 Prompt 预算上限(可选，长上下文模型调优) */
  fileCap?: number;
  /** BYOK 归属用户(网关 keyOrigin=user 解析用户 key;必传,缺失=网关恒 MISSING_API_KEY) */
  userId: string;
  /** 用户显式剪除的目录或文件路径前缀 */
  excludedPaths?: string[];
  /** 用户自然语言编排偏好指令 */
  customPrompt?: string;
  /** 大纲节奏/章节粒度 (compact: 紧凑 5-7章, normal: 标准 8-10章, detailed: 详尽 11-14章) */
  pacing?: 'compact' | 'normal' | 'detailed';
  /** 教学深度 (overview: 简单 / standard: 默认 / deep: 困难)——全链路贯穿大纲规划与文件选取 */
  teachingDepth?: 'overview' | 'standard' | 'deep';
  /** 学习者画像与定位 (architecture_overview: 架构速通, deep_dive_internals: 源码攻坚, cross_language_migrant: 跨语言迁移, pedagogical_beginner: 零基础入门) */
  learnerArchetype?: 'architecture_overview' | 'deep_dive_internals' | 'cross_language_migrant' | 'pedagogical_beginner';
  /**
   * 调用方总预算（毫秒）：客户端 fetch 超时的显式契约。sidecar 以其推导
   * 整条处理链的 ctx 上限，LLM 切片按剩余额度动态钳制——服务端不再猜测
   * 调用方还能等多久（预算所有权归真正的持有者）。
   */
  budgetMs?: number;
  /** 显式重试标识：清空前序失败或陈旧准备状态，强制重新点火准备管线 */
  retry?: boolean;
}


interface TreeOutlineProgressStep {
  stage: string;
  title: string;
  detail: string;
  progress?: number;
}

interface ExecuteSidecarTreeOutlineOptions {
  signal?: AbortSignal;
  stream?: boolean;
  onProgress?: (step: TreeOutlineProgressStep) => void;
}

/** 解析 Sidecar 发送的 SSE 流式响应并按帧分发 */
async function parseSSEStream<T>(
  stream: ReadableStream<Uint8Array>,
  onStep?: (step: TreeOutlineProgressStep) => void
): Promise<T> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let finalResult: T | null = null;
  let currentEvent = '';
  let currentData = '';

  const dispatchEvent = () => {
    if (!currentEvent && !currentData) return;
    if (currentEvent === 'step') {
      try {
        const parsed = JSON.parse(currentData) as TreeOutlineProgressStep;
        onStep?.(parsed);
      } catch {
        // ignore malformed step
      }
    } else if (currentEvent === 'complete') {
      try {
        const parsed = JSON.parse(currentData);
        finalResult = (parsed.data ?? parsed) as T;
      } catch (e) {
        throw new Error(`Failed to parse complete event data: ${String(e)}`);
      }
    } else if (currentEvent === 'error') {
      try {
        const parsed = JSON.parse(currentData);
        throw new Error(parsed.message || 'Sidecar tree-outline error');
      } catch (e) {
        if (e instanceof Error && e.message !== 'Sidecar tree-outline error') {
          throw e;
        }
        throw new Error(currentData || 'Sidecar tree-outline error');
      }
    }
    currentEvent = '';
    currentData = '';
  };

  const processLine = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed) {
      dispatchEvent();
      return;
    }

    if (line.startsWith(':')) {
      // 心跳注释帧 (ping)，保持连接活性
      return;
    }

    if (line.startsWith('event:')) {
      let val = line.slice(6);
      if (val.startsWith(' ')) val = val.slice(1);
      currentEvent = val.trim();
    } else if (line.startsWith('data:')) {
      let val = line.slice(5);
      if (val.startsWith(' ')) val = val.slice(1);
      currentData = currentData ? currentData + '\n' + val : val;
    }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) {
          processLine(buffer);
        }
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? '';

      for (const line of lines) {
        processLine(line);
      }
    }
    dispatchEvent();
  } finally {
    reader.releaseLock();
  }

  if (!finalResult) {
    throw new Error('tree-outline: stream closed without complete event');
  }

  return finalResult;
}

/** 统一树大纲：小仓→扁平章；巨仓→课程树（+同序扁平章兼容视图），支持 SSE 流式长连接与阶段推进 */
export async function executeSidecarTreeOutline(
  req: TreeOutlineRequest,
  options?: ExecuteSidecarTreeOutlineOptions
): Promise<SidecarTreeOutlineResponse> {
  const payload = {
    owner: req.owner,
    repo: req.repo,
    sha: req.sha,
    token: req.token || undefined,
    githubToken: req.githubToken || req.token || undefined,
    targetLanguage: req.targetLanguage ?? 'zh-CN',
    prefix: req.prefix || undefined,
    fileCap: req.fileCap || undefined,
    userId: req.userId,
    excludedPaths: req.excludedPaths && req.excludedPaths.length > 0 ? req.excludedPaths : undefined,
    customPrompt: req.customPrompt || undefined,
    pacing: req.pacing || undefined,
    teachingDepth: req.teachingDepth || undefined,
    learnerArchetype: req.learnerArchetype || undefined,
    budgetMs: req.budgetMs || undefined,
    retry: req.retry || undefined,
  };

  let res: SidecarTreeOutlineResponse;

  if (options?.stream || options?.onProgress) {
    const rawRes = await callSidecarStream(
      '/v1/outline/tree',
      payload,
      {
        label: 'tree-outline /v1/outline/tree',
        timeoutMs: TREE_OUTLINE_TIMEOUT_MS,
        signal: options?.signal,
        headers: {
          accept: 'text/event-stream',
        },
      }
    );

    const contentType = rawRes.headers.get('content-type') || '';
    if (contentType.includes('text/event-stream') && rawRes.body) {
      res = await parseSSEStream<SidecarTreeOutlineResponse>(rawRes.body, options?.onProgress);
    } else {
      res = (await rawRes.json()) as SidecarTreeOutlineResponse;
    }
  } else {
    res = await callSidecar<SidecarTreeOutlineResponse>(
      '/v1/outline/tree',
      payload,
      {
        label: 'tree-outline /v1/outline/tree',
        timeoutMs: TREE_OUTLINE_TIMEOUT_MS,
        signal: options?.signal,
      }
    );
  }

  if (res.preparing) {
    // 冷启动契约：202 准备中响应无 depth/chapters，深度校验前让位
    return res;
  }
  if (res.depth !== 1 && res.depth !== 2) {
    throw new Error('tree-outline: malformed depth payload');
  }
  if (res.depth === 2 && !res.courseTree) {
    throw new Error('tree-outline: depth 2 without courseTree');
  }
  return res;
}

