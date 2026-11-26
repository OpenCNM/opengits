import { executeSidecarSymbolLookup, SymbolLookupDetail } from '@/engine/symbols-driver';
import { ignoreBestEffort } from '@/lib/best-effort';
import { readFileLocal } from '@/engine/tarball/archive-store';
import {
  readSymbolSourceCode,
  extractSymbolSignature,
  detectSourceLanguage,
  cleanSourcePath,
} from '@/lib/mcp/source-archive';
import { extractGroundingFacts } from '@/lib/mcp/grounding-beacon';
import {
  RepoRuntime,
  resolveScopedTarget,
  refNotFoundError,
  scopeRequiredError,
} from './shared';

export interface VerifyClaimArgs {
  repository?: string;
  claim?: string;
  symbol?: string;
  file?: string;
}

export type ClaimVerdict = 'VERIFIED_TRUE' | 'REFUTED_FALSE' | 'AMBIGUOUS';

export interface ClaimEvaluation {
  verdict: ClaimVerdict;
  summary: string;
  signature?: string;
  codeSnippet?: string;
  startLine?: number;
  endLine?: number;
  matchedFile?: string;
  matchedSymbol?: string;
}

export function isNegativeAssertion(text: string): boolean {
  return (
    /\b(?:not|does\s+not|doesn't|did\s+not|didn't|cannot|can't|no\s+longer|never|isn't|aren't|without|neither|nor|removed|deleted)\b/i.test(text) ||
    /(?:不|未|没|已删除|不存在|未定义|不再|无)/.test(text)
  );
}

export function isValidTypeIdentifier(token: string): boolean {
  const t = token.trim();
  if (!t) return false;

  if (/\b(?:the|a|an|some|all|its|their|nothing|parsed|valid)\b/i.test(t)) {
    return false;
  }

  if (/\b(?:value|data|object|result|success|failure)\b/.test(t)) {
    return false;
  }

  if (t.startsWith('(') && t.endsWith(')')) {
    const inner = t.slice(1, -1).trim();
    if (!inner) return false;
    const parts: string[] = [];
    let cur = '';
    let nest = 0;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '(' || ch === '<' || ch === '[' || ch === '{') nest++;
      else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') nest--;
      if (ch === ',' && nest === 0) {
        if (cur.trim()) parts.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
    return parts.length > 0 && parts.every((p) => isValidTypeIdentifier(p));
  }

  let stripped = t;
  stripped = stripped.replace(/^[*&]+/, '').trim();
  stripped = stripped.replace(/^(?:<-\s*chan\b|chan\s*<-\b|chan\b)\s*/, '').trim();
  while (/^\[\s*\d*\s*\]/.test(stripped)) {
    stripped = stripped.replace(/^\[\s*\d*\s*\]/, '').trim();
  }
  stripped = stripped.replace(/^[*&]+/, '').trim();

  if (/^(?:interface|struct)\s*\{\s*\}$/.test(stripped)) {
    return true;
  }

  if (/^map\s*\[[^\]]+\]/.test(stripped)) {
    const afterKey = stripped.replace(/^map\s*\[[^\]]+\]\s*/, '');
    return afterKey.length === 0 || isValidTypeIdentifier(afterKey);
  }

  return /^([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*(?:\s*<[^>]+>)?(?:\s*\[\s*\])*$/.test(stripped);
}

const WORD_TO_NUMBER: Record<string, number> = {
  zero: 0,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  零: 0,
  一: 1,
  两: 2,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
  no: 0,
};

export function parseSignatureParams(signature: string, lang = ''): {
  rawParams: string[];
  callerParamCount: number;
  returnSection: string;
  hasParamSignature: boolean;
} {
  if (!signature) return { rawParams: [], callerParamCount: 0, returnSection: '', hasParamSignature: false };

  let firstParen = signature.indexOf('(');
  if (firstParen < 0) return { rawParams: [], callerParamCount: 0, returnSection: '', hasParamSignature: false };

  const beforeFirstParen = signature.slice(0, firstParen).trim();
  if (/(?:^|\s)func$/.test(beforeFirstParen)) {
    let rDepth = 0;
    let rClose = -1;
    for (let i = firstParen; i < signature.length; i++) {
      if (signature[i] === '(') rDepth++;
      else if (signature[i] === ')') {
        rDepth--;
        if (rDepth === 0) {
          rClose = i;
          break;
        }
      }
    }
    if (rClose > firstParen) {
      const afterReceiver = signature.slice(rClose + 1);
      const methodMatch = afterReceiver.match(/^\s*(?!func\b)[a-zA-Z0-9_$]+\s*\(/);
      if (methodMatch) {
        firstParen = rClose + 1 + afterReceiver.indexOf('(');
      }
    }
  }

  let depth = 0;
  let inParen = false;
  let closeParen = -1;

  for (let i = firstParen; i < signature.length; i++) {
    const ch = signature[i];
    if (ch === '(') {
      depth++;
      inParen = true;
    } else if (ch === ')') {
      depth--;
      if (depth === 0 && inParen) {
        closeParen = i;
        break;
      }
    }
  }

  if (closeParen <= firstParen) return { rawParams: [], callerParamCount: 0, returnSection: '', hasParamSignature: false };

  const paramContent = signature.slice(firstParen + 1, closeParen).trim();

  const params: string[] = [];
  if (paramContent && paramContent !== 'void') {
    let cur = '';
    let nest = 0;

    for (let i = 0; i < paramContent.length; i++) {
      const ch = paramContent[i];
      if (ch === '(' || ch === '<' || ch === '[' || ch === '{') nest++;
      else if (ch === ')' || ch === '>' || ch === ']' || ch === '}') nest--;

      if (ch === ',' && nest === 0) {
        if (cur.trim()) params.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    if (cur.trim()) params.push(cur.trim());
  }

  let callerParamCount = params.length;
  if (lang === 'python' && params.length > 0) {
    const firstLower = params[0].toLowerCase();
    if (firstLower === 'self' || firstLower === 'cls' || firstLower.startsWith('self:') || firstLower.startsWith('cls:')) {
      callerParamCount = params.length - 1;
    }
  }

  let returnSection = signature.slice(closeParen + 1).replace(/\{[\s\S]*$/, '').trim();
  returnSection = returnSection.replace(/^[:\-]\s*/, '').replace(/^>\s*/, '').trim();

  return { rawParams: params, callerParamCount, returnSection, hasParamSignature: true };
}

export const parseFunctionSignature = parseSignatureParams;

export function evaluateClaimAgainstEvidence(opts: {
  claim: string;
  symbol?: string;
  file?: string;
  signature?: string;
  sourceCode: string;
  symbolDetail?: SymbolLookupDetail | null;
  lang: string;
}): ClaimEvaluation {
  const { claim, symbol, file, signature = '', sourceCode, symbolDetail, lang } = opts;
  const cleanClaim = claim.trim();
  const lowerClaim = cleanClaim.toLowerCase();

  const { rawParams, callerParamCount, returnSection, hasParamSignature } = parseSignatureParams(signature, lang);
  const paramListText = rawParams.length > 0 ? `(${rawParams.join(', ')})` : '()';

  const paramCountMatch =
    cleanClaim.match(/\b(?:takes|taking|accepts|has|receives|requires|with|need)\s+(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|no)\s*(?:arguments?|params?|parameters?|args?)\b/i) ||
    cleanClaim.match(/(?:接收|接受|需要|包含|有|传)\s*(\d+|零|一|两|二|三|四|五|六|七|八|九|十)\s*个?(?:参数|入参)/) ||
    cleanClaim.match(/\b(?:no|0)\s*(?:arguments?|params?|parameters?|args?)\b|零\s*个?参数/i) ||
    cleanClaim.match(/\b(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:arguments?|params?|parameters?|args?|个参数)\b/i);

  if (paramCountMatch && signature && hasParamSignature) {
    const numToken = paramCountMatch[1]?.toLowerCase() || (paramCountMatch[0].includes('no') ? '0' : '0');
    const claimedCount = WORD_TO_NUMBER[numToken] ?? parseInt(numToken, 10);

    if (!isNaN(claimedCount)) {
      if (callerParamCount === claimedCount) {
        return {
          verdict: 'VERIFIED_TRUE',
          summary: `Claim correctly asserts ${claimedCount} parameter(s). Physical AST signature confirms ${callerParamCount} parameter(s): ${paramListText}.`,
          signature,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      } else {
        return {
          verdict: 'REFUTED_FALSE',
          summary: `Claim incorrectly asserts ${claimedCount} parameter(s), but physical AST signature shows ${callerParamCount} parameter(s): ${paramListText}.`,
          signature,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      }
    }
  }

  const specificParamMatch =
    cleanClaim.match(/(?:takes|accepts|has|requires|contains)\s+(?:a |an )?(?:parameter|argument)?\s*[`"']?([a-zA-Z_$][a-zA-Z0-9_$.*&]+)[`"']?\s*(?:parameter|argument)?/i) ||
    cleanClaim.match(/(?:接收|接受|需要|包含)\s*[`"']?([a-zA-Z_$][a-zA-Z0-9_$.*&]+)[`"']?\s*(?:参数|入参)/);

  if (specificParamMatch && rawParams.length > 0) {
    const targetToken = specificParamMatch[1];
    const escapedToken = targetToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const tokenRegex = new RegExp(`(^|[^a-zA-Z0-9_$])${escapedToken}([^a-zA-Z0-9_$]|$)`, 'i');
    const foundInParams = rawParams.some((p) => tokenRegex.test(p));
    const isNegative = isNegativeAssertion(cleanClaim);

    if (foundInParams) {
      if (isNegative) {
        return {
          verdict: 'REFUTED_FALSE',
          summary: `Claim asserts parameter "${targetToken}" is not present, but it exists in physical signature: ${paramListText}.`,
          signature,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      } else {
        return {
          verdict: 'VERIFIED_TRUE',
          summary: `Claim verified: parameter matching "${targetToken}" exists in physical signature: ${paramListText}.`,
          signature,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      }
    } else if (isNegative && rawParams.length > 0) {
      return {
        verdict: 'VERIFIED_TRUE',
        summary: `Claim confirmed: parameter "${targetToken}" is not present in physical signature: ${paramListText}.`,
        signature,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    }
  }

  const returnMatch =
    cleanClaim.match(/(?:returns?|returning|result is)\s*(?:an?\s+)?([*&a-zA-Z0-9_<>\[\],\s\(\)]+?)(?:\s+(?:on|when|if|as|in|with)|$|\.|\;)/i) ||
    cleanClaim.match(/(?:返回|产出)\s*(?:一个\s*)?([*&a-zA-Z0-9_<>\[\],\s\(\)]+?)(?:\s*(?:值|结果)|$|\.|\;)/);

  if (returnMatch && signature) {
    const rawCaptured = returnMatch[1].trim();
    const rawExpectedReturn = rawCaptured.toLowerCase();
    const effectiveReturn = returnSection || 'void';
    const lowerEffectiveReturn = effectiveReturn.toLowerCase();

    const expectedTokens = rawExpectedReturn === 'error' ? ['error', 'err', 'result<', 'failure'] : [rawExpectedReturn];
    let hasMatch = expectedTokens.some((tok) => {
      if (lowerEffectiveReturn.includes(tok)) return true;
      return lowerEffectiveReturn.replace(/\s+/g, '').includes(tok.replace(/\s+/g, ''));
    });

    if (!hasMatch && rawCaptured.includes(' ')) {
      const words = rawCaptured
        .split(/\s+/)
        .map((w) => w.toLowerCase().replace(/[^a-z0-9_]/g, ''))
        .filter((w) => !['the', 'a', 'an', 'on', 'in', 'parsed', 'returned', 'new', 'value', 'data', 'result'].includes(w) && w.length >= 3);
      hasMatch = words.some((w) => lowerEffectiveReturn.includes(w));
    }

    if (hasMatch) {
      return {
        verdict: 'VERIFIED_TRUE',
        summary: `Claim verified: physical return signature matches assertion "${rawCaptured}": ${effectiveReturn}`,
        signature,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    } else if (isValidTypeIdentifier(rawCaptured)) {
      return {
        verdict: 'REFUTED_FALSE',
        summary: `Claim asserts return type "${rawCaptured}", but physical signature returns: ${effectiveReturn}`,
        signature,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    }
  }

  const memberMatch =
    cleanClaim.match(/\b(?:has|have|had|contains?|defines?|defined|declares?|declared|includes?|拥有|包含|定义|声明)(?:\s+(?:a|an|the))?\s+(?:field|method|property|function|member|字段|方法|属性)\s+[`"']?([a-zA-Z0-9_$]+)[`"']?/i) ||
    cleanClaim.match(/[`"']?([a-zA-Z0-9_$]+)[`"']?\s+(?:field|method|property|字段|方法|属性)/i);

  if (memberMatch && sourceCode) {
    let memberName = memberMatch[1];
    if (/\b(?:has|have|had|contain|contains|define|defines|declare|declares|include|includes|does|not|the|a|an)\b/i.test(memberName)) {
      const followMatch = cleanClaim.match(/(?:field|method|property|function|member|字段|方法|属性)\s+[`"']?([a-zA-Z0-9_$]+)[`"']?/i);
      if (followMatch && followMatch[1]) {
        memberName = followMatch[1];
      }
    }
    const isMethodAssertion = /(?:method|function|方法)/i.test(cleanClaim);
    const memberRegex = new RegExp(`\\b${memberName}\\b`);
    const isNegative = isNegativeAssertion(cleanClaim);
    if (memberRegex.test(sourceCode)) {
      if (isNegative) {
        return {
          verdict: 'REFUTED_FALSE',
          summary: `Claim asserts identifier "${memberName}" does not exist, but it is physically declared in ${file || 'target source slice'}.`,
          signature: signature || undefined,
          codeSnippet: sourceCode,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      } else {
        return {
          verdict: 'VERIFIED_TRUE',
          summary: `Physical code inspection confirmed: identifier "${memberName}" is declared in ${file || 'target source slice'}.`,
          signature: signature || undefined,
          codeSnippet: sourceCode,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      }
    } else if (isNegative) {
      if (lang === 'go' && isMethodAssertion) {
        return {
          verdict: 'AMBIGUOUS',
          summary: `In Go, methods are declared outside struct bodies. Identifier "${memberName}" was not found in the inspected slice, but its absence across the package cannot be confirmed.`,
          signature: signature || undefined,
          codeSnippet: sourceCode,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      }
      return {
        verdict: 'VERIFIED_TRUE',
        summary: `Claim confirmed: identifier "${memberName}" is not declared in ${file || 'target source slice'}.`,
        signature: signature || undefined,
        codeSnippet: sourceCode,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    } else {
      if (lang === 'go' && isMethodAssertion) {
        return {
          verdict: 'AMBIGUOUS',
          summary: `In Go, methods are declared outside struct bodies. Identifier "${memberName}" was not found in ${file || 'target source slice'}, but may reside in other package files.`,
          signature: signature || undefined,
          codeSnippet: sourceCode,
          matchedFile: file,
          matchedSymbol: symbol,
        };
      }
      return {
        verdict: 'REFUTED_FALSE',
        summary: `Claim refuted: identifier "${memberName}" is not declared in ${file || 'target source slice'}.`,
        signature: signature || undefined,
        codeSnippet: sourceCode,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    }
  }

  if (
    symbol &&
    (lowerClaim.includes('exist') || lowerClaim.includes('defined') || lowerClaim.includes('存在') || lowerClaim.includes('定义'))
  ) {
    const isNegative = isNegativeAssertion(cleanClaim);
    if (symbolDetail || signature || sourceCode) {
      if (isNegative) {
        return {
          verdict: 'REFUTED_FALSE',
          summary: `Claim asserts symbol "${symbol}" does not exist, but it is physically defined in ${file || symbolDetail?.file || 'the repository'}.`,
          signature: signature || undefined,
          matchedFile: file || symbolDetail?.file,
          matchedSymbol: symbol,
        };
      } else {
        return {
          verdict: 'VERIFIED_TRUE',
          summary: `Symbol "${symbol}" is physically defined in ${file || symbolDetail?.file || 'the repository'}.`,
          signature: signature || undefined,
          matchedFile: file || symbolDetail?.file,
          matchedSymbol: symbol,
        };
      }
    }
  }

  const literalMatch = cleanClaim.match(/[`"']([^`"']{3,60})[`"']/);
  if (literalMatch && sourceCode) {
    const literal = literalMatch[1];
    if (sourceCode.includes(literal)) {
      return {
        verdict: 'VERIFIED_TRUE',
        summary: `Physical source contains exact literal pattern "${literal}".`,
        codeSnippet: sourceCode,
        signature: signature || undefined,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    }
  }

  return {
    verdict: 'AMBIGUOUS',
    summary:
      'The claim describes behavioral, architectural, or runtime semantics that cannot be conclusively determined by signature alone. Refer to the physical source evidence below.',
    signature: signature || undefined,
    codeSnippet: sourceCode,
    matchedFile: file,
    matchedSymbol: symbol,
  };
}

function formatVerificationOutput(ev: ClaimEvaluation, opts: {
  claim: string;
  gitSha?: string | null;
  lang: string;
}): string {
  const { claim, gitSha, lang } = opts;
  const shortSha = gitSha && typeof gitSha === 'string' && gitSha.trim() ? gitSha.trim().slice(0, 7) : 'HEAD';

  const lines: string[] = [
    `# ⚖️ Claim Verification: \`${ev.verdict}\``,
    '',
    `- **Claim**: "${claim}"`,
    `- **Verdict**: **${ev.verdict}**`,
    `- **Target**: ${ev.matchedSymbol ? `\`${ev.matchedSymbol}\`` : 'N/A'}${ev.matchedFile ? ` in \`${ev.matchedFile}\`` : ''}`,
    `- **Finding**: ${ev.summary}`,
    '',
    `### 📜 Physical Evidence (L2 Ground Truth · ${shortSha})`,
  ];

  if (ev.signature) {
    lines.push(`\`\`\`${lang}`);
    lines.push(ev.signature.trim());
    lines.push('```');
  } else if (ev.codeSnippet) {
    const fenceLang = lang || 'text';
    const titleAttr = ev.matchedFile ? ` title="${ev.matchedFile}"` : '';
    lines.push(`\`\`\`${fenceLang}${titleAttr}`);
    lines.push(ev.codeSnippet.trim());
    lines.push('```');
  } else {
    lines.push(`*(No matching physical code or AST symbol found in repository archive)*`);
  }

  return lines.join('\n');
}

export async function runVerifyClaim(
  args: VerifyClaimArgs,
  runtime: RepoRuntime,
  telemetryRepositoryId?: string
) {
  const ctx = await resolveScopedTarget(runtime, args.repository);
  if (!ctx) {
    return args.repository ? refNotFoundError(args.repository, runtime) : scopeRequiredError(runtime);
  }

  const rawClaim = (args.claim || '').trim();
  if (!rawClaim) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: "claim" is required. Pass a specific assertion to verify (e.g. "VerifyToken takes 3 arguments", "WorkerPool has Stop method").',
        },
      ],
      isError: true,
    };
  }

  let rawSymbol = (args.symbol || '').trim();
  let rawFile = (args.file || '').trim();

  if (!rawSymbol && !rawFile) {
    const extracted = extractGroundingFacts(rawClaim);
    if (extracted.symbols.length > 0) {
      rawSymbol = extracted.symbols[0];
    }
    if (extracted.sourceFiles.length > 0) {
      rawFile = extracted.sourceFiles[0];
    }
  }

  if (!rawSymbol && !rawFile) {
    return {
      content: [
        {
          type: 'text' as const,
          text: 'Error: At least one of "symbol" or "file" is required to anchor physical AST verification. Pass symbol="..." (e.g. "VerifyToken") or file="..." (e.g. "src/auth/token.ts").',
        },
      ],
      isError: true,
    };
  }

  if (rawFile) {
    const cleaned = cleanSourcePath(rawFile);
    if (!cleaned) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: Invalid or unsafe file path: ${rawFile}`,
          },
        ],
        isError: true,
      };
    }
    rawFile = cleaned;
  }

  const owner = (ctx.repository.owner as string) || '';
  const repo = (ctx.repository.repo as string) || '';
  const sha = (ctx.repository.gitSha as string) || (ctx.repository.branch as string) || '';

  let symbolDetail: SymbolLookupDetail | null = null;
  let sidecarLookupAttempted = false;
  let sidecarLookupHealthy = false;
  let sidecarLookupError: string | null = null;

  if (owner && repo && sha && rawSymbol) {
    sidecarLookupAttempted = true;
    try {
      const remote = await executeSidecarSymbolLookup({
        owner,
        repo,
        sha,
        name: rawSymbol,
        file: rawFile || undefined,
      });
      if (remote.ok) {
        sidecarLookupHealthy = true;
        if (remote.found && remote.symbol) {
          symbolDetail = remote.symbol;
        }
      } else {
        sidecarLookupError = remote.error || 'Sidecar lookup returned un-ok status';
      }
    } catch (err: any) {
      sidecarLookupError = err?.message || 'Sidecar lookup unreachable';
    }
  }

  if (!symbolDetail && rawSymbol) {
    const repoProfile = ctx.repository.repoProfile as any;
    if (repoProfile && Array.isArray(repoProfile.codeClusters)) {
      for (const c of repoProfile.codeClusters) {
        if (c?.cognitive && Array.isArray(c.cognitive.goldenSymbols)) {
          for (const gs of c.cognitive.goldenSymbols) {
            if (gs.name && gs.name.toLowerCase() === rawSymbol.toLowerCase()) {
              if (rawFile && gs.file && !gs.file.toLowerCase().includes(rawFile.toLowerCase())) {
                continue;
              }
              symbolDetail = {
                name: gs.name,
                kind: gs.kind || 'function',
                file: gs.file || rawFile || '',
                role: 'core_contract',
                pageRank: 0.05,
                importers: 0,
                callers: [],
                startLine: gs.startLine || 0,
                endLine: gs.endLine || 0,
              };
              break;
            }
          }
        }
        if (symbolDetail) break;
      }
    }
  }

  const targetFile = rawFile || symbolDetail?.file || '';
  let sourceCode = '';

  if (targetFile) {
    const startLine = symbolDetail?.startLine || 0;
    const endLine = symbolDetail?.endLine || 0;
    try {
      sourceCode = await readSymbolSourceCode(owner, repo, sha, targetFile, rawSymbol, startLine, endLine);
    } catch {
      ignoreBestEffort();
      sourceCode = '';
    }
  }

  if (!symbolDetail && !sourceCode) {
    if (rawSymbol) {
      if (sidecarLookupAttempted && !sidecarLookupHealthy) {
        const evalResult: ClaimEvaluation = {
          verdict: 'AMBIGUOUS',
          summary: `Physical AST symbol lookup service was unreachable or errored (${sidecarLookupError || 'lookup failed'}). Cannot conclusively prove or refute whether "${rawSymbol}" exists.`,
          matchedSymbol: rawSymbol,
          matchedFile: rawFile || undefined,
        };
        const text = formatVerificationOutput(evalResult, {
          claim: rawClaim,
          gitSha: sha,
          lang: 'text',
        });
        return {
          telemetry: { dimension: 'source', query: rawClaim, resultCount: 0 },
          content: [{ type: 'text' as const, text }],
        };
      }

      const lowerClaim = rawClaim.toLowerCase();
      const isNegative = isNegativeAssertion(rawClaim);
      const isExistenceClaim =
        lowerClaim.includes('exist') ||
        lowerClaim.includes('defined') ||
        lowerClaim.includes('declared') ||
        lowerClaim.includes('presence') ||
        lowerClaim.includes('present') ||
        lowerClaim.includes('存在') ||
        lowerClaim.includes('定义') ||
        lowerClaim.includes('声明');

      let evalResult: ClaimEvaluation;
      if (isExistenceClaim && isNegative) {
        evalResult = {
          verdict: 'VERIFIED_TRUE',
          summary: `Claim confirmed: symbol "${rawSymbol}" does not exist in physical AST index${rawFile ? ` or specified file "${rawFile}"` : ''}.`,
          matchedSymbol: rawSymbol,
          matchedFile: rawFile || undefined,
        };
      } else {
        evalResult = {
          verdict: 'REFUTED_FALSE',
          summary: `Symbol "${rawSymbol}" does not exist in physical AST index${rawFile ? ` or specified file "${rawFile}"` : ''}.`,
          matchedSymbol: rawSymbol,
          matchedFile: rawFile || undefined,
        };
      }

      const text = formatVerificationOutput(evalResult, {
        claim: rawClaim,
        gitSha: sha,
        lang: 'text',
      });
      return {
        telemetry: { dimension: 'source', query: rawClaim, resultCount: 0 },
        content: [{ type: 'text' as const, text }],
      };
    } else {
      return {
        content: [
          {
            type: 'text' as const,
            text: `File not found in local source archive: ${rawFile}. Use read_source_file to check the exact path first.`,
          },
        ],
        isError: true,
      };
    }
  }

  const lang = detectSourceLanguage(targetFile);

  const memberMatch =
    rawClaim.match(/(?:has|contains|defines|includes|拥有|包含|定义)(?:\s+(?:a|an))?\s+(?:field|method|property|function|member|字段|方法|属性)\s+[`"']?([a-zA-Z0-9_$]+)[`"']?/i) ||
    rawClaim.match(/[`"']?([a-zA-Z0-9_$]+)[`"']?\s+(?:field|method|property|字段|方法|属性)/i);

  if (lang === 'go' && targetFile && memberMatch && /(?:method|function|方法)/i.test(rawClaim)) {
    const memberName = memberMatch[1];
    if (sourceCode && !sourceCode.includes(memberName)) {
      try {
        const fullContent = await readFileLocal(owner, repo, sha, targetFile);
        if (fullContent) {
          const escapedSymbol = rawSymbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const escapedMember = memberName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          const methodReceiverRegex = new RegExp(`func\\s*\\([^)]*\\b${escapedSymbol}\\b[^)]*\\)\\s*${escapedMember}\\b`);
          if (methodReceiverRegex.test(fullContent)) {
            const methodSig = extractSymbolSignature(fullContent, memberName, 'go');
            sourceCode = `${sourceCode}\n\n${methodSig}`;
          }
        }
      } catch {
        ignoreBestEffort();
      }
    }
  }

  let signature = '';
  if (sourceCode && rawSymbol) {
    signature = extractSymbolSignature(sourceCode, rawSymbol, lang);
  }

  const evaluation = evaluateClaimAgainstEvidence({
    claim: rawClaim,
    symbol: rawSymbol || symbolDetail?.name,
    file: targetFile,
    signature,
    sourceCode,
    symbolDetail,
    lang,
  });

  const outputText = formatVerificationOutput(evaluation, {
    claim: rawClaim,
    gitSha: sha,
    lang,
  });

  return {
    telemetry: { dimension: 'source', query: rawClaim, resultCount: 1 },
    content: [{ type: 'text' as const, text: outputText }],
  };
}
