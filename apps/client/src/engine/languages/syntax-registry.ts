/**
 * apps/client/src/engine/languages/syntax-registry.ts
 *
 * Centralized Syntax Highlighting Language & Alias Registry.
 *
 * Single Source of Truth:
 * - Dynamically derives from `LANGUAGE_MAP` (33 programming languages, 60+ extensions).
 * - Indexes file extensions (without leading dot) as automatic syntax aliases.
 * - Integrates markup, config, stylesheet, query, and shell grammars for markdown docs.
 * - Eliminates inline heuristic string lists and hardcoded mappings across WASM highlighter.
 */

import { LANGUAGE_MAP } from './definitions';

/**
 * Common markup, stylesheet, configuration, query, and shell languages
 * frequently encountered in Markdown code fences and developer documentation.
 */
const SUPPLEMENTARY_DOC_LANGUAGES = [
  // Shell & Terminal
  'bash',
  'sh',
  'shell',
  'zsh',
  'fish',
  'powershell',
  'cmd',
  'bat',

  // Markup & Templating
  'html',
  'xml',
  'svg',
  'markdown',
  'mdx',

  // Stylesheets
  'css',
  'scss',
  'sass',
  'less',

  // Config & Serialization
  'json',
  'jsonc',
  'json5',
  'yaml',
  'toml',
  'ini',
  'dockerfile',
  'makefile',
  'cmake',

  // Databases & Schemas
  'sql',
  'prisma',
  'graphql',

  // Version Control & Tooling
  'diff',
] as const;

/**
 * Top high-frequency core languages preloaded into Shiki WASM memory for instant microsecond rendering.
 * All other 60+ languages are dynamically and lazily loaded on first demand.
 */
export const SYNTAX_PRELOAD_LANGUAGES = [
  'javascript',
  'typescript',
  'tsx',
  'jsx',
  'json',
  'html',
  'css',
  'bash',
  'python',
  'go',
  'rust',
  'yaml',
  'markdown',
  'sql',
  'diff',
  'cpp',
  'csharp',
  'java',
] as const;

/**
 * Explicit semantic aliases and grammar re-mappings where colloquial shorthand
 * or Shiki grammar identifiers diverge from default extension/canonical naming.
 */
const SYNTAX_SEMANTIC_ALIASES: Record<string, string> = {
  // Shell
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  env: 'bash',
  ps: 'powershell',
  ps1: 'powershell',

  // Languages with colloquial abbreviations
  golang: 'go',
  py3: 'python',
  python3: 'python',
  'c++': 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  rs: 'rust',
  rb: 'ruby',
  kt: 'kotlin',
  kts: 'kotlin',
  fs: 'fsharp',
  ex: 'elixir',
  erl: 'erlang',
  jl: 'julia',
  sol: 'solidity',
  vlang: 'v', // Shiki bundled grammar identifier for V language is 'v'

  // Documentation / Config
  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
  make: 'makefile',
  gql: 'graphql',

  // Explicit overrides for C/C++ family
  c: 'c',
  cpp: 'cpp',

  // Explicit overrides for JSX / TSX
  jsx: 'jsx',
  tsx: 'tsx',
  js: 'javascript',
  ts: 'typescript',
};

/**
 * O(1) Bi-directional / Normalization lookup index for all syntax highlighting grammars.
 * Combines:
 * 1. Canonical language names from `LANGUAGE_MAP`
 * 2. Extension-based aliases (e.g. '.rs' -> 'rs' -> 'rust')
 * 3. Supplementary documentation languages
 * 4. Explicit semantic aliases
 */
const SYNTAX_INDEX = new Map<string, string>();

function initializeSyntaxIndex(): void {
  // 1. Ingest all canonical names and extensions from LANGUAGE_MAP
  for (const [key, lang] of Object.entries(LANGUAGE_MAP)) {
    const canonicalName = lang.name.toLowerCase();
    SYNTAX_INDEX.set(canonicalName, canonicalName);
    SYNTAX_INDEX.set(key.toLowerCase(), canonicalName);

    for (const ext of lang.extensions) {
      const cleanExt = ext.replace(/^\./, '').toLowerCase();
      if (cleanExt && !SYNTAX_INDEX.has(cleanExt)) {
        SYNTAX_INDEX.set(cleanExt, canonicalName);
      }
    }
  }

  // 2. Ingest supplementary doc languages
  for (const docLang of SUPPLEMENTARY_DOC_LANGUAGES) {
    const lower = docLang.toLowerCase();
    if (!SYNTAX_INDEX.has(lower)) {
      SYNTAX_INDEX.set(lower, lower);
    }
  }

  // 3. Apply explicit semantic aliases and grammar re-mappings (highest precedence)
  for (const [alias, target] of Object.entries(SYNTAX_SEMANTIC_ALIASES)) {
    SYNTAX_INDEX.set(alias.toLowerCase(), target.toLowerCase());
  }
}

// Initialize once at module load
initializeSyntaxIndex();

/**
 * Normalizes an arbitrary raw code fence language identifier (e.g., 'language-python', 'golang', 'py', 'RS')
 * into a canonical Shiki-compatible grammar name in O(1) time.
 * Falls back to the cleaned input or 'text' if not specified.
 */
export function resolveHighlightLanguage(rawLang?: string): string {
  if (!rawLang) return 'text';
  const cleaned = rawLang.toLowerCase().replace(/^language-/, '').trim();
  if (!cleaned) return 'text';

  return SYNTAX_INDEX.get(cleaned) || cleaned;
}

/**
 * Returns all recognized language keys and aliases count for diagnostics or verification.
 */
export function getRegisteredSyntaxAliasesCount(): number {
  return SYNTAX_INDEX.size;
}
