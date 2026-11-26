import { LANGUAGE_MAP } from './definitions';

const SUPPLEMENTARY_DOC_LANGUAGES = [
  'bash',
  'sh',
  'shell',
  'zsh',
  'fish',
  'powershell',
  'cmd',
  'bat',

  'html',
  'xml',
  'svg',
  'markdown',
  'mdx',

  'css',
  'scss',
  'sass',
  'less',

  'json',
  'jsonc',
  'json5',
  'yaml',
  'toml',
  'ini',
  'dockerfile',
  'makefile',
  'cmake',

  'sql',
  'prisma',
  'graphql',

  'diff',
] as const;

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

const SYNTAX_SEMANTIC_ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  env: 'bash',
  ps: 'powershell',
  ps1: 'powershell',

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
  vlang: 'v',

  yml: 'yaml',
  md: 'markdown',
  docker: 'dockerfile',
  make: 'makefile',
  gql: 'graphql',

  c: 'c',
  cpp: 'cpp',

  jsx: 'jsx',
  tsx: 'tsx',
  js: 'javascript',
  ts: 'typescript',
};

const SYNTAX_INDEX = new Map<string, string>();

function initializeSyntaxIndex(): void {
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

  for (const docLang of SUPPLEMENTARY_DOC_LANGUAGES) {
    const lower = docLang.toLowerCase();
    if (!SYNTAX_INDEX.has(lower)) {
      SYNTAX_INDEX.set(lower, lower);
    }
  }

  // Apply explicit semantic aliases last so they override LANGUAGE_MAP extensions.
  for (const [alias, target] of Object.entries(SYNTAX_SEMANTIC_ALIASES)) {
    SYNTAX_INDEX.set(alias.toLowerCase(), target.toLowerCase());
  }
}

initializeSyntaxIndex();

export function resolveHighlightLanguage(rawLang?: string): string {
  if (!rawLang) return 'text';
  const cleaned = rawLang.toLowerCase().replace(/^language-/, '').trim();
  if (!cleaned) return 'text';

  return SYNTAX_INDEX.get(cleaned) || cleaned;
}

export function getRegisteredSyntaxAliasesCount(): number {
  return SYNTAX_INDEX.size;
}
