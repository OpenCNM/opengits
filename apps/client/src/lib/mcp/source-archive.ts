/**
 * 物理源码归档读取域：确定性切片与签名提取（零语法正则，行扫描状态机）。
 * 与 Go 原生快路径逐条对齐，保证 Node MCP 与 Go mcp-sidecar 输出语义一致：
 * - readSymbolSourceCode ≡ services/worker-sidecar/internal/mcp/tools_symbol.go
 * - extractSymbolSignature ≡ services/worker-sidecar/internal/armor/code_slot.go
 */
import { readFileLocal } from '@/engine/tarball/archive-store';

/** 源码路径清洗：拒绝路径穿越与绝对路径（比 /api/code 路由更严：裸 '/' 前缀直接拒绝而非静默剥除） */
export function cleanSourcePath(rawPath: string): string | null {
  const cleanPath = (rawPath.startsWith('./') ? rawPath.slice(2) : rawPath).trim();
  if (
    !cleanPath ||
    cleanPath.includes('..') ||
    cleanPath.startsWith('/') ||
    cleanPath.startsWith('\\') ||
    /^[a-zA-Z]:[\\/]/.test(cleanPath)
  ) {
    return null;
  }
  return cleanPath;
}

/** 按扩展名映射代码围栏语言标识（tools/symbol.ts 原实现上移共享） */
export function detectSourceLanguage(path: string): string {
  const ext = path.toLowerCase().split('.').pop() || '';
  switch (ext) {
    case 'go':
      return 'go';
    case 'ts':
      return 'typescript';
    case 'tsx':
      return 'tsx';
    case 'js':
    case 'mjs':
    case 'cjs':
      return 'javascript';
    case 'jsx':
      return 'jsx';
    case 'py':
      return 'python';
    case 'rs':
      return 'rust';
    case 'java':
      return 'java';
    case 'c':
    case 'h':
      return 'c';
    case 'cpp':
    case 'cc':
    case 'cxx':
    case 'hpp':
      return 'cpp';
    case 'rb':
      return 'ruby';
    case 'php':
      return 'php';
    case 'cs':
      return 'csharp';
    case 'swift':
      return 'swift';
    case 'kt':
    case 'kts':
      return 'kotlin';
    case 'json':
      return 'json';
    case 'yaml':
    case 'yml':
      return 'yaml';
    case 'sql':
      return 'sql';
    case 'sh':
    case 'bash':
    case 'zsh':
      return 'bash';
    default:
      return 'text';
  }
}

/**
 * 从本地解压归档中安全提取源码切片（readFileLocal 内建路径穿越防御）。
 * 切片规则与 Go readSymbolSourceCode 一致：
 * 1) 有准确起止行号 → 精确切片；2) 行号缺失 → 符号声明行起 40 行窗口；
 * 3) 文件 ≤120 行 → 全量；4) 超大文件 → 前 60 行 + 截断标记。
 */
export async function readSymbolSourceCode(
  owner: string,
  repo: string,
  ref: string,
  relPath: string,
  symName: string,
  startLine: number,
  endLine: number
): Promise<string> {
  if (!owner || !repo || !ref || !relPath) return '';
  let raw: string | null = null;
  try {
    raw = await readFileLocal(owner, repo, ref, relPath);
  } catch {
    return '';
  }
  if (raw === null || raw === '') return '';
  const lines = raw.split('\n');
  if (lines.length === 0) return '';

  // 1. 若有准确起止行号，直接切片
  if (startLine > 0 && endLine >= startLine && startLine <= lines.length) {
    const clampedEnd = Math.min(endLine, lines.length);
    return lines.slice(startLine - 1, clampedEnd).join('\n');
  }

  // 2. 若行号缺失，扫描符号定义签名行并取 40 行窗口
  if (symName) {
    const symLower = symName.toLowerCase();
    let matchIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const lineLower = lines[i].toLowerCase();
      if (
        lineLower.includes(symLower) &&
        (lineLower.includes('func ') ||
          lineLower.includes('type ') ||
          lineLower.includes('def ') ||
          lineLower.includes('class ') ||
          lineLower.includes('function ') ||
          lineLower.includes('interface '))
      ) {
        matchIdx = i;
        break;
      }
    }
    if (matchIdx >= 0) {
      const targetEnd = Math.min(matchIdx + 40, lines.length);
      return lines.slice(matchIdx, targetEnd).join('\n');
    }
  }

  // 3. 文件整体较小（≤120 行）输出全量
  if (lines.length <= 120) return raw;

  // 4. 超大文件截断输出前 60 行
  return (
    lines.slice(0, 60).join('\n') +
    '\n\n// ... [Truncated: specify symbol start_line/end_line for targeted inspection]'
  );
}

/**
 * 确定性符号签名提取——armor.ExtractSymbolSignature 的 TS 镜像。
 * 规则：定位声明行（跳过注释行）→ 收集 ≤5 行前置文档注释 →
 * - python：括号深度归零且行尾 ':' 即签名结束（≤15 行）；
 * - 类 C 语言：函数捕获到首个 '{'（截为 `... { ... }`）；
 *   类型声明捕获至匹配闭合 '}'（≤30 行）。
 */
export function extractSymbolSignature(sourceCode: string, symName: string, lang: string): string {
  const rawTrimmed = sourceCode.trim();
  if (!rawTrimmed) return '';
  const lines = sourceCode.split('\n');
  if (lines.length === 0) return '';

  // 1. 查找包含 symName 的声明起始行
  let startIdx = -1;
  const symLower = symName.toLowerCase();
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*')) continue;
    if (symLower && trimmed.toLowerCase().includes(symLower)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx === -1) startIdx = 0;

  // 2. 收集紧邻的前置文档注释（最多 5 行）
  let docCommentStart = startIdx;
  while (docCommentStart > 0) {
    const prev = lines[docCommentStart - 1].trim();
    if (prev.startsWith('//') || prev.startsWith('#') || prev.startsWith('*') || prev.startsWith('/*')) {
      docCommentStart--;
      if (startIdx - docCommentStart >= 5) break;
    } else {
      break;
    }
  }
  const commentLines = lines.slice(docCommentStart, startIdx);

  const sigLines: string[] = [];
  if (lang === 'python') {
    let parenDepth = 0;
    for (let i = startIdx; i < lines.length; i++) {
      const line = lines[i];
      sigLines.push(line);
      for (const ch of line) {
        if (ch === '(' || ch === '[' || ch === '{') parenDepth++;
        else if (ch === ')' || ch === ']' || ch === '}') parenDepth--;
      }
      const trimmed = line.trim();
      if (parenDepth <= 0 && trimmed.endsWith(':')) break;
      if (i - startIdx >= 15) break;
    }
    const res = [...commentLines, ...sigLines];
    const lastIdx = res.length - 1;
    if (lastIdx >= 0) {
      res[lastIdx] = res[lastIdx].replace(/[ \t]+$/, '') + ' ...';
    }
    return res.join('\n');
  }

  // Go / TS / Rust / C / Java 等类 C 语言
  const firstLine = lines[startIdx].trim();
  const isTypeDecl =
    firstLine.startsWith('type ') ||
    firstLine.startsWith('interface ') ||
    firstLine.includes('struct {') ||
    firstLine.includes('interface {') ||
    firstLine.startsWith('export interface ') ||
    firstLine.startsWith('export type ');

  let braceDepth = 0;
  let openedBrace = false;
  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    sigLines.push(line);
    for (const ch of line) {
      if (ch === '{') {
        braceDepth++;
        openedBrace = true;
      } else if (ch === '}') {
        braceDepth--;
      }
    }

    if (isTypeDecl) {
      // 类型定义：捕获至匹配闭合括号 }
      if (openedBrace && braceDepth <= 0) break;
    } else if (openedBrace) {
      // 函数/方法签名：捕获到首个开括号 '{'，截断为 `... { ... }`
      const last = sigLines[sigLines.length - 1];
      const bracePos = last.indexOf('{');
      if (bracePos >= 0) {
        sigLines[sigLines.length - 1] = last.slice(0, bracePos).replace(/[ \t]+$/, '') + ' { ... }';
      }
      break;
    }

    if (i - startIdx >= 30) {
      sigLines.push('// ... [contract truncated]');
      break;
    }
  }

  return [...commentLines, ...sigLines].join('\n');
}
