/**
 * src/engine/scanner/asset-filter.ts
 *
 * Fast-path mechanical file pruning and asset filtering rules (Tier 1 Gate).
 * Prunes build outputs, package manager folders, VCS metadata, binary assets, and compliance noise.
 */

import { extractExtension } from '../languages/detector';

/**
 * 非内容目录 (assets/media/build/dist 等):
 * 纯静态资源 / 构建产物 / 依赖 / VCS / 配置，绝不可能承载教学价值。
 * 粗纲信号采集与细纲文件归类都应过滤掉，避免污染学习大纲。
 *
 * 注意: test/、examples/、benchmarks/ 不在此列——它们在不同仓库可能承载教学价值，交由 LLM 按上下文判断。
 */
export const nonContentDirPatterns = [
  // 静态资源(图片/图标/媒体/公共资源)
  /^(?:assets?|media|images?|img|icons?|public|static|screenshots?|figures?|fixtures)$/i,
  // 构建产物 / 依赖 / 目标输出
  /^(?:dist|build|out|target|release|debug|node_modules|vendor|bower_components|jspm_packages)$/i,
  // VCS / IDE / CI 配置（点号必须转义：`.` 在正则中匹配任意字符，
  // 未转义会让 `agithub`/`Xnuxt` 这类目录名被整树误剪）
  /^(?:\.github|\.vscode|\.idea|\.gitlab|\.circleci|\.cargo)$/,
  /^(?:\.git|\.hg|\.svn|\.next|\.nuxt|\.turbo|\.cache|\.parcel-cache)$/,
  // AI 编码工具配置目录（agent 指令 / skill 定义，非教学内容）
  /^(?:\.agents|\.claude|\.cursor|\.codex|\.windsurf|\.forge|\.kiro|\.continue|\.aider|\.cline|\.clinerules|\.greptile)$/,
  // 模型评测集与评测场景数据 (离线基准测试数据，非教学内容)
  /^(?:evals?|benchmarks?)$/i,
  // 日志 / 临时 / 缓存
  /^(?:logs?|tmp|temp|cache)$/i,
  // 发布日志 / 变更记录 / 内部私有工作区
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

/**
 * 判断路径是否落在非内容目录下 (任一路径段命中 nonContentDirPatterns)。
 * 供粗纲信号采集 / 细纲文件归类共用，杜绝 inline 杂物字符串清单。
 */
export function isNonContentDir(path: string): boolean {
  if (!path) return false;
  const segments = path.replace(/^\/+|\/+$/g, '').split('/').filter(Boolean);
  if (segments.length === 0) return false;
  return segments.some((seg) => nonContentDirPatterns.some((re) => re.test(seg)));
}
