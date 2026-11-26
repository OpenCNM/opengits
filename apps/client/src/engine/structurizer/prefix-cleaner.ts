import { collectHeadings } from '../markdown/mdast-ast';

export const numericPrefixPattern = /^(\d{1,3})[-_.]/;

// Limit each segment to 1-3 digits so year prefixes like 2024-report stay intact.
export const multiLevelNumericPrefixPattern =
  /^(?:[(（]\d{1,3}[)）][\s._-]*|(?:\d{1,3}\s*[-_.、)．:]\s*)+(?:\d{1,3}(?=\s))?\s*)/;

export function stripNumericPrefix(name: string): string {
  if (!name) return '';
  return name.replace(multiLevelNumericPrefixPattern, '').trim();
}

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

export function formatHumanReadableTitle(rawName: string): string {
  if (!rawName || typeof rawName !== 'string') return '';
  let name = rawName.replace(/\.mdx?$/i, '');
  name = stripNumericPrefix(name);
  name = name.replace(/[-_]/g, ' ').trim();
  if (!name) return '';

  return name
    .split(/\s+/)
    .map((word) => {
      const lower = word.toLowerCase();
      if (COMMON_TECH_ACRONYMS.has(lower)) {
        return COMMON_TECH_ACRONYMS.get(lower)!;
      }
      if (/[a-z]+[A-Z]/.test(word)) {
        return word;
      }
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(' ');
}

export function cleanMarkdownHeading(raw: string): string {
  if (!raw || typeof raw !== 'string') return '';
  // Require leading whitespace before trailing # so C#/F# titles stay intact.
  let text = raw
    .trim()
    .replace(/^#+\s*/, '')
    .replace(/\s+#+\s*$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) return '';

  // Prefix "# " forces inline heading parse context in mdast.
  const heading = collectHeadings(`# ${text}`)[0];
  if (!heading) return text;

  return heading.text.replace(/\{#[^}]*\}/g, '').replace(/\s+/g, ' ').trim();
}
