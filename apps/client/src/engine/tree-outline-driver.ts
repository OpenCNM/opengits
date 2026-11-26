import { callSidecar, callSidecarStream } from '@/lib/sidecar-client';

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

interface TreeSubCourse {
  name: string;
  summary: string;
  phase?: string;
  sourcePaths: string[];
  chapters: OutlineChapter[];
  topology?: MacroTopology;
}

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
  stats?: {
    files?: number;
    allFiles?: number;
    durationMs?: number;
    promptTokens?: number;
    samplingStrategy?: 'full-ast' | 'stratified' | 'stratified-partial' | 'partial-ast' | 'fallback-8';
    sampledFileCount?: number;
    astCoverageRatio?: number;
    diagnostics?: {
      needRollupRequested?: number;
      needRollupCapped?: boolean;
      planDegenerateTriggered?: boolean;
      planDegenerateRecovered?: boolean;
      uncoveredSubsystemCount?: number;
      needRollupQuota?: number;
      needRollupDepth?: number;
    };
  };
  /** Callers must poll until preparing disappears because HTTP 202 omits depth/chapters. */
  preparing?: boolean;
  status?: string;
  detail?: string;
  retryAfterMs?: number;
}

const TREE_OUTLINE_TIMEOUT_MS = 900_000;

export interface PreviousOutlineChapterRef {
  index?: number;
  partTitle?: string;
  title: string;
  files?: string[];
}

interface TreeOutlineRequest {
  owner: string;
  repo: string;
  sha: string;
  token?: string;
  githubToken?: string;
  targetLanguage?: string;
  prefix?: string;
  fileCap?: number;
  userId: string;
  excludedPaths?: string[];
  customPrompt?: string;
  previousOutline?: PreviousOutlineChapterRef[];
  pacing?: 'compact' | 'normal' | 'detailed';
  teachingDepth?: 'overview' | 'standard' | 'deep';
  learnerArchetype?: 'architecture_overview' | 'deep_dive_internals' | 'cross_language_migrant' | 'pedagogical_beginner';
  rollupLevel?: number;
  /** Propagates caller timeout budget so sidecar clamps downstream LLM slices to remaining time. */
  budgetMs?: number;
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
        const parsed = JSON.parse(currentData) as {
          message?: string;
          code?: string;
          status?: number;
          provider?: string;
          model?: string;
          upstreamStatus?: number;
          upstreamCode?: string;
          upstreamMessage?: string;
        };
        const err = new Error(parsed.message || 'Sidecar tree-outline error') as Error & {
          code?: string;
          status?: number;
          provider?: string;
          model?: string;
          upstreamStatus?: number;
          upstreamCode?: string;
          upstreamMessage?: string;
        };
        if (parsed.code) err.code = parsed.code;
        if (typeof parsed.status === 'number') err.status = parsed.status;
        if (parsed.provider) err.provider = parsed.provider;
        if (parsed.model) err.model = parsed.model;
        if (typeof parsed.upstreamStatus === 'number') err.upstreamStatus = parsed.upstreamStatus;
        if (parsed.upstreamCode) err.upstreamCode = parsed.upstreamCode;
        if (parsed.upstreamMessage) err.upstreamMessage = parsed.upstreamMessage;
        throw err;
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
    previousOutline:
      req.previousOutline && req.previousOutline.length > 0 ? req.previousOutline : undefined,
    pacing: req.pacing || undefined,
    teachingDepth: req.teachingDepth || undefined,
    learnerArchetype: req.learnerArchetype || undefined,
    // Keep ?? so rollupLevel=0 is forwarded instead of coerced to undefined.
    rollupLevel: req.rollupLevel ?? undefined,
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
