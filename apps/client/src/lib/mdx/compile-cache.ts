import { createHash } from 'node:crypto';
import { unstable_cache } from 'next/cache';
import { createCompiler } from '@fumadocs/mdx-remote';
import rehypeRaw from 'rehype-raw';
import remarkUnwrapImages from 'remark-unwrap-images';
import { visit } from 'unist-util-visit';
import { mdxSanitizeSchema } from '@/lib/mdx/sanitize-schema';
import {
  remarkStripEsm,
  remarkTagNormalizer,
  remarkSafeBraces,
  rehypeStripStyle,
  rehypeSanitizePreservingMdx,
} from '@/lib/mdx/ast-sanitizer-plugins';
import { rehypePolymorphicDemotion } from '@/lib/mdx/rehype-polymorphic-demotion';
import { rehypeParagraphContentModel } from '@/lib/mdx/rehype-paragraph-content-model';
import { remarkGfmAlerts, remarkStripLeadingTitle } from '@/lib/mdx/remark-doc-hygiene';

import { highlightCodeWasm } from '@/lib/wasm/syntax-highlighter-wasm';

/**
 * ─────────────────────────────────────────────────────────────
 * MDX 编译内容寻址缓存（SCALING_ROADMAP #9 修订版）。
 *
 * ISR 不可行（docs layout 读 cookies 鉴权 + 阅读进度写副作用），改为对
 * "编译产物"做 unstable_cache：键 = sha256(variant + 源文)，内容变 → 键变，
 * 天然零失效逻辑；DB 读取保持现状不进缓存。
 *
 * 缓存的是 compiled JS 字符串 + toc + frontmatter（全部 JSON 可序列化）——
 * remark/rehype 管线在 miss 时执行一次；
 * 命中后仅走轻量的 render 执行，跳过整个编译管线。
 *
 * 注意：compiled.body（FC 组件）不可序列化，因此不能整体缓存编译结果对象，
 * 必须缓存 compiled 字符串、每次请求重新 render 出组件实例。
 * 自愈/降级路径刻意不走缓存（低频，避免污染键空间）。
 * ─────────────────────────────────────────────────────────────
 */

function extractLanguageFromHast(node: any): string {
  if (!node || !node.properties) return '';
  const classNames = node.properties.className;
  if (Array.isArray(classNames)) {
    for (const cls of classNames) {
      if (typeof cls === 'string' && cls.startsWith('language-')) {
        return cls.replace(/^language-/, '');
      }
    }
  } else if (typeof classNames === 'string' && classNames.startsWith('language-')) {
    return classNames.replace(/^language-/, '');
  }
  return (node.properties['data-language'] as string) || '';
}

/** 编译器唯一定义点：解耦代码高亮与 AST，避免展开为数千个 Hast span 节点 */
function rehypePreserveRawCode() {
  return async (tree: any) => {
    const preElements: any[] = [];
    visit(tree, 'element', (node: any) => {
      if (node.tagName === 'pre') {
        preElements.push(node);
      }
    });

    for (const preNode of preElements) {
      const childCode = preNode.children?.find((c: any) => c.tagName === 'code');
      const rawText = hastNodeToString(childCode || preNode);
      if (!rawText || !rawText.trim()) continue;

      // 剔除 CommonMark/mdast-util-to-hast 自动注入的代码块末尾多余换行符，
      // 避免 Shiki 将末尾 \n 展开为一个完全空白的多余行（例如 1 行代码显示为 2 行，第二行为空）
      const normalizedCode = rawText.replace(/\r?\n$/, '');

      if (!preNode.properties) preNode.properties = {};
      preNode.properties['data-code'] = normalizedCode;

      const lang = extractLanguageFromHast(preNode) || extractLanguageFromHast(childCode);
      if (lang) {
        preNode.properties['data-language'] = lang;
        if (childCode) {
          if (!childCode.properties) childCode.properties = {};
          childCode.properties['data-language'] = lang;
          childCode.properties['data-code'] = normalizedCode;
          if (Array.isArray(childCode.children)) {
            for (const child of childCode.children) {
              if (child.type === 'text' && typeof child.value === 'string') {
                child.value = child.value.replace(/\r?\n$/, '');
              }
            }
          }
        }
      }

      // Pre-highlight via WASM syntax highlighter for <pre> blocks
      try {
        const html = await highlightCodeWasm(normalizedCode, { lang });
        if (html) {
          preNode.properties['data-highlighted-html'] = html;
        }
      } catch {
        // Graceful fallback: SandboxPre will render raw code
      }
    }
  };
}

function hastNodeToString(node: any): string {
  if (!node) return '';
  if (node.type === 'text') return node.value || '';
  if (node.children) return node.children.map(hastNodeToString).join('');
  return '';
}

/**
 * 编译器唯一定义点（读侧卫生插件随 extraRemark 注入）：
 * remarkGfmAlerts 对全部变体生效（GFM alert → <Callout>），
 * remarkStripLeadingTitle 仅 :h1s 变体挂载（门控见 compileDocMdx）。
 */
function createDocCompiler(extraRemark: Array<() => any> = []) {
  return createCompiler({
    remarkPlugins: (v) => [
      remarkUnwrapImages,
      remarkStripEsm,
      remarkTagNormalizer,
      remarkSafeBraces,
      remarkGfmAlerts,
      ...extraRemark,
      ...v,
    ],
    rehypePlugins: (v) => [
      [rehypeRaw, { passThrough: ['mdxjsEsm', 'mdxFlowExpression', 'mdxTextExpression', 'mdxJsxFlowElement', 'mdxJsxTextElement'] }],
      rehypePreserveRawCode,
      rehypeStripStyle,
      rehypeParagraphContentModel,
      rehypePolymorphicDemotion,
      // 渲染前最后一道白名单（纵深防御）：原生 HTML 属性/标签过滤。
      // MDX JSX 节点经占位保护保留（曾因 sanitize 丢弃未知节点类型而整段静默消失，
      // 审计矩阵 2.3 T1 裁定）；mdxJsx 字符串属性做轻过滤，未注册组件名改写为兜底组件
      [rehypeSanitizePreservingMdx, mdxSanitizeSchema],
      ...v,
    ],
    remarkImageOptions: false,
    rehypeCodeOptions: false,
  });
}

export const mdxCompiler = createDocCompiler();

/** 剔除正文首个 H1 的 :h1s 变体编译器（与 mdxCompiler 唯一差异：多挂 remarkStripLeadingTitle） */
const mdxCompilerStripTitle = createDocCompiler([remarkStripLeadingTitle]);

/** variant → 编译器实例选择：':h1s' 后缀表示剔除正文首个 H1（门控见 compileDocMdx） */
function compilerForVariant(variant: string) {
  return variant.endsWith(':h1s') ? mdxCompilerStripTitle : mdxCompiler;
}

interface CachedCompileEntry {
  compiled: string;
  toc: unknown[];
  frontmatter: Record<string, unknown>;
}

export interface CachedCompileResult {
  body: Awaited<ReturnType<typeof mdxCompiler.compile>>['body'];
  toc: unknown[];
  frontmatter: Record<string, unknown>;
}

/** 内容寻址缓存条目的兜底过期（天级）；键含源文摘要，无需主动失效接线 */
const COMPILE_CACHE_REVALIDATE_SECONDS = 24 * 60 * 60;

/** 源文编译错误标记：与缓存基础设施错误区分（前者上抛避免同源二次必败编译） */
class MDXSourceCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MDXSourceCompileError';
  }
}

/**
 * 已知限制：键空间只增不减——revalidate 仅刷新值不删键，每个历史内容版本
 * 各占一条（compiled 字符串量级小）。高频编辑型仓长期累积 .next 增量缓存；
 * 兜底手段为部署侧周期性清理 .next/cache 或整容器重建（无状态可弃）。
 * 若未来成为实际问题，可加 LRU 上限或按 mtime 的键清扫任务。
 */

/**
 * 递归提取 TOC 标题的纯文本内容。
 * 兼容纯字符串、ReactNode、AST 节点以及 unstable_cache 反序列化后的 JSON 对象。
 */
export function stringifyTocTitle(title: unknown): string {
  if (title === null || title === undefined) return '';
  if (typeof title === 'string') return title;
  if (typeof title === 'number' || typeof title === 'boolean') return String(title);
  if (Array.isArray(title)) {
    return title.map(stringifyTocTitle).join('');
  }
  if (typeof title === 'object' && title !== null) {
    const obj = title as Record<string, unknown>;
    if (obj.props && typeof obj.props === 'object' && obj.props !== null) {
      return stringifyTocTitle((obj.props as Record<string, unknown>).children);
    }
    if (obj.children) {
      return stringifyTocTitle(obj.children);
    }
    if (typeof obj.value === 'string') {
      return obj.value;
    }
  }
  return '';
}

export interface SanitizedTocItem {
  title: string;
  url: string;
  depth: number;
}

export function sanitizeTocItems(rawToc: unknown): SanitizedTocItem[] {
  if (!Array.isArray(rawToc)) return [];
  return rawToc
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const depth = typeof item.depth === 'number' ? item.depth : 2;
      const url = typeof item.url === 'string' ? item.url : '';
      const title = stringifyTocTitle(item.title).trim();
      return { depth, url, title };
    })
    .filter((item): item is SanitizedTocItem => item !== null && item.title.length > 0);
}

/**
 * 主编译入口：命中跳过编译管线，未命中编译一次并落缓存。
 * variant 用于区分同源文的不同编译口径（如未来按主题/语言分支插件）。
 */
export async function cachedCompileMdx(
  source: string,
  variant = 'primary',
): Promise<CachedCompileResult> {
  const compiler = compilerForVariant(variant);
  const digest = createHash('sha256').update(`${variant}\u0000${source}`).digest('hex');

  // render 结果进程内 LRU（内容寻址，零陈旧风险）：compiled 字符串 eval 出的
  // body 组件与 toc/frontmatter 对同一 digest 是确定性的，跨请求复用可跳过
  // 每请求一次的 render eval——热门文档页的读路径只剩一次 sha256 + Map 命中
  const renderHit = renderResultCache.get(digest);
  if (renderHit) {
    renderResultCache.delete(digest);
    renderResultCache.set(digest, renderHit); // LRU touch
    return renderHit;
  }

  let entry: CachedCompileEntry | null | undefined;
  try {
      const readEntry = unstable_cache(
      async (): Promise<CachedCompileEntry> => {
        try {
          const c = await compiler.compile({ source });
          // compiled 字符串 / toc / frontmatter 均为纯数据，跨缓存边界安全（TOC 纯文本化防反序列化 null 降级）
          const cleanToc = sanitizeTocItems(c.toc);
          return { compiled: c.compiled, toc: cleanToc, frontmatter: c.frontmatter };
        } catch (err) {
          // 标记为源文编译错误：外层直接上抛（同源二次编译必然再抛——
          // 原实现坏文档每次视图白付两次完整编译），由页面 Layer 2 自愈接住
          throw new MDXSourceCompileError(err instanceof Error ? err.message : String(err));
        }
      },
      // 'v5'：读侧卫生插件（GFM alert → Callout / :h1s 剔首 H1）变更编译行为，整体失效旧条目
      ['mdx-compile', 'v5', variant, digest],
      { revalidate: COMPILE_CACHE_REVALIDATE_SECONDS },
    );
    entry = await readEntry();
  } catch (err) {
    if (err instanceof MDXSourceCompileError) throw err;
    // 缓存基础设施错误（store down 等）：回落直编，不阻塞渲染（测试锁定契约）
    console.warn('[MDXCache] cache read failed, compiling directly:', err instanceof Error ? err.message : err);
  }

  // 兜底：缓存异常/空值 → 直接编译（与历史路径一致；自愈/降级路径刻意不进 LRU）
  if (!entry?.compiled) {
    const fresh = await compiler.compile({ source });
    return { body: fresh.body, toc: sanitizeTocItems(fresh.toc), frontmatter: fresh.frontmatter };
  }

  const rendered = await compiler.render(entry.compiled);
  const result: CachedCompileResult = {
    body: rendered.default,
    toc: sanitizeTocItems(entry.toc),
    frontmatter: entry.frontmatter,
  };

  if (renderResultCache.size >= RENDER_CACHE_LIMIT) {
    const oldest = renderResultCache.keys().next().value;
    if (oldest !== undefined) renderResultCache.delete(oldest);
  }
  renderResultCache.set(digest, result);
  return result;
}

/** render 结果进程内 LRU：digest → 完整渲染结果（body 为可复用的 FC 引用） */
const RENDER_CACHE_LIMIT = 128;
const renderResultCache = new Map<string, CachedCompileResult>();

/** 观测/测试：清空 render LRU（模块级状态隔离用） */
export function __resetRenderCacheForTests(): void {
  renderResultCache.clear();
}
