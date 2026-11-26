import { executeSidecarDissectAst } from '@/engine/dissect-driver';
import { readSymbolSourceCode, detectSourceLanguage } from '@/lib/mcp/source-archive';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
} from './shared';

export interface DissectCodeArgs {
  repository?: string;
  path?: string;
  symbol?: string;
  start_line?: number;
  end_line?: number;
}

const DISSECT_INPUT_MAX_CHARS = 20_000;

export async function runDissectCode(
  args: DissectCodeArgs,
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
          text: 'Error: "path" is required. Pass a repository-relative source file path (e.g. "internal/scheduler/timer.go"). Use search_symbols or outline to locate files first.',
        },
      ],
      isError: true,
    };
  }

  const owner = ctx.repository.owner as string;
  const repo = ctx.repository.repo as string;
  const sha = (ctx.repository.gitSha as string) || (ctx.repository.branch as string) || '';

  const symbol = (args.symbol || '').trim();
  const startLine = Number(args.start_line) > 0 ? Math.floor(Number(args.start_line)) : 0;
  const endLine = Number(args.end_line) > 0 ? Math.floor(Number(args.end_line)) : 0;

  let source = '';
  try {
    source = await readSymbolSourceCode(owner, repo, sha, rawPath, symbol, startLine, endLine);
  } catch {
    source = '';
  }
  if (!source) {
    return {
      telemetry: { dimension: 'source', query: rawPath, resultCount: 0 },
      content: [
        {
          type: 'text' as const,
          text: `File not found in local source archive: ${rawPath}. Use read_source_file to check the exact path first.`,
        },
      ],
      isError: true,
    };
  }
  if (source.length > DISSECT_INPUT_MAX_CHARS) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: source slice too large for dissection (${source.length} chars > ${DISSECT_INPUT_MAX_CHARS}). Pass start_line/end_line or symbol to narrow the window.`,
        },
      ],
      isError: true,
    };
  }

  const lang = detectSourceLanguage(rawPath);
  const result = await executeSidecarDissectAst({ code: source, language: lang });

  const lines: string[] = [`# 🔬 Code Dissection: \`${rawPath}\`${symbol ? ` (symbol: ${symbol})` : ''}`, ''];
  lines.push('```mermaid');
  lines.push(result.mermaidCode);
  lines.push('```');
  lines.push(
    `\n(AST tier: ${result.isAst ? 'tree-sitter' : 'heuristic fallback (approximate)'}; pass start_line/end_line to narrow the dissection window.)`
  );

return {
      telemetry: { dimension: 'source', query: rawPath, resultCount: 1 }, content: [{ type: 'text' as const, text: lines.join('\n') }] };
}
