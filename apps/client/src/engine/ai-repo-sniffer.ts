import { z } from 'zod';
import { MODULE_ROLE_PATTERNS } from './language-map';
import type { GitHubNode } from './fetcher';

const codebaseTutorialBlueprintSchema = z.object({
  primaryLanguages: z.array(z.string()).describe("Primary programming languages used, for syntax highlighting in generated tutorial code blocks"),
  framework: z.string().optional().describe("Core framework or library name for tutorial technical background context"),
  entryPoints: z.array(z.string()).describe("Key entry point file paths (e.g., src/index.ts, cmd/main.go) to map into 'Getting Started & System Entry' tutorial chapters"),
  coreModules: z.array(z.string()).describe("Key source modules or component directories to map into 'Core Architecture & Component Analysis' tutorial chapters"),
  examplePaths: z.array(z.string()).describe("Sample, demo, or usage example file paths to map into 'Hands-on Examples & Practice' tutorial chapters"),
});

// Per-field .catch() prevents fast-model drift on a single field from failing the entire repository sniff.
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

export function buildDirectoryTopologySummary(nodes: GitHubNode[]): DirectoryTopologySummary {
  const configFilesSet = new Set<string>();
  const dirMap = new Map<string, { totalFiles: number; markdownCount: number; codeCount: number; samplePaths: string[] }>();

  for (const node of nodes) {
    if (node.type !== 'blob') continue;

    const parts = node.path.split('/');
    const fileName = parts.pop() || '';
    const pathLower = node.path.toLowerCase();

    if (parts.length === 0 && MODULE_ROLE_PATTERNS.topologyConfigPatterns.some(p => p.test(fileName))) {
      configFilesSet.add(fileName);
    }

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

    if (stats.samplePaths.length < 3) {
      stats.samplePaths.push(node.path);
    } else if (isMd && !stats.samplePaths.some(p => MODULE_ROLE_PATTERNS.markdownExtensions.some(mExt => p.toLowerCase().endsWith(mExt)))) {
      stats.samplePaths[0] = node.path;
    }
  }

  // Sort depth-1 directories first so deep buckets never evict top-level content roots from the 25-slot summary cap.
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
