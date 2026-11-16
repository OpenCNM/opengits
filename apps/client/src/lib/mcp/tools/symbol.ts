/**
 * repo-tools symbol 域：read_symbol 源码符号精确查询与代码切片直出。
 * 职责：按符号名（及可选文件路径）定位 AST 符号元数据、
 * 角色权重（Role/PageRank）、跨模块调用链与物理源码实现。
 */
import { executeSidecarSymbolLookup, executeSidecarSymbolSearch } from '@/engine/symbols-driver';
import { ENGINE_CONFIG } from '@/lib/config';
import { readSymbolSourceCode, extractSymbolSignature, detectSourceLanguage } from '@/lib/mcp/source-archive';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
  fallbackWarning,
} from './shared';

export interface ReadSymbolArgs {
  repository?: string;
  symbol?: string;
  file?: string;
  include_code?: boolean;
  include_callers?: boolean;
  aspect?: 'contract' | 'architecture' | 'implementation';
}

function roleDisplayLabel(role?: string): string {
  switch (role) {
    case 'core_contract':
      return 'Core Contract (核心契约)';
    case 'entry_point':
      return 'Entry Point (系统入口)';
    case 'pipeline_flow':
      return 'Pipeline Flow (流程管道)';
    case 'leaf_utility':
      return 'Leaf Utility (基础工具)';
    default:
      return role || 'Core Component';
  }
}

export async function runReadSymbol(
  args: ReadSymbolArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const rawSymbol = (args.symbol || '').trim();
  if (!rawSymbol) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `Error: "symbol" is required. Pass a code symbol name (e.g. "InitScheduler", "PageRank"). Use explore_concept(action="architecture") to inspect subsystem components and call flows.`,
        },
      ],
      isError: true,
    };
  }

  const rawFile = (args.file || '').trim();
  const includeCode = args.include_code !== false;
  const includeCallers = args.include_callers !== false;
  const sha = ctx.repository.gitSha || ctx.repository.defaultBranch || ENGINE_CONFIG.defaultBranch;

  // 1. 尝试通过 sidecar 查找符号详情
  let detail: any = null;
  if (ctx.repository.owner && ctx.repository.repo && sha) {
    try {
      const remote = await executeSidecarSymbolLookup({
        owner: ctx.repository.owner,
        repo: ctx.repository.repo,
        sha,
        name: rawSymbol,
        file: rawFile || undefined,
      });
      if (remote.ok && remote.found && remote.symbol) {
        detail = remote.symbol;
      }
    } catch {
      // Sidecar lookup gracefully fall through
    }
  }

  // 2. 若 sidecar 未命中，尝试从 repoProfile.codeClusters 提取
  const availableCandidates: string[] = [];
  let matchedChapterTitle = '';
  let matchedChapterOrder = 0;

  const repoProfile = ctx.repository.repoProfile as any;
  if (repoProfile && Array.isArray(repoProfile.codeClusters)) {
    for (const c of repoProfile.codeClusters) {
      if (c && c.cognitive) {
        if (Array.isArray(c.cognitive.goldenSymbols)) {
          for (const gs of c.cognitive.goldenSymbols) {
            availableCandidates.push(`${gs.name} (${gs.file})`);
            if (!detail && gs.name && gs.name.toLowerCase() === rawSymbol.toLowerCase()) {
              if (rawFile && !gs.file?.toLowerCase().includes(rawFile.toLowerCase())) {
                continue;
              }
              const callers: string[] = [];
              if (Array.isArray(c.cognitive.callFlow)) {
                for (const step of c.cognitive.callFlow) {
                  if (step.callee?.toLowerCase().includes(rawSymbol.toLowerCase()) && step.caller) {
                    callers.push(step.caller);
                  }
                }
              }
              detail = {
                name: gs.name,
                kind: gs.kind || 'function',
                file: gs.file || '',
                role: 'core_contract',
                pageRank: 0.05,
                importers: callers.length,
                callers,
              };
              matchedChapterTitle = c.title || '';
              matchedChapterOrder = c.teachingOrder || 0;
            }
          }
        }
      }
    }
  }

  // 3. 符号不存在
  if (!detail) {
    let text = `Error: Symbol "${rawSymbol}" not found in ${ctx.repository.owner}/${ctx.repository.repo}.`;
    if (availableCandidates.length > 0) {
      const unique = Array.from(new Set(availableCandidates)).slice(0, 8);
      text += `\n\nAvailable golden symbols in this repository:\n${unique.map((c) => `- ${c}`).join('\n')}`;
      text += `\n\n(Use explore_concept with action="architecture" to view subsystem component collaboration maps and call flows.)`;
    }
    return {
      telemetry: { dimension: 'symbols', query: rawSymbol, resultCount: 0 },
      content: [{ type: 'text' as const, text }],
      isError: true,
    };
  }

  // 4. 读取真实源码切片（归档直读；sha 未命中时按 branch 兜底，与 Go 原生路径同序）
  const aspect = ((args.aspect as string) || 'contract').toLowerCase();
  let sourceSnippet = '';
  if (includeCode && aspect !== 'architecture' && detail.file) {
    const branch = (ctx.repository.branch as string) || '';
    const startLine = Number(detail.startLine) || 0;
    const endLine = Number(detail.endLine) || 0;
    try {
      sourceSnippet = await readSymbolSourceCode(
        ctx.repository.owner,
        ctx.repository.repo,
        sha,
        detail.file,
        detail.name,
        startLine,
        endLine
      );
      if (!sourceSnippet && branch && branch !== sha) {
        sourceSnippet = await readSymbolSourceCode(
          ctx.repository.owner,
          ctx.repository.repo,
          branch,
          detail.file,
          detail.name,
          startLine,
          endLine
        );
      }
    } catch {
      sourceSnippet = '';
    }
  }

  // 5. 格式化输出 Markdown
  const lines: string[] = [];
  const kindStr = detail.kind || 'symbol';
  if (aspect === 'architecture') {
    lines.push(`${fallbackWarning(ctx)}# 🏛️ Architecture Role: \`${detail.name}\` (${kindStr})\n`);
  } else {
    lines.push(`${fallbackWarning(ctx)}# 🔍 Code Symbol: \`${detail.name}\` (${kindStr})\n`);
  }

  const lineInfo =
    detail.startLine && detail.endLine && detail.endLine >= detail.startLine
      ? ` (Lines ${detail.startLine}–${detail.endLine})`
      : '';
  lines.push(`- **File**: \`${detail.file}\`${lineInfo}`);
  lines.push(
    `- **Role**: \`${roleDisplayLabel(detail.role)}\`${
      detail.pageRank ? ` | **PageRank**: ${detail.pageRank.toFixed(3)}` : ''
    }${detail.importers ? ` | **Importers**: ${detail.importers}` : ''}`
  );

  if (includeCallers && Array.isArray(detail.callers) && detail.callers.length > 0) {
    lines.push(`- **Cross-Module Callers**: ${detail.callers.join(', ')}`);
  }

  if (matchedChapterTitle) {
    lines.push(
      matchedChapterOrder > 0
        ? `- **Curriculum Chapter**: Chapter ${matchedChapterOrder}: ${matchedChapterTitle}`
        : `- **Curriculum Chapter**: ${matchedChapterTitle}`
    );
  }

  if (aspect === 'architecture') {
    lines.push('\n*(Architecture mode: implementation code omitted. Pass aspect="contract" for type signatures, or aspect="implementation" for source code.)*');
  } else if (aspect === 'contract') {
    if (includeCode) {
      lines.push('\n### Type & Interface Contract\n');
      if (sourceSnippet) {
        const lang = detectSourceLanguage(detail.file);
        const sig = extractSymbolSignature(sourceSnippet, detail.name, lang) || sourceSnippet;
        lines.push(`\`\`\`${lang}\n${sig}\n\`\`\``);
        lines.push('\n*(Contract mode: body omitted to preserve context tokens. Pass aspect="implementation" for full source body, or aspect="architecture" for system context.)*');
      } else {
        lines.push('*(Source code archive file not found on disk; refer to file path above)*');
      }
    }
  } else {
    if (includeCode) {
      lines.push('\n### Source Implementation\n');
      if (sourceSnippet) {
        const lang = detectSourceLanguage(detail.file);
        lines.push(`\`\`\`${lang}\n${sourceSnippet}\n\`\`\``);
      } else {
        lines.push('*(Source code archive file not found on disk; refer to file path above)*');
      }
    }
  }

  return {
    telemetry: { dimension: 'symbols', query: rawSymbol, resultCount: 1 },
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

export interface SearchSymbolsArgs {
  repository?: string;
  query?: string;
  file?: string;
  role?: 'all' | 'core_contract' | 'entry_point' | 'pipeline_flow' | 'leaf_utility';
  limit?: number;
}

export async function runSearchSymbols(
  args: SearchSymbolsArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const startTime = Date.now();
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const rawQuery = (args.query || '').trim();
  const rawFile = (args.file || '').trim();
  const rawRole = (args.role || 'all').trim();
  const limit = Math.min(Math.max(args.limit || 10, 1), 30);
  const sha = ctx.repository.gitSha || ctx.repository.defaultBranch || ENGINE_CONFIG.defaultBranch;

  let results: any[] = [];

  // 1. 尝试通过 sidecar 执行拓扑模糊检索
  if (ctx.repository.owner && ctx.repository.repo && sha) {
    try {
      const remote = await executeSidecarSymbolSearch({
        owner: ctx.repository.owner,
        repo: ctx.repository.repo,
        sha,
        query: rawQuery,
        file: rawFile || undefined,
        roleFilter: rawRole !== 'all' ? rawRole : undefined,
        limit,
      });
      if (remote.ok && Array.isArray(remote.symbols) && remote.symbols.length > 0) {
        results = remote.symbols;
      }
    } catch {
      // Sidecar search gracefully fall through
    }
  }

  // 2. 若 sidecar 未命中或离线，回退到 repoProfile.codeClusters 提取
  if (results.length === 0) {
    const repoProfile = ctx.repository.repoProfile as any;
    if (repoProfile && Array.isArray(repoProfile.codeClusters)) {
      const qLower = rawQuery.toLowerCase();
      const seen = new Set<string>();

      for (const c of repoProfile.codeClusters) {
        if (c && c.cognitive && Array.isArray(c.cognitive.goldenSymbols)) {
          for (const gs of c.cognitive.goldenSymbols) {
            const fClean = (gs.file || '').toLowerCase();
            if (rawFile && !fClean.includes(rawFile.toLowerCase())) {
              continue;
            }
            const nameLower = (gs.name || '').toLowerCase();
            const key = `${fClean}@${nameLower}`;
            if (seen.has(key)) continue;

            const match = !rawQuery || nameLower.includes(qLower);
            if (!match) continue;

            const callers: string[] = [];
            if (Array.isArray(c.cognitive.callFlow)) {
              for (const step of c.cognitive.callFlow) {
                if (step.callee?.toLowerCase().includes(nameLower) && step.caller) {
                  callers.push(step.caller);
                }
              }
            }

            results.push({
              name: gs.name,
              kind: gs.kind || 'function',
              file: gs.file || '',
              role: 'core_contract',
              pageRank: 0.05,
              importers: callers.length,
              callers,
            });
            seen.add(key);
            if (results.length >= limit) break;
          }
        }
        if (results.length >= limit) break;
      }
    }
  }

  // 3. 检索结果为空
  if (results.length === 0) {
    let text = rawQuery
      ? `No symbols found matching query "${rawQuery}" in ${ctx.repository.owner}/${ctx.repository.repo}.`
      : `No symbols found in ${ctx.repository.owner}/${ctx.repository.repo}.`;
    if (rawFile) {
      text += ` (filtered by file "${rawFile}")`;
    }
    text += `\n\n(Tip: Call search_symbols without query to see top architectural anchors, or use outline to explore document structure.)`;
    return {
      telemetry: { dimension: 'symbols', query: rawQuery, resultCount: 0 },
      content: [{ type: 'text' as const, text }],
    };
  }

  // 4. 格式化输出 Markdown
  const lines: string[] = [];
  if (rawQuery) {
    lines.push(`${fallbackWarning(ctx)}# 🔎 Symbol Search: "${rawQuery}" in ${ctx.repository.owner}/${ctx.repository.repo} (Found ${results.length})\n`);
  } else {
    lines.push(`# 🏛️ Top Architectural Symbols in ${ctx.repository.owner}/${ctx.repository.repo} (Found ${results.length})\n`);
  }

  for (const sym of results) {
    const kind = sym.kind || 'function';
    lines.push(`### \`${sym.name}\` (${kind})`);
    const lineInfo =
      sym.startLine && sym.endLine && sym.endLine >= sym.startLine
        ? ` (Lines ${sym.startLine}–${sym.endLine})`
        : '';
    const roleStr = roleDisplayLabel(sym.role);
    const prStr = sym.pageRank ? ` | **PageRank**: ${sym.pageRank.toFixed(3)}` : '';
    const impStr = sym.importers ? ` | **Importers**: ${sym.importers}` : '';
    lines.push(`- **File**: \`${sym.file}\`${lineInfo} | **Role**: \`${roleStr}\`${prStr}${impStr}`);
    if (Array.isArray(sym.callers) && sym.callers.length > 0) {
      lines.push(`- **Cross-Module Callers**: ${sym.callers.join(', ')}`);
    }
    lines.push(`- 👉 Inspect signature: \`read_symbol(symbol="${sym.name}", aspect="contract")\`\n`);
  }

  lines.push('*(Tip: Pass aspect="contract" to read_symbol for lightweight type signature (~80% token savings), or aspect="implementation" for full source code.)*');

  return {
    telemetry: { dimension: 'symbols', query: rawQuery, resultCount: results.length },
    content: [{ type: 'text' as const, text: lines.join('\n') }],
  };
}

