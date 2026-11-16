/**
 * src/engine/languages/definitions.ts
 *
 * Multi-language configuration map: language identifiers + file extension associations.
 *
 * 符号/导入提取与 AST 节点类型契约已全量下沉至 Go worker-sidecar
 * （internal/treesitter + internal/rsg/languages_native.go 单一事实源）。
 * 本注册表仅供 detector.ts 的 O(1) 扩展名识别与 syntax-registry 的 Shiki
 * 语法映射消费；严禁再引入行级正则符号提取（Chomsky Boundary 红线：
 * 代码语法提取必须且只能走 Go Tree-sitter AST 查询）。
 * （2026-11 死代码清算：15 个 AST/WASM 僵尸元数据字段随 parser.ts 退役移除。）
 */

export interface LanguageEntry {
  /** Language identifier (e.g. 'typescript', 'python', 'go', etc.) */
  name: string;

  /** File extensions associated with this language (including leading dot, e.g. ['.ts', '.tsx']) */
  extensions: string[];
}

export const LANGUAGE_MAP: Record<string, LanguageEntry> = {
  typescript: { name: 'typescript', extensions: ['.ts', '.tsx'] },
  javascript: { name: 'javascript', extensions: ['.js', '.jsx', '.cjs', '.mjs'] },
  python: { name: 'python', extensions: ['.py', '.pyw', '.pyi'] },
  mojo: { name: 'mojo', extensions: ['.mojo', '.🔥'] },
  bend: { name: 'bend', extensions: ['.bend'] },
  go: { name: 'go', extensions: ['.go'] },
  rust: { name: 'rust', extensions: ['.rs'] },
  java: { name: 'java', extensions: ['.java'] },
  cpp: { name: 'cpp', extensions: ['.cpp', '.cxx', '.cc', '.hpp', '.h', '.c', '.hxx'] },
  csharp: { name: 'csharp', extensions: ['.cs'] },
  ruby: { name: 'ruby', extensions: ['.rb'] },
  php: { name: 'php', extensions: ['.php'] },
  swift: { name: 'swift', extensions: ['.swift'] },
  kotlin: { name: 'kotlin', extensions: ['.kt', '.kts'] },
  zig: { name: 'zig', extensions: ['.zig'] },
  nim: { name: 'nim', extensions: ['.nim'] },
  gleam: { name: 'gleam', extensions: ['.gleam'] },
  moonbit: { name: 'moonbit', extensions: ['.mbt'] },
  typst: { name: 'typst', extensions: ['.typ'] },
  odin: { name: 'odin', extensions: ['.odin'] },
  carbon: { name: 'carbon', extensions: ['.carbon'] },
  vlang: { name: 'vlang', extensions: ['.v'] },
  julia: { name: 'julia', extensions: ['.jl'] },
  r: { name: 'r', extensions: ['.r', '.R'] },
  solidity: { name: 'solidity', extensions: ['.sol'] },
  dart: { name: 'dart', extensions: ['.dart'] },
  lua: { name: 'lua', extensions: ['.lua'] },
  elixir: { name: 'elixir', extensions: ['.ex', '.exs'] },
  erlang: { name: 'erlang', extensions: ['.erl', '.hrl'] },
  scala: { name: 'scala', extensions: ['.scala'] },
  haskell: { name: 'haskell', extensions: ['.hs', '.lhs'] },
  ocaml: { name: 'ocaml', extensions: ['.ml', '.mli'] },
  clojure: { name: 'clojure', extensions: ['.clj', '.cljs', '.cljc'] },
  fsharp: { name: 'fsharp', extensions: ['.fs', '.fsi', '.fsx'] },
  groovy: { name: 'groovy', extensions: ['.groovy'] },
};
