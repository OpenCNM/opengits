import type { ChapterMapEntry } from './chapter-map';
import { ENGINE_CONFIG } from '../lib/config';
import { ScaleDecision, RepoScale, MonorepoVolume } from '../types/explorer';

export type { ScaleDecision, RepoScale, MonorepoVolume };

/**
 * Repository ingestion mode:
 * - 'text_only': Standard Markdown documentation pipeline (for textbook/docs repos)
 * - 'code_only': Code Pedagogy pipeline (for pure source code repos)
 * - 'hybrid': Dual-track pipeline (processes docs + AST code pedagogy, merges NavTrees)
 */
export type IngestMode = 'text_only' | 'code_only' | 'hybrid';

/**
 * Breakdown of documentation vs code files in a repository.
 */
export interface DocCodeRatio {
  docFiles: number;
  codeFiles: number;
  otherFiles: number;
  totalFiles: number;
  /** Ratio of doc files vs total valid files (docFiles / (docFiles + codeFiles)), range [0.0, 1.0] */
  ratio: number;
  codeExtensions: Record<string, number>;
  docExtensions: Record<string, number>;
  /** 代码物理质量（字节累计）。旧画像 JSON 可能缺省，消费方按 0 处理。 */
  codeBytes?: number;
  /** 文档物理质量（字节累计）。旧画像 JSON 可能缺省，消费方按 0 处理。 */
  docBytes?: number;
}

/**
 * Deep profile of a codebase (populated by AI sniffer or rules)
 */
export interface CodebaseProfile {
  primaryLanguages: string[];
  entryPoints?: string[];
  framework?: string;
  coreModules?: string[];
  examplePaths?: string[];
  hasTests?: boolean;
  testFramework?: string;
  architectureStyle?: 'monorepo' | 'layered' | 'microservice' | 'single_package' | 'unknown';
  moduleStructure?: 'monolith' | 'monorepo' | 'flat' | 'layered';
  docStyle?: 'book' | 'api-reference' | 'narrative' | 'minimal';
  recommendedPedagogyLevel?: 'concept-first' | 'code-first' | 'balanced';
  keyAbstractions?: string[];
  moduleCount?: number;
  estimatedPedagogicalTime?: number;
  budgetTier?: 'full' | 'smart_sample' | 'entry_trace';
}

export interface RepoProfile {
  tier: 'S' | 'A' | 'B' | 'C' | 'D';
  repoType: 'textbook' | 'course' | 'docs' | 'codebase' | 'notebook';
  description?: string;
  descriptionZh?: string;
  descriptionEn?: string;
  
  // Routing & Ingestion mode
  ingestMode: IngestMode;
  docCodeRatio: DocCodeRatio;
  codebaseProfile?: CodebaseProfile;

  // 教材结构：章节序列识别已收敛到 chapter-map（TOC 侧车确定性解析 → BYOK LLM 小任务），
  // 规则嗅探零命名假设，只保留通用目录事实（textRoot / 课程目录根）
  textRoot: string | null;           // "book/"
  labRoots: string[];                // ["lessons/", "exercises/", ...]
  chapterCount: number;              // LLM 画像输出；规则路径恒 0（不再用命名正则计数）

  /**
   * 章节映射（profileVersion 2 核心）：order/title/mainPath/assetPaths 的校验后产物。
   * 由 chapter-map 模块在教材信号命中时解析（TOC → LLM 级联），随画像落库供复用。
   */
  chapterMap?: ChapterMapEntry[];
  /** 画像结构版本：2 = 含 chapterMap；旧落库画像缺省（按 legacy chapterAssets 读） */
  profileVersion?: number;

  // 附页资源
  globalAssets: {
    pdfs: { path: string; size: number; lang?: string }[];
    translations: { lang: string; dir: string }[];
    buildScripts: string[];
    misc: string[];
  };

  /**
   * @deprecated v1 遗留字段（key 归一为 `chapterN`，依赖命名正则）。新画像不再生成；
   * 仅 docs-page-loader 读取历史落库画像时兼容消费，被 chapterMap 取代。
   */
  chapterAssets?: Record<string, { path: string; type: string }[]>;
  
  // 答案检测
  answerFile: string | null;         // "book/思考题参考答案.md"
  
  // 翻译支持
  hasTranslations: boolean;
  translationRoots: string[];
  primaryLanguage?: string;

  /** 导入时实际转录的目录前缀（持久化到 repoProfile，供 sync 回放复用） */
  ingestPrefix?: string;
  
  // 过滤建议
  excludeFromNav: string[];          // 不应出现在导航树中的路径

  /**
   * AI-generated or rule-detected semantic tags for individual file paths.
   * Maps file path -> semantic role.
   */
  semanticTags: Record<string, 'migration' | 'answer' | 'config' | 'meta' | 'content'>;

  /** Whether the repository tree was truncated by GitHub API */
  isTreeTruncated?: boolean;

  /** Monorepo 多卷拆分推荐 (packages/*, apps/* 等) */
  volumes?: MonorepoVolume[];
}

export interface GitHubNode {
  path: string;
  type: 'tree' | 'blob';
  size?: number;
}

/**
 * 灰区判定（快筛/慢路径分界）：规则判 text_only 但代码物理质量构成成规模代码库。
 *
 * override 3/3.5 的"教程仓保护"对书籍仓是正确围栏，但"产品代码库带 docs/ 手册"
 * 同样命中（docs 数量微弱多数即锁死纯文档管线，代码被整体排除在教学外）。
 * 文件个数无法区分两种形态（一篇公告与一个引擎等权计数）；代码字节质量
 * 达到下限时物理事实与规则裁定相互矛盾——确定性代码无权裁决意图
 * （Syntax ≠ Intent），移交 scout 侧 LLM 仲裁（见 scout/pipeline/ingest-mode-arbiter）。
 *
 * 显然情况（书籍示例代码、零星脚本）不达线 → 非灰区 → 规则直判，零 LLM 消耗。
 */
export function isIngestModeGrayZone(profile: Pick<RepoProfile, 'ingestMode' | 'docCodeRatio'>): boolean {
  if (profile.ingestMode !== 'text_only') return false;
  const { docFiles, codeFiles, codeBytes } = profile.docCodeRatio;
  return (
    codeFiles >= ENGINE_CONFIG.sniffer.grayZoneMinCodeFiles &&
    (codeBytes ?? 0) >= ENGINE_CONFIG.sniffer.grayZoneMinCodeBytes &&
    docFiles >= 5
  );
}
