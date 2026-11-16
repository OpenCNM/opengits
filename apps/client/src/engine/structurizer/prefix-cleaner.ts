/**
 * src/engine/structurizer/prefix-cleaner.ts
 *
 * Utilities for cleaning chapter ordinal prefixes and recognizing TOC sidecar files.
 */

import { collectHeadings } from '../markdown/mdast-ast';

/**
 * 路径数字序号前缀（00-xxx / 01_xxx / 02.xxx）：教程原生递进顺序的次级信号
 * 捕获组 1 = 序号数字（排序/「第 N 章」标签等消费方统一从这里取数）
 */
export const numericPrefixPattern = /^(\d{1,3})[-_.]/;

/**
 * 完整数字序号前缀（支持单级 01_ / 02- / 03. 及多级章节 1.1. / 1.2.3- / (1) / （1） / 1、 等；
 * 每级限定 1-3 位数字，避免误删 2024-report / 2025_roadmap 等年份文件名）。
 */
export const multiLevelNumericPrefixPattern =
  /^(?:[(（]\d{1,3}[)）][\s._-]*|(?:\d{1,3}\s*[-_.、)．:]\s*)+(?:\d{1,3}(?=\s))?\s*)/;

/**
 * 剥离文件名或目录名中的前导数字序号（如 01_intro -> intro, 1.1.setup -> setup）
 */
export function stripNumericPrefix(name: string): string {
  if (!name) return '';
  return name.replace(multiLevelNumericPrefixPattern, '').trim();
}

/**
 * 常见技术缩写与专有名词大小写保真表（集中注册，禁止在组件或函数中内联分散规则）。
 */
const COMMON_TECH_ACRONYMS = new Map<string, string>([
  ['ios', 'iOS'],
  ['macos', 'macOS'],
  ['ipados', 'iPadOS'],
  ['watchos', 'watchOS'],
  ['grpc', 'gRPC'],
  ['api', 'API'],
  ['apis', 'APIs'],
  ['sdk', 'SDK'],
  ['sdks', 'SDKs'],
  ['cli', 'CLI'],
  ['oauth', 'OAuth'],
  ['oauth2', 'OAuth2'],
  ['rest', 'REST'],
  ['restful', 'RESTful'],
  ['graphql', 'GraphQL'],
  ['ui', 'UI'],
  ['ux', 'UX'],
  ['url', 'URL'],
  ['urls', 'URLs'],
  ['uri', 'URI'],
  ['uris', 'URIs'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['json', 'JSON'],
  ['yaml', 'YAML'],
  ['xml', 'XML'],
  ['sql', 'SQL'],
  ['uuid', 'UUID'],
  ['guid', 'GUID'],
  ['fts', 'FTS'],
  ['rsc', 'RSC'],
  ['ssr', 'SSR'],
  ['ssg', 'SSG'],
  ['isr', 'ISR'],
  ['dom', 'DOM'],
  ['rpc', 'RPC'],
  ['ai', 'AI'],
  ['llm', 'LLM'],
  ['mcp', 'MCP'],
  ['ide', 'IDE'],
  ['jwt', 'JWT'],
  ['orm', 'ORM'],
  ['ts', 'TS'],
  ['js', 'JS'],
  ['http', 'HTTP'],
  ['https', 'HTTPS'],
  ['faq', 'FAQ'],
  ['pr', 'PR'],
  ['readme', 'README'],
]);

/**
 * 将丑陋的文件名/目录名转换为易读、专有名词保真、去除前缀数字的人类友好标题。
 * 例如：
 * - '01_intro_to_ai.md' -> 'Intro To AI'
 * - '1.1.grpc_guide.mdx' -> 'gRPC Guide'
 * - '02-ios-sdk-setup.md' -> 'iOS SDK Setup'
 * - 'oauth2-client-config' -> 'OAuth2 Client Config'
 */
export function formatHumanReadableTitle(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') return '';
  // 1. 去除 Markdown 扩展名
  let name = rawName.replace(/\.mdx?$/i, '');
  // 2. 剥离数字序号前缀（单级 01_ 或多级 1.2.3-）
  name = stripNumericPrefix(name);
  // 3. 将连字符与下划线替换为空格
  name = name.replace(/[-_]/g, ' ').trim();
  if (!name) return '';

  // 4. 单词级分词与专有名词保真
  return name
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (COMMON_TECH_ACRONYMS.has(lower)) {
        return COMMON_TECH_ACRONYMS.get(lower)!;
      }
      // 保留 camelCase 标识符（如 useState）
      if (/[a-z]+[A-Z]/.test(word)) {
        return word;
      }
      // 首字母大写
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

/**
 * 清洗 Markdown 标题文本：剥离前导/尾随 # 标记、Docusaurus/VitePress 自定义锚点 {#id}
 * 与行内多余空格；HTML 标签、图片、链接、强调等行内嵌套结构统一由 mdast 行内节点
 * 归并（HTML/图片节点天然丢弃、链接保锚文本、强调归并为内部文本；泛型尖括号如
 * Map<string, number> 因不符合 CommonMark 行内 HTML 语法而天然保真）。
 * 供 chunker、concept-extractor 统一对齐复用，确保切块 heading
 * 与概念锚点 100% 吻合。
 */
export function cleanMarkdownHeading(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  // 1. 剥离 ATX 前后 # 标记（1D 首尾缀，安全区；尾缀要求前置空白，保真 C#/F# 等标题）
  let text = raw
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  // 2. 以标题上下文做行内 AST 解析（`# ` 前缀强制行内语境，避免正文被解析为块结构）
  const heading = collectHeadings(`# ${text}`)[0];
  if (!heading) return text;

  // 3. 自定义锚点 {#id} 剥离（单 token 有界字符串，安全区）
  return heading.text.replace(/\{#[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
}

