/**
 * apps/client/src/engine/mdx-enhancer.ts
 *
 * LLM 输出确定性剥壳工具（2026-10 收口）：转录增强/翻译/修复 LLM 调用族
 * 已随 Node 同步执行器双轨退役（单一事实源在 Go 网关 purposes + 收敛漏斗）；
 * 本文件保留跨模块仍在消费的确定性纯函数——哨兵抽取与围栏信封剥壳
 * （导入向导 outline 解析与 update-planner 依赖）。
 */

/**
 * LLM 输出围栏信封剥壳（确定性首尾配对校验，非跨文本正则）：
 * 仅当输出首行是围栏开启行（语言在白名单内）且末行是同字符、不短于开启
 * 长度的闭合围栏时，剥去首尾两行。任何其他形态原样返回。
 * 默认白名单保持本模块历史契约（markdown/mdx/md 或无语言）；
 * JSON 载荷消费方（update-planner）传 ['', 'json']。
 */
export function stripEnclosingFences(
  trimmed: string,
  allowedLangs: readonly string[] = ['markdown', 'mdx', 'md', ''],
): string {
  const firstLineEnd = trimmed.indexOf('\n');
  if (firstLineEnd === -1) return trimmed;

  const firstLine = trimmed.substring(0, firstLineEnd).trim();
  const openMatch = firstLine.match(/^(`{3,}|~{3,})(.*)$/);
  if (!openMatch) return trimmed;

  const lang = (openMatch[2] ?? '').trim().toLowerCase();
  if (!allowedLangs.includes(lang)) return trimmed;

  const fenceChar = openMatch[1][0];
  const fenceLen = openMatch[1].length;
  const lastNewline = trimmed.lastIndexOf('\n');
  if (lastNewline <= firstLineEnd) return trimmed;

  const lastLine = trimmed.substring(lastNewline).trim();
  const closeMatch = lastLine.match(/^(`{3,}|~{3,})\s*$/);
  if (closeMatch && closeMatch[1][0] === fenceChar && closeMatch[1].length >= fenceLen) {
    return trimmed.substring(firstLineEnd + 1, lastNewline);
  }
  return trimmed;
}
