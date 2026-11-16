import { z } from 'zod';
import { MODULE_ROLE_PATTERNS } from './language-map';
import type { GitHubNode } from './fetcher';

/**
 * Blueprint schema for converting codebases / hybrid repositories into structured document-based tutorial chapters.
 */
const codebaseTutorialBlueprintSchema = z.object({
  primaryLanguages: z.array(z.string()).describe("Primary programming languages used, for syntax highlighting in generated tutorial code blocks"),
  framework: z.string().optional().describe("Core framework or library name for tutorial technical background context"),
  entryPoints: z.array(z.string()).describe("Key entry point file paths (e.g., src/index.ts, cmd/main.go) to map into 'Getting Started & System Entry' tutorial chapters"),
  coreModules: z.array(z.string()).describe("Key source modules or component directories to map into 'Core Architecture & Component Analysis' tutorial chapters"),
  examplePaths: z.array(z.string()).describe("Sample, demo, or usage example file paths to map into 'Hands-on Examples & Practice' tutorial chapters"),
});

/**
 * 仓库嗅探 LLM 输出 schema（M5-2 起导出与 LLM 网关注册表单一事实源共享）。
 * 全字段容错（zod catch）：qwen3.6-flash 等快模型对复杂 schema 的输出漂移是
 * 系统性的（自创字段名 / 自创嵌套结构 / 类型错位），任何单字段校验失败都会让
 * 整个 LLM sniff 返回 null → 生产链路静默退化到纯规则兜底（曾 100% 失效）。
 * 模型按"尽力而为的输入源"对待：能输出的字段用上，漂移字段静默回退默认值。
 */
export const repoSniffSchema = z.object({
  repoType: z.enum(['textbook', 'course', 'docs', 'codebase', 'notebook', 'hybrid']).catch('codebase'),
  textRoot: z.string().catch('').describe("The root directory for textbook markdown files, including trailing slash, or empty string if root."),
  chapterCount: z.number().catch(0).describe("The estimated number of chapters. 0 if none."),
  labRoots: z.array(z.string()).catch([]).describe("List of directories containing lab code or exercises."),
  hasTranslations: z.boolean().catch(false).describe("True if there are multiple language directories like zh/, i18n/ja/, translations/zh-cn/, docs-zh/, etc."),
  translationRoots: z.array(z.string()).catch([]).describe("List of translation directories with trailing slash, or empty array if none."),
  semanticTags: z.record(
    z.string(),
    z.enum(['migration', 'answer', 'config', 'meta', 'content'])
  ).catch({}).describe(
    "Map of file path -> semantic role. " +
    "'migration': changelog, upgrade guide, breaking changes, release notes. " +
    "'answer': answer keys, solutions, exercise answer files. " +
    "'config': build scripts, CI/CD configs, package manifests. " +
    "'meta': community meta files like LICENSE, SECURITY. " +
    "'content': regular documentation or code content."
  ),
  codebaseProfile: codebaseTutorialBlueprintSchema.optional().catch(undefined).describe("Tutorial generation blueprint if repoType is codebase or hybrid (maps code files directly into tutorial chapters)"),
});

interface DirectoryTopologySummary {
  totalNodes: number;
  totalMarkdownFiles: number;
  configFiles: string[];
  directories: Record<string, {
    totalFiles: number;
    markdownCount: number;
    codeCount: number;
    samplePaths: string[];
  }>;
}

/**
 * Builds a dense 100% full-repository directory topology summary.
 * Compresses 5,000+ files into a ~300-token topology JSON without truncation bias.
 */
export function buildDirectoryTopologySummary(nodes: GitHubNode[]): DirectoryTopologySummary {
  const configFilesSet = new Set<string>();
  const dirMap = new Map<string, { totalFiles: number; markdownCount: number; codeCount: number; samplePaths: string[] }>();

  for (const node of nodes) {
    if (node.type !== 'blob') continue;

    const parts = node.path.split('/');
    const fileName = parts.pop() || '';
    const pathLower = node.path.toLowerCase();

    // Collect root-level config files
    if (parts.length === 0 && MODULE_ROLE_PATTERNS.topologyConfigPatterns.some(p => p.test(fileName))) {
      configFilesSet.add(fileName);
    }

    // Determine directory key (up to top-2 folder levels deep; LLM 判断正文根/语言目录/
    // 内容块所需信息都在 1-2 级，更深结构由 samplePaths（完整路径）与 md 计数承担，
    // 且 2 级让 25 个目录名额覆盖更多顶级目录，避免被深层目录稀释)
    let dirKey = 'root/';
    if (parts.length > 0) {
      const depth = Math.min(parts.length, 2);
      dirKey = `${parts.slice(0, depth).join('/')}/`;
    }

    let stats = dirMap.get(dirKey);
    if (!stats) {
      stats = { totalFiles: 0, markdownCount: 0, codeCount: 0, samplePaths: [] };
      dirMap.set(dirKey, stats);
    }

    stats.totalFiles++;

    const ext = fileName.split('.').pop()?.toLowerCase() || '';
    const isMd = MODULE_ROLE_PATTERNS.markdownExtensions.some(mExt => pathLower.endsWith(mExt));
    const isCode = MODULE_ROLE_PATTERNS.topologyCodeExtensions.has(ext);

    if (isMd) stats.markdownCount++;
    if (isCode) stats.codeCount++;

    // Sample representative paths (up to 3, prioritizing Markdown)
    if (stats.samplePaths.length < 3) {
      stats.samplePaths.push(node.path);
    } else if (isMd && !stats.samplePaths.some(p => MODULE_ROLE_PATTERNS.markdownExtensions.some(mExt => p.toLowerCase().endsWith(mExt)))) {
      stats.samplePaths[0] = node.path;
    }
  }

  // Sort directories: top-level (depth-1) directories first so the content root
  // (book/, docs/, chapter1/) is never squeezed out of the 25-slot summary by
  // huge deeper buckets (e.g. chapter3/agentic-rag/ with 288 md); within the same
  // depth, Markdown-rich first, then by file count
  const depthOf = (key: string) => key.split('/').filter(Boolean).length;
  const sortedEntries = Array.from(dirMap.entries()).sort((a, b) => {
    const da = depthOf(a[0]);
    const db = depthOf(b[0]);
    if (da !== db) return da - db;
    if (b[1].markdownCount !== a[1].markdownCount) {
      return b[1].markdownCount - a[1].markdownCount;
    }
    return b[1].totalFiles - a[1].totalFiles;
  });

  const directories: Record<string, any> = {};
  for (const [key, stats] of sortedEntries.slice(0, 25)) {
    directories[key] = stats;
  }

  const totalMarkdownFiles = nodes.filter(n => {
    const l = n.path.toLowerCase();
    return n.type === 'blob' && MODULE_ROLE_PATTERNS.markdownExtensions.some(mExt => l.endsWith(mExt));
  }).length;

  return {
    totalNodes: nodes.length,
    totalMarkdownFiles,
    configFiles: Array.from(configFilesSet),
    directories,
  };
}

/**
 * 智能规模判定器已移除（REPO_INGEST_REDESIGN §5.2 收敛 → 2026-11 终局收刀）：
 * aiSniffRepo 生产链路从未接线，TS 侧规则判定器（computeRepoScale/
 * computeIngestMode/detectMonorepoVolumes）已随 2026-11 死代码清算退役。
 * 规模判定单一口径 = Go worker-sidecar sniffRepo（确定性规则 + 灰区 LLM 仲裁）。
 */

