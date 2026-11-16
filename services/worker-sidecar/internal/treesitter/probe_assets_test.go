package treesitter

import (
	"context"
	"os"
	"testing"
)

// TestProbeExternalGrammars 外部语法资产 ABI 兼容性探针（一次性验证用，
// 不参与常规回归——验证 tree-sitter-wasms 预构建资产与本引擎 ts_core 的
// 加载/解析兼容性）。STORAGE_ROOT 指向包含 grammars/*.wasm 的目录时生效。
func TestProbeExternalGrammars(t *testing.T) {
	root := os.Getenv("TS_PROBE_ROOT")
	if root == "" {
		t.Skip("TS_PROBE_ROOT not set — external grammar probe disabled")
	}
	t.Setenv("STORAGE_ROOT", root)

	snippets := map[string]string{
		"html":       "<html><body><h1>Hello</h1><p class=\"x\">World</p></body></html>",
		"css":        ".btn { color: red; }\n@media (max-width: 600px) { .btn { color: blue; } }",
		"json":       `{"name": "demo", "items": [1, 2, 3], "nested": {"a": true}}`,
		"yaml":       "name: demo\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
		"vue":        "<template><div>{{ msg }}</div></template>\n<script>export default { data() { return { msg: 'hi' } } }</script>",
		"objc":       "#import <Foundation/Foundation.h>\n@interface Demo : NSObject\n- (void)run:(NSString *)name;\n@end\n@implementation Demo\n- (void)run:(NSString *)name { NSLog(@\"%@\", name); }\n@end",
		"solidity":   "// SPDX-License-Identifier: MIT\npragma solidity ^0.8.0;\ncontract Demo {\n    function run(uint x) public pure returns (uint) { return x + 1; }\n}\n",
		"powershell": "function Get-Demo {\n  param([string]$Name)\n  Write-Output \"Hello $Name\"\n}\nGet-Demo -Name 'world'\n",
		"ocaml":      "module Demo = struct\n  let run x = x + 1\nend\nlet () = print_int (Demo.run 41)\n",
		"svelte":     "<script>\n  export let name;\n  function greet() { return `hello ${name}`; }\n</script>\n<h1>{greet()}</h1>",
		"haskell":    "module Demo where\nrun :: Int -> Int\nrun x = x + 1\n",
		"r":          "run <- function(x) {\n  x + 1\n}\nprint(run(41))\n",
		"julia":      "module Demo\nrun(x) = x + 1\nend\nprintln(Demo.run(41))\n",
		"clojure":    "(ns demo.core)\n(defn run [x] (+ x 1))\n(println (run 41))\n",
		"groovy":     "class Demo {\n  def run(int x) {\n    x + 1\n  }\n}\nprintln(new Demo().run(41))",
		"perl":       "package Demo;\nuse strict;\nuse warnings;\nsub run {\n  my ($x) = @_;\n  return $x + 1;\n}\n1;\n",
		"toml":       "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n\n[dependencies]\nserde = \"1.0\"\n",
		"dockerfile": "FROM golang:1.22 AS builder\nWORKDIR /src\nCOPY . .\nRUN go build -o /out/app ./cmd/app\n\nFROM scratch\nCOPY --from=builder /out/app /app\nENTRYPOINT [\"/app\"]\n",
		"cmake":      "cmake_minimum_required(VERSION 3.16)\nproject(demo)\nfunction(add_target name)\n  add_executable(${name} main.c)\nendfunction()\nadd_target(demo)\n",
		"make":       "CC := gcc\nCFLAGS := -Wall\n\nbuild: main.o\n\t$(CC) $(CFLAGS) -o app main.o\n\nmain.o: main.c\n\t$(CC) $(CFLAGS) -c main.c\n\n.PHONY: clean\nclean:\n\trm -f *.o app\n",
		"gleam":      "import gleam/io\n\npub fn run(name: String) -> String {\n  \"Hello, \" <> name <> \"!\"\n}\n\npub type Shape {\n  Circle(Float)\n  Rect(Float, Float)\n}\n\npub fn main() {\n  io.println(run(\"world\"))\n}\n",
		"moonbit":    "pub fn fibonacci(n: Int) -> Int {\n  if n < 2 { n } else { fibonacci(n - 1) + fibonacci(n - 2) }\n}\n\npub struct Point {\n  x: Double\n  y: Double\n}\n\npub enum Shape {\n  Circle(Double)\n  Rect(Double, Double)\n}\n\nfn init {\n  let p : Point = { x: 1.0, y: 2.0 }\n  println(p.x + p.y)\n}\n",
		"typst":      "#let greet(name) = \"Hello, \" + name + \"!\"\n#let version = \"1.0\"\n\n= Demo\n#greet(\"world\")\n\n#let items = (\"a\", \"b\", \"c\")\n",
	}

	engine, err := NewEngine(context.Background())
	if err != nil {
		t.Fatalf("engine init failed: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	for lang, snippet := range snippets {
		t.Run(lang, func(t *testing.T) {
			// DebugAST = ensureLanguage + parse（不依赖 .scm 查询）——
			// 纯 ABI 兼容性验证
			ast, err := engine.DebugAST(lang, []byte(snippet))
			if err != nil {
				t.Fatalf("grammar load/parse failed (ABI incompatible?): %v", err)
			}
			if len(ast) == 0 {
				t.Fatal("empty AST dump")
			}
			t.Logf("lang=%s parsed ok; ast head=%.80s", lang, ast)
		})
	}
}
