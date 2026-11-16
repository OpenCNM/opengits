import { visit, SKIP } from 'unist-util-visit';
import type { Root, Element, Properties } from 'hast';
import { cn } from '@/lib/utils';
import { KNOWN_MDX_COMPONENT_NAMES, HTML_INTRINSIC_TAGS } from './known-mdx-components';

export interface RehypePolymorphicDemotionOptions {
  forbiddenTags?: ReadonlySet<string> | string[];
  knownComponents?: ReadonlySet<string> | string[];
  intrinsicTags?: ReadonlySet<string> | string[];
}

/** 高危注入/渗透标签清单：严谨封闭剥离，绝不转为普通行内文本 */
export const FORBIDDEN_DEMOTION_TAGS: ReadonlySet<string> = new Set([
  'script',
  'iframe',
  'object',
  'embed',
  'style',
  'base',
  'meta',
]);

/**
 * Rehype AST 多态降级流水线 (First-Principles Polymorphic Demotion)
 *
 * 遵循 346 准则：能力不倒退、效果不劣化、失效封闭高于伪弹性。
 * 统一拦截 HAST 中的所有非法/未注册伪 HTML 标签（如 <name>, <type>, <T>, <target_dir>）：
 * 1. 原生合法 HTML/SVG 元素 -> 保留原样
 * 2. 平台已注册 MDX 组件 -> 保留原样
 * 3. 带连字符的 Custom Elements -> 保留原样
 * 4. 高危渗透标签 -> 严谨剔除封闭
 * 5. 所有其余未知伪标签 -> 多态降级为具备语义类名与属性的 <span> 占位令牌，
 *    空标签自动回填符号纯文本，彻底解决 React 19 渲染报错与技术信息静默丢失。
 */
export function rehypePolymorphicDemotion(options?: RehypePolymorphicDemotionOptions) {
  const forbidden = options?.forbiddenTags
    ? new Set(options.forbiddenTags)
    : FORBIDDEN_DEMOTION_TAGS;
  const known = options?.knownComponents
    ? new Set(options.knownComponents)
    : KNOWN_MDX_COMPONENT_NAMES;
  const intrinsic = options?.intrinsicTags
    ? new Set(options.intrinsicTags)
    : HTML_INTRINSIC_TAGS;

  return (tree: Root) => {
    visit(tree, 'element', (node: Element, index: number | undefined, parent: any) => {
      if (!node || typeof node.tagName !== 'string') return;

      const lowerTagName = node.tagName.toLowerCase();

      // 1. 高危渗透标签：严谨剥离封堵
      if (forbidden.has(lowerTagName)) {
        if (parent && Array.isArray(parent.children) && typeof index === 'number') {
          parent.children.splice(index, 1);
          return [SKIP, index];
        }
        node.type = 'text' as any;
        (node as any).value = '';
        delete (node as any).tagName;
        delete (node as any).properties;
        delete (node as any).children;
        return;
      }

      // 2. 合法 HTML / SVG 内在元素：保留原样
      if (intrinsic.has(lowerTagName)) {
        return;
      }

      // 3. 平台已知 MDX 组件：保留原样
      if (known.has(node.tagName) || known.has(lowerTagName)) {
        return;
      }

      // 判定是否含有可见/有意义的内容（忽略纯空白字符或 HTML 注释）
      const hasMeaningfulChildren =
        Array.isArray(node.children) &&
        node.children.some((child: any) => {
          if (!child) return false;
          if (child.type === 'comment') return false;
          if (child.type === 'text') {
            return typeof child.value === 'string' && child.value.trim().length > 0;
          }
          return true;
        });

      // 4. Custom Elements（含连字符且拥有有意义子内容）：保留原样
      // 注意：空或自闭合的连字符标签（如 <repo-url>, <target-dir>, <project-name>）在技术文档中
      // 是典型的命令行参数占位符（红线红队用例），若不降级将导致内容在下游 sanitize 中被当成未知标签丢弃。
      if (node.tagName.includes('-') && hasMeaningfulChildren) {
        return;
      }

      // 5. 其余未知标签 / 占位伪标签（如 <name>, <type>, <T>, <target_dir>, <repo-url>, <foo:bar>）：多态降级为 span
      const originalTagName = node.tagName;
      node.tagName = 'span';

      // 防御性过滤属性：
      // - 剔除 on* 事件属性（防渗透）
      // - 剔除字符串 style 属性（防止 React 19 抛 "The style prop expects a mapping from style properties to values, not a string" 崩溃）
      // - 剔除与 DOM 无关的任意伪属性（防止 React 开发态报 "React does not recognize the ... prop on a DOM element" 告警）
      // - 保留 id, title, role, data-*, aria-* 等安全通用属性，优雅合并 className
      const cleanProperties: Properties = {
        'data-syntax-role': 'placeholder-token',
        className: cn(
          'syntax-placeholder-token font-mono text-xs px-1.5 py-0.5 rounded bg-theme-muted/15 text-theme-foreground border border-theme-border/60 inline-block align-baseline mx-0.5 select-all',
          node.properties?.className as string | string[] | undefined
        ).split(' ').filter(Boolean),
      };

      if (node.properties) {
        for (const [key, value] of Object.entries(node.properties)) {
          if (key === 'className' || key === 'data-syntax-role') continue;
          if (/^on[a-z]+/i.test(key)) continue;
          if (key === 'style') continue;
          if (
            key === 'id' ||
            key === 'title' ||
            key === 'role' ||
            key.startsWith('data') ||
            key.startsWith('aria')
          ) {
            cleanProperties[key] = value;
          }
        }
      }

      node.properties = cleanProperties;

      // 若原标签为空/自闭合（如 <name></name> 或 <name /> 或 <repo-url />），还原其符号语义，避免空白
      if (!hasMeaningfulChildren) {
        node.children = [{ type: 'text', value: `<${originalTagName}>` }];
      }
    });
  };
}
