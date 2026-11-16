/**
 * repo-tools source-file 域：原始源码文件读取（path + 可选行区间）。
 * 数据源为本地解压归档直读（与 Web /api/code file 路由、Go ARCHIVE_ROOT 同卷），
 * 不走网络回源——MCP 服务的仓必为本平台导入归档仓，缺失即显式降级提示（失效封闭）。
 */
import { readFileLocal } from '@/engine/tarball/archive-store';
import { detectLanguage } from '@/engine/languages';
import { cleanSourcePath } from '@/lib/mcp/source-archive';
import { capFullDocText } from './read';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
} from './shared';

export interface ReadSourceFileArgs {
  repository?: string;
  path?: string;
  start_line?: number;
  end_line?: number;
}

function detectFenceLanguage(path: string): string {
  const langEntry = detectLanguage(path);
  if (!langEntry) return 'text';
  // detectLanguage 返回展示名（TypeScript/Go/Python…），围栏标识统一小写
  return langEntry.name.toLowerCase().replace(/[^a-z0-9+#]/g, '');
}

export async function runReadSourceFile(
  args: ReadSourceFileArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const rawPath = (args.path || '').trim();
  if (!rawPath) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: "path" is required. Pass a repository-relative file path (e.g. "internal/search/store_chunks.go"). Use outline or read_symbol to locate files first.',
        },
      ],
      isError: true,
    };
  }

  const cleanPath = cleanSourcePath(rawPath);
  if (!cleanPath) {
    return {
      content: [{ type: 'text' as const, text: `Error: Invalid or unsafe file path: ${rawPath}` }],
      isError: true,
    };
  }

  const startLine = Number(args.start_line) > 0 ? Math.floor(Number(args.start_line)) : 0;
  const endLine = Number(args.end_line) > 0 ? Math.floor(Number(args.end_line)) : 0;
  if ((args.start_line !== undefined && startLine <= 0) || (args.end_line !== undefined && endLine <= 0)) {
    return {
      content: [{ type: 'text' as const, text: 'Error: "start_line" and "end_line" must be positive integers (1-based).' }],
      isError: true,
    };
  }
  if (startLine > 0 && endLine > 0 && endLine < startLine) {
    return {
      content: [{ type: 'text' as const, text: `Error: end_line (${endLine}) must be >= start_line (${startLine}).` }],
      isError: true,
    };
  }

  const owner = ctx.repository.owner as string;
  const repo = ctx.repository.repo as string;
  const sha = (ctx.repository.gitSha as string) || '';
  const branch = (ctx.repository.branch as string) || '';

  // 归档直读：gitSha 优先，未命中按 branch 兜底（与 read_symbol 同序）
  let content: string | null = null;
  let usedRef = '';
  for (const ref of [sha, branch].filter(Boolean)) {
    try {
      const local = await readFileLocal(owner, repo, ref, cleanPath);
      if (local !== null) {
        content = local;
        usedRef = ref;
        break;
      }
    } catch {
      // 归档读取失败继续尝试下一 ref
    }
  }

  if (content === null) {
    

    return {
      telemetry: { dimension: 'source', query: cleanPath, resultCount: 0 },
      content: [
        {
          type: 'text' as const,
          text: `File not found in local source archive: ${cleanPath} (tried ref: ${[sha, branch].filter(Boolean).join(', ') || 'none'}). The archive for this repository may be evicted; use read_symbol for symbol-level slices or check the exact path via outline.`,
        },
      ],
      isError: true,
    };
  }

  const totalLines = content.split('\n').length;
  let body = content;
  let rangeInfo = '';
  if (startLine > 0) {
    if (startLine > totalLines) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: start_line (${startLine}) exceeds file length (${totalLines} lines): ${cleanPath}`,
          },
        ],
        isError: true,
      };
    }
    const clampedEnd = Math.min(endLine || totalLines, totalLines);
    body = content.split('\n').slice(startLine - 1, clampedEnd).join('\n');
    rangeInfo = ` (Lines ${startLine}–${clampedEnd} of ${totalLines})`;
  }

  const lang = detectFenceLanguage(cleanPath);
  const header = `# 📄 Source File: \`${cleanPath}\`${rangeInfo} [${usedRef}]`;
  const codeBlock = `\`\`\`${lang}\n${capFullDocText(body)}\n\`\`\``;
  const footer =
    startLine === 0 && totalLines > 400
      ? '\n*(Long file: output capped. Pass start_line/end_line for a targeted window.)*'
      : '';

  

  return {
      telemetry: { dimension: 'source', query: cleanPath, resultCount: 1 },
    content: [{ type: 'text' as const, text: `${header}\n\n${codeBlock}${footer}` }],
  };
}
