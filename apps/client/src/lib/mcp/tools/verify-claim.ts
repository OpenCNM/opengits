/**
 * apps/client/src/lib/mcp/tools/verify-claim.ts
 *
 * repo-tools verify-claim 域：verify_claim 事实测谎与闭环核验工具。
 *
 * 346 准则执行层：
 * 1. 确定性事实与概率生成张力 (Grounding Dilemma)：外部 Agent 对教程内容有疑问时，穿透至 L2 物理 AST 与源码实施核验。
 * 2. Chomsky 边界与 AST 优先：优先通过 Go sidecar /v1/graph/symbol-lookup 查询物理 AST 符号元数据与精确切片。
 * 3. 失效封闭高于伪弹性：若断言涉及无法通过物理事实证明的纯运行时行为，显式声明 AMBIGUOUS 并附带源码切片，严禁猜测。
 *    若 AST sidecar 离线或异常，严禁将基础设施故障伪装为事实否定 (REFUTED_FALSE)。
 * 4. 认知预算 (CDC)：输出紧凑结构化的结论（VERIFIED_TRUE / REFUTED_FALSE / AMBIGUOUS）与带行号的物理代码凭据。
 */

import { executeSidecarSymbolLookup, SymbolLookupDetail } from '@/engine/symbols-driver';
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

/** 判定文本是否为否定断言（如 does not exist, 不存在, no, not 等） */
export function isNegativeAssertion(text: string): boolean {
  return (
    /\b(?:not|does\s+not|doesn't|did\s+not|didn't|cannot|can't|no\s+longer|never|isn't|aren't|without|neither|nor|removed|deleted)\b/i.test(text) ||
    /(?:不|未|没|已删除|不存在|未定义|不再|无)/.test(text)
  );
}

/** 判定短语是否为合法的代码类型标识符（防自然语言短语被误当类型做否定判决） */
export function isValidTypeIdentifier(token: string): boolean {
  const t = token.trim();
  if (!t) return false;

  // 1. 如果包含明显的英语句子词（冠词、代词、自然语言修饰词），判定非代码类型
  if (/\b(?:the|a|an|some|all|its|their|nothing|parsed|valid)\b/i.test(t)) {
    return false;
  }

  // 1b. 纯自然语言常用词仅阻断小写形态：小写 value/data/object… 是行为描述而非类型语法，
  // 大写 Value/Data/Result… 则是合法类型名；any 例外放行（Go 1.18+/TS 内置类型即小写 any）
  if (/\b(?:value|data|object|result|success|failure)\b/.test(t)) {
    return false;
  }

  // 2. 支持 Go 多返回值/元组类型（如 (*Claims, error), (int, error), ([]byte, error)）
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

  // 3. 剥离前导指针、引用、切片、通道前缀修饰
  let stripped = t;
  stripped = stripped.replace(/^[*&]+/, '').trim();
  stripped = stripped.replace(/^(?:<-\s*chan\b|chan\s*<-\b|chan\b)\s*/, '').trim();
  while (/^\[\s*\d*\s*\]/.test(stripped)) {
    stripped = stripped.replace(/^\[\s*\d*\s*\]/, '').trim();
  }
  stripped = stripped.replace(/^[*&]+/, '').trim();

  // 空接口 interface{} 或空结构体 struct{}
  if (/^(?:interface|struct)\s*\{\s*\}$/.test(stripped)) {
    return true;
  }

  // map[K]V
  if (/^map\s*\[[^\]]+\]/.test(stripped)) {
    const afterKey = stripped.replace(/^map\s*\[[^\]]+\]\s*/, '');
    return afterKey.length === 0 || isValidTypeIdentifier(afterKey);
  }

  // 基础类型标识符（支持命名空间 pkg.Type、泛型 <T, U> 以及后缀 []）
  return /^([a-zA-Z_$][a-zA-Z0-9_$]*)(?:\.[a-zA-Z_$][a-zA-Z0-9_$]*)*(?:\s*<[^>]+>)?(?:\s*\[\s*\])*$/.test(stripped);
}

/** 常见自然语言数字转数值映射 */
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

/**
 * 结构化解析函数签名中的参数列表（考虑括号/泛型嵌套）。
 */
export function parseSignatureParams(signature: string, lang = ''): {
  rawParams: string[];
  callerParamCount: number;
  returnSection: string;
  hasParamSignature: boolean;
} {
  if (!signature) return { rawParams: [], callerParamCount: 0, returnSection: '', hasParamSignature: false };

  // 1. 查找首个参数括号对
  let firstParen = signature.indexOf('(');
  if (firstParen < 0) return { rawParams: [], callerParamCount: 0, returnSection: '', hasParamSignature: false };

  // 识别 Go 语言结构体方法 receiver: func (r *Receiver) MethodName(params) returns
  // 若签名由 func 开头且首个括号为接收器，跳过 receiver 并提取实际方法参数
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
      // 方法名不得为 func 关键字：排除 func(params) func(closure) 形态的函数类型签名，
      // 否则会把返回闭包的形参表误当本函数实参表
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

  // 2. 切分逗号分隔的参数，注意跳过嵌套的 <...>, [...], {...}, (...)
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

  // 3. 针对 Python 方法的 self/cls 规范调整调用者参数计数
  let callerParamCount = params.length;
  if (lang === 'python' && params.length > 0) {
    const firstLower = params[0].toLowerCase();
    if (firstLower === 'self' || firstLower === 'cls' || firstLower.startsWith('self:') || firstLower.startsWith('cls:')) {
      callerParamCount = params.length - 1;
    }
  }

  // 4. 提取返回值部分（闭合括号后至代码体开括号前）
  let returnSection = signature.slice(closeParen + 1).replace(/\{[\s\S]*$/, '').trim();
  returnSection = returnSection.replace(/^[:\-]\s*/, '').replace(/^>\s*/, '').trim();

  return { rawParams: params, callerParamCount, returnSection, hasParamSignature: true };
}

export const parseFunctionSignature = parseSignatureParams;

/**
 * 确定性规则事实评估器（第一性原理物理校验，零 LLM 幻觉）。
 */
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

  // ── 规则 1：参数个数断言 ──
  // 匹配: "takes 3 arguments", "taking 2 parameters", "0 args", "接收 2 个参数", "不接收参数"
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

  // ── 规则 2：指定参数名或类型存在性断言 ──
  // 匹配: "has context parameter", "takes a token string", "接收 secret 参数", "takes context.Context"
  const specificParamMatch =
    cleanClaim.match(/(?:takes|accepts|has|requires|contains)\s+(?:a |an )?(?:parameter|argument)?\s*[`"']?([a-zA-Z_$][a-zA-Z0-9_$.*&]+)[`"']?\s*(?:parameter|argument)?/i) ||
    cleanClaim.match(/(?:接收|接受|需要|包含)\s*[`"']?([a-zA-Z_$][a-zA-Z0-9_$.*&]+)[`"']?\s*(?:参数|入参)/);

  if (specificParamMatch && rawParams.length > 0) {
    const targetToken = specificParamMatch[1];
    // 采用单词边界匹配，防止 "id" 误命中 "userId"
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

  // ── 规则 3：返回值类型 / 错误返回断言 ──
  // 匹配: "returns error", "returns (*Claims, error)", "returns bool", "returns void", "返回 error", "返回布尔值"
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
      // 容忍多返回值元组内逗号空格微小差异，如 "(*claims, error)" 对齐 "(*claims,error)"
      return lowerEffectiveReturn.replace(/\s+/g, '').includes(tok.replace(/\s+/g, ''));
    });

    // 如果字面未直接命中，但断言是多词自然语言（如 "the parsed claims on success"），提取其中核心词（如 "claims"）核验
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
      // 只有捕获短语是合法的语法类型标识符时，才允许下达 REFUTED_FALSE 判决
      return {
        verdict: 'REFUTED_FALSE',
        summary: `Claim asserts return type "${rawCaptured}", but physical signature returns: ${effectiveReturn}`,
        signature,
        matchedFile: file,
        matchedSymbol: symbol,
      };
    }
    // 捕获为非语法类型的自然语言短语，不直接判伪，穿透至后续规则或 AMBIGUOUS
  }

  // ── 规则 4：结构体/类中特定字段或成员方法存在性 ──
  // 匹配: "has method Stop", "defines method batch_eval", "does not define method X", "contains field timeout", "包含字段 timeout", "定义了 Stop 方法"
  const memberMatch =
    cleanClaim.match(/\b(?:has|have|had|contains?|defines?|defined|declares?|declared|includes?|拥有|包含|定义|声明)(?:\s+(?:a|an|the))?\s+(?:field|method|property|function|member|字段|方法|属性)\s+[`"']?([a-zA-Z0-9_$]+)[`"']?/i) ||
    cleanClaim.match(/[`"']?([a-zA-Z0-9_$]+)[`"']?\s+(?:field|method|property|字段|方法|属性)/i);

  if (memberMatch && sourceCode) {
    let memberName = memberMatch[1];
    // 防自然语言动词/虚词误作为前置方法名（如 "does not define method X" 命中第二条规则提取了 "define"）
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
      // 在 Go 语言中，结构体方法声明于 struct 体外（func (r *Struct) Method）。
      // 仅凭 struct 结构体切片未包含该标识符，不能判定该结构体无此方法。
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
      // 肯定断言：断言该成员存在，但当前代码切片中未找到该标识符
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

  // ── 规则 5：符号存在性断言 ──
  // 匹配: "VerifyToken exists", "is defined in auth.ts", "does not exist", "不存在"
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

  // ── 规则 6：具体字面量、常数或赋值匹配 ──
  // 如果断言包含了代码引用的具体字面量（带引号或等号，如 `timeout: 30`, `port = 8080`）
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

  // ── 规则 7：回退至 AMBIGUOUS（无法从静态结构直接确证/反驳的行为陈述）──
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

/**
 * 格式化事实核验输出文本。
 */
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

/**
 * 执行 verify_claim 事实测谎核验。
 */
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

  // 若 symbol 与 file 均未传，尝试从 claim 中提取候选物理锚点
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

  // 1. 尝试查询物理 AST 符号
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

  // 2. 若 sidecar 未命中，尝试从 repoProfile.codeClusters 提取
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

  // 3. 确定目标文件路径
  const targetFile = rawFile || symbolDetail?.file || '';
  let sourceCode = '';

  if (targetFile) {
    const startLine = symbolDetail?.startLine || 0;
    const endLine = symbolDetail?.endLine || 0;
    try {
      sourceCode = await readSymbolSourceCode(owner, repo, sha, targetFile, rawSymbol, startLine, endLine);
    } catch {
      sourceCode = '';
    }
  }

  // 4. 若符号与源码均未定位到
  if (!symbolDetail && !sourceCode) {
    if (rawSymbol) {
      // 关键架构防线（工程公理 5：失效封闭高于伪弹性）：
      // 若 sidecar 查询异常/不可达，严禁将基础设施故障伪装为事实否定（REFUTED_FALSE）！
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

      // Sidecar 正常响应且明确声明 found: false（或 repoProfile 中无此符号）
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

  // 5. 提取符号物理签名
  const lang = detectSourceLanguage(targetFile);

  // 针对 Go 语言结构体方法特殊检查：Go 方法声明在 struct 体外（func (r *Receiver) MethodName）
  // 若断言检查某 struct 是否拥有某 method，而当前切片仅为 struct 体，尝试从所属源码文件获取方法定义
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
      } catch {}
    }
  }

  let signature = '';
  if (sourceCode && rawSymbol) {
    signature = extractSymbolSignature(sourceCode, rawSymbol, lang);
  }

  // 6. 执行确定性物理核验
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
