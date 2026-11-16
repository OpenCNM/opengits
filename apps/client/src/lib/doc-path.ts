/**
 * 文档路径归一化与语义等价匹配（跨组件确定性比对的唯一事实源）。
 * 独立成模块以供 Zustand store 与纯投影引擎共同依赖，杜绝 store↔projector 循环引用。
 * 服务端路由（API layer）同样可安全引用：纯字符串运算，零浏览器依赖。
 */

/**
 * 统一规范化文档路径（去除首尾空白、斜杠与常见 markdown 扩展名），用于跨组件确定性比对，彻底杜绝路径漂移。
 */
export function normalizeDocPath(p: string | null | undefined): string {
  if (!p) return '';
  let decoded = p;
  try {
    decoded = decodeURIComponent(p);
  } catch {
    // Malformed URI string fallback to raw
  }
  // 装饰剥离链后逐段收敛：扩展名剥离可能暴露新的尾斜杠（"p/.md" → "p/"），
  // 混合空白与斜杠边界（如 "/ /p.md"、"p/ .md"、" /!"）统一通过首尾闭包剥离，
  // 闭合归一代数（幂等 + 任意装饰不变）——
  // 由 tests/unit/state-projector-properties.test.ts 性质 6 锁定
  return decoded
    .replace(/^[\s/]+/, '')
    .replace(/[\s/]+$/, '')
    .replace(/\.(md|mdx|markdown)$/i, '')
    .replace(/^[\s/]+/, '')
    .replace(/[\s/]+$/, '');
}

/**
 * 判断两个文档路径是否语义等价（忽略扩展名及前导/末尾斜杠差异）。
 * 空串漂移防御：任一侧归一化为空即判不等，杜绝 `includes('')` 恒真类 exploits。
 */
export function matchDocPath(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  const normA = normalizeDocPath(a);
  const normB = normalizeDocPath(b);
  if (!normA || !normB) return false;
  return normA === normB;
}
