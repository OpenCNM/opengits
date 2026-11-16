package treesitter

import (
	"context"
	"testing"
)

// TestNewGrammarsEmbedded BUG-65 资产补齐回归：7 门新增语法（html/css/json/
// yaml/vue/objc/solidity）必须内嵌加载、解析并按契约产出符号——
// 数据/标记语言零符号，objc/solidity 真实符号，全量不落正则回退。
func TestNewGrammarsEmbedded(t *testing.T) {
	tests := []struct {
		name         string
		lang         string
		source       string
		wantSymbols  int
		wantContains []string
	}{
		{
			name: "html parse-only", lang: "html",
			source:      "<html><body><h1>Hello</h1><p class=\"x\">World</p></body></html>",
			wantSymbols: 0,
		},
		{
			name: "css parse-only", lang: "css",
			source:      ".btn { color: red; }",
			wantSymbols: 0,
		},
		{
			name: "json parse-only", lang: "json",
			source:      `{"a": 1, "b": [true, null]}`,
			wantSymbols: 0,
		},
		{
			name: "yaml parse-only", lang: "yaml",
			source:      "name: demo\njobs:\n  build:\n    steps:\n      - run: echo hi\n",
			wantSymbols: 0,
		},
		{
			name: "vue parse-only", lang: "vue",
			source:      "<template><div>{{ msg }}</div></template>\n<script>export default { data() { return { msg: 'hi' } } }</script>",
			wantSymbols: 0,
		},
		{
			name: "objc symbols", lang: "objc",
			source:       "#import <Foundation/Foundation.h>\n@interface Demo : NSObject\n@end\n@implementation Demo\n- (void)run {\n}\n@end\n",
			wantSymbols:  3, // Demo 接口 + Demo 实现 + run 方法
			wantContains: []string{"Demo", "run"},
		},
		{
			name: "powershell symbols", lang: "powershell",
			source:       "function Get-Demo {\n  param([string]$Name)\n  Write-Output \"Hello $Name\"\n}\n",
			wantSymbols:  1,
			wantContains: []string{"Get-Demo"},
		},
		{
			name: "ocaml symbols", lang: "ocaml",
			source:       "module Demo = struct\n  let run x = x + 1\nend\n",
			wantSymbols:  2, // Demo 模块 + run 函数
			wantContains: []string{"Demo", "run"},
		},
		{
			name: "haskell symbols", lang: "haskell",
			source:       "module Demo where\nimport Data.List (sort)\nrun :: Int -> Int\nrun x = x + 1\ndata Point = Point Int Int\n",
			wantSymbols:  2, // run 函数 + Point 数据类型
			wantContains: []string{"run", "Point"},
		},
		{
			name: "r symbols", lang: "r",
			source:       "run <- function(x) {\n  x + 1\n}\nprint(run(41))\n",
			wantSymbols:  1,
			wantContains: []string{"run"},
		},
		{
			name: "julia symbols", lang: "julia",
			source:       "module Demo\nrun(x) = x + 1\nstruct Point\n  x\n  y\nend\nend\n",
			wantSymbols:  3, // Demo 模块 + run 函数 + Point struct
			wantContains: []string{"Demo", "run", "Point"},
		},
		{
			name: "svelte parse-only", lang: "svelte",
			source:      "<script>\n  export let name;\n  function greet() { return `hello ${name}`; }\n</script>\n<h1>{greet()}</h1>",
			wantSymbols: 0,
		},
		{
			name: "clojure parse-only", lang: "clojure",
			source:      "(ns demo.core)\n(defn run [x] (+ x 1))\n",
			wantSymbols: 0,
		},
		{
			name: "perl symbols", lang: "perl",
			source:       "package Demo;\nuse strict;\nuse File::Spec;\nsub run {\n  my ($x) = @_;\n  return $x + 1;\n}\n1;\n",
			wantSymbols:  2, // Demo 包 + run 子例程
			wantContains: []string{"Demo", "run"},
		},
		{
			name: "solidity symbols", lang: "solidity",
			source:       "pragma solidity ^0.8.0;\ncontract Demo {\n    function run(uint x) public pure returns (uint) { return x + 1; }\n}\n",
			wantSymbols:  2, // Demo contract + run function
			wantContains: []string{"Demo", "run"},
		},
		{
			name: "toml parse-only", lang: "toml",
			source:      "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n",
			wantSymbols: 0,
		},
		{
			name: "dockerfile stage symbols", lang: "dockerfile",
			source:       "FROM golang:1.22 AS builder\nWORKDIR /src\nRUN go build ./...\n\nFROM scratch\nCOPY --from=builder /out/app /app\n",
			wantSymbols:  1, // builder 阶段（第二个 FROM 无 AS）
			wantContains: []string{"builder"},
		},
		{
			name: "cmake function symbols", lang: "cmake",
			source:       "cmake_minimum_required(VERSION 3.16)\nproject(demo)\nfunction(add_target name)\n  add_executable(${name} main.c)\nendfunction()\nmacro(setup_dirs)\nendmacro()\n",
			wantSymbols:  2, // add_target 函数 + setup_dirs 宏（首位置参数，锚点钉取）
			wantContains: []string{"add_target", "setup_dirs"},
		},
		{
			name: "make parse-only", lang: "make",
			source:      "build: main.o\n\tgcc -o app main.o\nmain.o: main.c\n\tgcc -c main.c\n",
			wantSymbols: 0,
		},
		{
			name: "gleam symbols", lang: "gleam",
			source:       "import gleam/io\n\npub fn run(name: String) -> String {\n  \"Hello, \" <> name\n}\n\npub type Shape {\n  Circle(Float)\n}\n\npub fn main() {\n  io.println(run(\"world\"))\n}\n",
			wantSymbols:  3, // run 函数 + Shape 类型 + main 函数
			wantContains: []string{"run", "Shape", "main"},
		},
		{
			name: "moonbit symbols", lang: "moonbit",
			source:       "pub fn fibonacci(n: Int) -> Int {\n  if n < 2 { n } else { fibonacci(n - 1) + fibonacci(n - 2) }\n}\n\npub struct Point {\n  x: Double\n}\n\npub enum Shape {\n  Circle(Double)\n}\n\nfn init {\n  println(1)\n}\n",
			wantSymbols:  4, // fibonacci 函数 + Point 结构 + Shape 枚举 + init 函数
			wantContains: []string{"fibonacci", "Point", "Shape", "init"},
		},
		{
			name: "typst symbols", lang: "typst",
			source:       "#let greet(name) = \"Hello, \" + name\n#let version = \"1.0\"\n\n= Demo\n#greet(\"world\")\n",
			wantSymbols:  2, // greet 函数式绑定 + version 常量绑定
			wantContains: []string{"greet", "version"},
		},
	}

	engine, err := NewEngine(context.Background())
	if err != nil {
		t.Fatalf("engine init failed: %v", err)
	}
	t.Cleanup(func() { _ = engine.Close() })

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res, err := engine.ParseAndExtract(context.Background(), tt.lang, []byte(tt.source))
			if err != nil {
				t.Fatalf("parse/extract failed: %v", err)
			}
			if len(res.Symbols) != tt.wantSymbols {
				t.Fatalf("symbols = %d, want %d (got: %+v)", len(res.Symbols), tt.wantSymbols, res.Symbols)
			}
			for _, want := range tt.wantContains {
				found := false
				for _, s := range res.Symbols {
					if s.Name == want {
						found = true
						break
					}
				}
				if !found {
					t.Errorf("expected symbol %q not found", want)
				}
			}
		})
	}
}

// TestDetectLanguageNewExtensions 扩展名映射回归。
func TestDetectLanguageNewExtensions(t *testing.T) {
	cases := map[string]string{
		"a.html": "html", "a.htm": "html", "a.css": "css", "a.json": "json",
		"a.yml": "yaml", "a.yaml": "yaml", "a.vue": "vue", "a.m": "objc",
		"a.sol": "solidity", "a.ps1": "powershell", "a.psm1": "powershell",
		"a.psd1": "powershell", "a.ml": "ocaml",
		"a.svelte": "svelte", "a.hs": "haskell", "a.r": "r", "a.jl": "julia",
		"a.clj": "clojure", "a.cljs": "clojure", "a.edn": "clojure",
		"a.pl": "perl", "a.pm": "perl",
		"a.toml": "toml", "Dockerfile": "dockerfile", "Containerfile.dev": "dockerfile",
		"CMakeLists.txt": "cmake", "a.cmake": "cmake", "Makefile": "make", "a.mk": "make",
		"a.gleam": "gleam", "a.mbt": "moonbit", "a.typ": "typst",
	}
	for path, want := range cases {
		if got := DetectLanguage(path); got != want {
			t.Errorf("DetectLanguage(%q) = %q, want %q", path, got, want)
		}
	}
}
