export interface LanguageEntry {
  name: string;

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
