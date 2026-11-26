import { extractExtension } from '../languages/detector';

// Excludes non-pedagogical dirs; test/, examples/, and benchmarks/ are left to LLM context routing.
export const nonContentDirPatterns = [
  /^(?:assets?|media|images?|img|icons?|public|static|screenshots?|figures?|fixtures)$/i,
  /^(?:dist|build|out|target|release|debug|node_modules|vendor|bower_components|jspm_packages)$/i,
  // Escaped dots prevent matching arbitrary chars (e.g. agithub/Xnuxt).
  /^(?:\.github|\.vscode|\.idea|\.gitlab|\.circleci|\.cargo)$/,
  /^(?:\.git|\.hg|\.svn|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache)$/,
  /^(?:\.agents|\.claude|\.cursor|\.codex|\.windsurf|\.forge|\.kiro|\.continue|\.aider|\.cline|\.clinerules|\.greptile)$/,
  /^(?:evals?|benchmarks?)$/i,
  /^(?:logs?|tmp|temp|cache)$/i,
  /^(?:changelogs?|release[-_]notes?|releases?|changes?|\.changeset|(?:packages|internal|private)[-_](?:private|internal|packages|modules))$/i,
];

export const excludedFileCategories = {
  archive: {
    label: '压缩包与归档',
    extensions: ['.zip', '.rar', '.7z', '.tar', '.gz', '.bz2', '.xz', '.tgz', '.cab', '.iso', '.dmg', '.pkg'],
  },
  executable: {
    label: '可执行与二进制',
    extensions: ['.exe', '.dll', '.so', '.dylib', '.bin', '.app', '.apk', '.ipa', '.deb', '.rpm', '.wasm', '.o', '.obj'],
  },
  office_media: {
    label: '办公文档与富媒体/插图',
    extensions: [
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx', '.pages', '.numbers', '.keynote',
      '.mp4', '.mp3', '.mov', '.avi', '.mkv', '.flv', '.wav', '.aac',
      '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp', '.ico',
    ],
  },
  build_db: {
    label: '构建缓存与数据库',
    extensions: ['.pyc', '.pyo', '.class', '.db', '.sqlite', '.sqlite3', '.pcap', '.dat', '.lock'],
  },
} as const;

export const noisyPathPrefixes = [
  '.github/',
  '.vscode/',
  '.clinerules/',
  '.cline/',
  '.greptile/',
  'evals/',
  'node_modules/',
  'dist/',
  'build/',
  'out/',
  'vendor/',
];

export const ignoredFilenames = [
  'document.md',
  'solution',
  'AGENTS.md',
  'CODE_OF_CONDUCT',
  'SECURITY',
  'SUPPORT',
];

export const allowedFileExtensions = /\.(md|mdx|py|pyw|pyi|ts|tsx|js|jsx|cjs|mjs|go|rs|c|cpp|cxx|cc|h|hpp|java|cs|rb|php|swift|kt|kts|mojo|🔥|bend|zig|nim|gleam|odin|carbon|v|jl|r|sol|dart|lua|ex|exs|erl|hrl|scala|hs|lhs|ml|mli|clj|cljs|cljc|fs|fsi|fsx|groovy|sh|bash|json|yml|yaml|toml|ini|txt|csv)$/i;

export function isNonContentDir(path: string): boolean {
  if (!path) return false;
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return segments.some((seg) => nonContentDirPatterns.some((re) => re.test(seg)));
}
