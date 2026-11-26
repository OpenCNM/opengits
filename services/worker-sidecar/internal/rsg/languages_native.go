package rsg

// LINT-EXEMPT: code-syntax-regex-fallback (Native language definitions import fallback patterns for 35 languages)

import (
	"regexp"
	"sync"
)

var (
	defaultLanguageDefinitionsOnce      sync.Once
	defaultLanguageDefinitionsSingleton *LanguageDefinitions
)

// Return a shallow copy with isolated mutable fields so callers can inject tsEngine without mutating the singleton.
func DefaultLanguageDefinitions() *LanguageDefinitions {
	defaultLanguageDefinitionsOnce.Do(func() {
		defaultLanguageDefinitionsSingleton = buildDefaultLanguageDefinitions()
	})
	base := defaultLanguageDefinitionsSingleton
	return &LanguageDefinitions{
		Languages:            base.Languages,
		ExtensionToLanguage:  base.ExtensionToLanguage,
		TestPatternsRaw:      base.TestPatternsRaw,
		EntryPointFiles:      base.EntryPointFiles,
		EntryPointPrefixes:   base.EntryPointPrefixes,
		ResolvableExtensions: base.ResolvableExtensions,
		Config:               base.Config,
		compiledTestPatterns: base.compiledTestPatterns,
		entryPointFilesSet:   base.entryPointFilesSet,
		resolvableExtsSet:    base.resolvableExtsSet,
	}
}

func buildDefaultLanguageDefinitions() *LanguageDefinitions {
	defs := &LanguageDefinitions{
		Languages: make(map[string]*LanguageDefinition, 35),
		ExtensionToLanguage: map[string]string{
			`.ts`:     `typescript`,
			`.tsx`:    `typescript`,
			`.js`:     `javascript`,
			`.jsx`:    `javascript`,
			`.cjs`:    `javascript`,
			`.mjs`:    `javascript`,
			`.py`:     `python`,
			`.pyw`:    `python`,
			`.pyi`:    `python`,
			`.mojo`:   `mojo`,
			`.🔥`:      `mojo`,
			`.bend`:   `bend`,
			`.go`:     `go`,
			`.rs`:     `rust`,
			`.java`:   `java`,
			`.cpp`:    `cpp`,
			`.cxx`:    `cpp`,
			`.cc`:     `cpp`,
			`.hpp`:    `cpp`,
			`.h`:      `cpp`,
			`.c`:      `cpp`,
			`.hxx`:    `cpp`,
			`.cs`:     `csharp`,
			`.rb`:     `ruby`,
			`.php`:    `php`,
			`.swift`:  `swift`,
			`.kt`:     `kotlin`,
			`.kts`:    `kotlin`,
			`.zig`:    `zig`,
			`.nim`:    `nim`,
			`.gleam`:  `gleam`,
			`.mbt`:    `moonbit`,
			`.typ`:    `typst`,
			`.odin`:   `odin`,
			`.carbon`: `carbon`,
			`.v`:      `vlang`,
			`.jl`:     `julia`,
			`.r`:      `r`,
			`.sol`:    `solidity`,
			`.dart`:   `dart`,
			`.lua`:    `lua`,
			`.ex`:     `elixir`,
			`.exs`:    `elixir`,
			`.erl`:    `erlang`,
			`.hrl`:    `erlang`,
			`.scala`:  `scala`,
			`.hs`:     `haskell`,
			`.lhs`:    `haskell`,
			`.ml`:     `ocaml`,
			`.mli`:    `ocaml`,
			`.clj`:    `clojure`,
			`.cljs`:   `clojure`,
			`.cljc`:   `clojure`,
			`.fs`:     `fsharp`,
			`.fsi`:    `fsharp`,
			`.fsx`:    `fsharp`,
			`.groovy`: `groovy`,
		},
		EntryPointFiles: []string{
			`app.js`,
			`app.py`,
			`app.ts`,
			`app.tsx`,
			`index.js`,
			`index.jsx`,
			`index.ts`,
			`index.tsx`,
			`lib.go`,
			`lib.rs`,
			`main.c`,
			`main.cpp`,
			`main.go`,
			`main.java`,
			`main.py`,
			`main.rs`,
			`main.ts`,
			`main.tsx`,
			`mod.rs`,
			`page.jsx`,
			`page.tsx`,
			`route.js`,
			`route.ts`,
			`server.js`,
			`server.ts`,
		},
		EntryPointPrefixes: []string{
			`index.`,
			`main.`,
			`app.`,
			`server.`,
			`route.`,
			`page.`,
		},
		ResolvableExtensions: []string{
			`.ts`,
			`.tsx`,
			`.js`,
			`.jsx`,
			`.mjs`,
			`.py`,
			`.go`,
			`.rs`,
			`.java`,
			`.kt`,
			`.scala`,
			`.groovy`,
			`.cpp`,
			`.c`,
			`.cc`,
			`.h`,
			`.hpp`,
			`.cs`,
			`.fs`,
			`.php`,
			`.rb`,
			`.swift`,
			`.dart`,
			`.sol`,
			`.zig`,
			`.lua`,
			`.ex`,
			`.exs`,
			`.erl`,
			`.jl`,
			`.r`,
			`.nim`,
			`.gleam`,
			`.v`,
		},
		Config: RSGConfig{
			CoreContractInDegreeQuantile: 0.75,
			BackbonePageRankQuantile:     0.7,
			DampingFactor:                0.85,
			PagerankIterations:           30,
			ExcludeTestsFromEdges:        true,
			GoldenSymbolRatio:            0.1,
			GoldenSymbolMinImporters:     2,
			MaxParseFiles:                3000,
			MaxParseFileBytes:            1048576,
			MaxCallSitesPerFile:          500,
		},
		entryPointFilesSet: make(map[string]bool, 25),
		resolvableExtsSet:  make(map[string]bool, 34),
		compiledTestPatterns: []*regexp.Regexp{
			regexp.MustCompile(`\.test\.`),
			regexp.MustCompile(`\.spec\.`),
			regexp.MustCompile(`_test\.`),
			regexp.MustCompile(`_spec\.`),
			regexp.MustCompile(`\/test\/`),
			regexp.MustCompile(`\/tests\/`),
			regexp.MustCompile(`\/__tests__\/`),
			regexp.MustCompile(`^test\/`),
			regexp.MustCompile(`^tests\/`),
			regexp.MustCompile(`\/e2e\/`),
		},
	}

	for _, f := range defs.EntryPointFiles {
		defs.entryPointFilesSet[f] = true
	}
	for _, ext := range defs.ResolvableExtensions {
		defs.resolvableExtsSet[ext] = true
	}

	defs.Languages[`typescript`] = &LanguageDefinition{
		Name:               `typescript`,
		Extensions:         []string{`.ts`, `.tsx`},
		ExportConvention:   `wrapper_declaration`,
		ImportBindingStyle: `named_specifiers`,
		EntryFilePatterns:  []string{`main.ts`, `app.ts`, `index.ts`, `src/main.ts`, `src/app.ts`, `src/index.ts`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:import|export)\s+(?:[^\n;]*?from\s+)?['"]([^'"]+)['"]`),
			regexp.MustCompile(`(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)`),
		},
	}
	defs.Languages[`javascript`] = &LanguageDefinition{
		Name:               `javascript`,
		Extensions:         []string{`.js`, `.jsx`, `.cjs`, `.mjs`},
		ExportConvention:   `wrapper_declaration`,
		ImportBindingStyle: `named_specifiers`,
		EntryFilePatterns:  []string{`main.js`, `app.js`, `index.js`, `src/main.js`, `src/app.js`, `src/index.js`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:import|export)\s+(?:[^\n;]*?from\s+)?['"]([^'"]+)['"]`),
			regexp.MustCompile(`(?:require|import)\s*\(\s*['"]([^'"]+)['"]\s*\)`),
		},
	}
	defs.Languages[`python`] = &LanguageDefinition{
		Name:               `python`,
		Extensions:         []string{`.py`, `.pyw`, `.pyi`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `from_list`,
		EntryFilePatterns:  []string{`main.py`, `app.py`, `index.py`, `src/main.py`, `src/app.py`, `src/index.py`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`from\s+([a-zA-Z0-9_.]+)\s+import`),
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_.]+)`),
		},
	}
	defs.Languages[`mojo`] = &LanguageDefinition{
		Name:               `mojo`,
		Extensions:         []string{`.mojo`, `.🔥`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.mojo`, `app.mojo`, `index.mojo`, `src/main.mojo`, `src/app.mojo`, `src/index.mojo`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`from\s+([a-zA-Z0-9_.]+)\s+import`),
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_.]+)`),
		},
	}
	defs.Languages[`bend`] = &LanguageDefinition{
		Name:               `bend`,
		Extensions:         []string{`.bend`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.bend`, `app.bend`, `index.bend`, `src/main.bend`, `src/app.bend`, `src/index.bend`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:import|use)\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`go`] = &LanguageDefinition{
		Name:               `go`,
		Extensions:         []string{`.go`},
		ExportConvention:   `capitalized_name`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.go`, `app.go`, `cmd/main.go`},
		compiledPatterns:   []*regexp.Regexp{},
	}
	defs.Languages[`rust`] = &LanguageDefinition{
		Name:               `rust`,
		Extensions:         []string{`.rs`},
		ExportConvention:   `visibility_modifier`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.rs`, `lib.rs`, `src/main.rs`, `src/lib.rs`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`use\s+(?:crate::|self::|super::)?([a-zA-Z0-9_:]+)`),
			regexp.MustCompile(`mod\s+([a-zA-Z0-9_]+);`),
		},
	}
	defs.Languages[`java`] = &LanguageDefinition{
		Name:               `java`,
		Extensions:         []string{`.java`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.java`, `app.java`, `index.java`, `src/main.java`, `src/app.java`, `src/index.java`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+);?`),
		},
	}
	defs.Languages[`cpp`] = &LanguageDefinition{
		Name:               `cpp`,
		Extensions:         []string{`.cpp`, `.cxx`, `.cc`, `.hpp`, `.h`, `.c`, `.hxx`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.cpp`, `app.cpp`, `index.cpp`, `src/main.cpp`, `src/app.cpp`, `src/index.cpp`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*#include\s+["<]([^">]+)[">]`),
		},
	}
	defs.Languages[`csharp`] = &LanguageDefinition{
		Name:               `csharp`,
		Extensions:         []string{`.cs`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.cs`, `app.cs`, `index.cs`, `src/main.cs`, `src/app.cs`, `src/index.cs`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*using\s+([a-zA-Z0-9_.]+);?`),
		},
	}
	defs.Languages[`ruby`] = &LanguageDefinition{
		Name:               `ruby`,
		Extensions:         []string{`.rb`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.rb`, `app.rb`, `index.rb`, `src/main.rb`, `src/app.rb`, `src/index.rb`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:require|require_relative|load)\s+['"]([^'"]+)['"]`),
		},
	}
	defs.Languages[`php`] = &LanguageDefinition{
		Name:               `php`,
		Extensions:         []string{`.php`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.php`, `app.php`, `index.php`, `src/main.php`, `src/app.php`, `src/index.php`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*use\s+([a-zA-Z0-9_\\]+);`),
			regexp.MustCompile(`(?:require|require_once|include|include_once)\s*(?:\(\s*['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])`),
		},
	}
	defs.Languages[`swift`] = &LanguageDefinition{
		Name:               `swift`,
		Extensions:         []string{`.swift`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.swift`, `app.swift`, `index.swift`, `src/main.swift`, `src/app.swift`, `src/index.swift`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_]+)`),
		},
	}
	defs.Languages[`kotlin`] = &LanguageDefinition{
		Name:               `kotlin`,
		Extensions:         []string{`.kt`, `.kts`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.kt`, `app.kt`, `index.kt`, `src/main.kt`, `src/app.kt`, `src/index.kt`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+);?`),
		},
	}
	defs.Languages[`zig`] = &LanguageDefinition{
		Name:               `zig`,
		Extensions:         []string{`.zig`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.zig`, `app.zig`, `index.zig`, `src/main.zig`, `src/app.zig`, `src/index.zig`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`@import\s*\(\s*['"]([^'"]+)['"]\s*\)`),
		},
	}
	defs.Languages[`nim`] = &LanguageDefinition{
		Name:               `nim`,
		Extensions:         []string{`.nim`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.nim`, `app.nim`, `index.nim`, `src/main.nim`, `src/app.nim`, `src/index.nim`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:import|include)\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`gleam`] = &LanguageDefinition{
		Name:               `gleam`,
		Extensions:         []string{`.gleam`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.gleam`, `app.gleam`, `index.gleam`, `src/main.gleam`, `src/app.gleam`, `src/index.gleam`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`moonbit`] = &LanguageDefinition{
		Name:               `moonbit`,
		Extensions:         []string{`.mbt`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.mbt`, `app.mbt`, `index.mbt`, `src/main.mbt`, `src/app.mbt`, `src/index.mbt`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+"([^"]+)"`),
		},
	}
	defs.Languages[`typst`] = &LanguageDefinition{
		Name:               `typst`,
		Extensions:         []string{`.typ`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.typ`, `app.typ`, `index.typ`, `src/main.typ`, `src/app.typ`, `src/index.typ`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*#import\s+"([^"]+)"`),
		},
	}
	defs.Languages[`odin`] = &LanguageDefinition{
		Name:               `odin`,
		Extensions:         []string{`.odin`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.odin`, `app.odin`, `index.odin`, `src/main.odin`, `src/app.odin`, `src/index.odin`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`carbon`] = &LanguageDefinition{
		Name:               `carbon`,
		Extensions:         []string{`.carbon`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.carbon`, `app.carbon`, `index.carbon`, `src/main.carbon`, `src/app.carbon`, `src/index.carbon`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`vlang`] = &LanguageDefinition{
		Name:               `vlang`,
		Extensions:         []string{`.v`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.v`, `app.v`, `index.v`, `src/main.v`, `src/app.v`, `src/index.v`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+([a-zA-Z0-9_./]+)`),
		},
	}
	defs.Languages[`julia`] = &LanguageDefinition{
		Name:               `julia`,
		Extensions:         []string{`.jl`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.jl`, `app.jl`, `index.jl`, `src/main.jl`, `src/app.jl`, `src/index.jl`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:using|import|include)\s+(?:\(\s*['"]([^'"]+)['"]\s*\)|([a-zA-Z0-9_.]+))`),
		},
	}
	defs.Languages[`r`] = &LanguageDefinition{
		Name:               `r`,
		Extensions:         []string{`.r`, `.R`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.r`, `app.r`, `index.r`, `src/main.r`, `src/app.r`, `src/index.r`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:source|library|require)\s*\(\s*['"]?([^'")]+)['"]?\s*\)`),
		},
	}
	defs.Languages[`solidity`] = &LanguageDefinition{
		Name:               `solidity`,
		Extensions:         []string{`.sol`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.sol`, `app.sol`, `index.sol`, `src/main.sol`, `src/app.sol`, `src/index.sol`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:[^\n;]*?from\s+)?['"]([^'"]+)['"]`),
		},
	}
	defs.Languages[`dart`] = &LanguageDefinition{
		Name:               `dart`,
		Extensions:         []string{`.dart`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.dart`, `app.dart`, `index.dart`, `src/main.dart`, `src/app.dart`, `src/index.dart`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:import|export)\s+['"]([^'"]+)['"]`),
		},
	}
	defs.Languages[`lua`] = &LanguageDefinition{
		Name:               `lua`,
		Extensions:         []string{`.lua`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.lua`, `app.lua`, `index.lua`, `src/main.lua`, `src/app.lua`, `src/index.lua`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`require\s*(?:\(\s*['"]([^'"]+)['"]\s*\)|['"]([^'"]+)['"])`),
		},
	}
	defs.Languages[`elixir`] = &LanguageDefinition{
		Name:               `elixir`,
		Extensions:         []string{`.ex`, `.exs`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.ex`, `app.ex`, `index.ex`, `src/main.ex`, `src/app.ex`, `src/index.ex`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:alias|import|use|require)\s+([A-Z][a-zA-Z0-9_.]*)`),
		},
	}
	defs.Languages[`erlang`] = &LanguageDefinition{
		Name:               `erlang`,
		Extensions:         []string{`.erl`, `.hrl`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.erl`, `app.erl`, `index.erl`, `src/main.erl`, `src/app.erl`, `src/index.erl`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`-include(?:_lib)?\s*\(\s*["']([^"']+)["']\s*\)`),
		},
	}
	defs.Languages[`scala`] = &LanguageDefinition{
		Name:               `scala`,
		Extensions:         []string{`.scala`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.scala`, `app.scala`, `index.scala`, `src/main.scala`, `src/app.scala`, `src/index.scala`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+);?`),
		},
	}
	defs.Languages[`haskell`] = &LanguageDefinition{
		Name:               `haskell`,
		Extensions:         []string{`.hs`, `.lhs`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.hs`, `app.hs`, `index.hs`, `src/main.hs`, `src/app.hs`, `src/index.hs`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:qualified\s+)?([a-zA-Z0-9_.]+)`),
		},
	}
	defs.Languages[`ocaml`] = &LanguageDefinition{
		Name:               `ocaml`,
		Extensions:         []string{`.ml`, `.mli`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.ml`, `app.ml`, `index.ml`, `src/main.ml`, `src/app.ml`, `src/index.ml`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*open\s+([a-zA-Z0-9_.]+)`),
		},
	}
	defs.Languages[`clojure`] = &LanguageDefinition{
		Name:               `clojure`,
		Extensions:         []string{`.clj`, `.cljs`, `.cljc`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.clj`, `app.clj`, `index.clj`, `src/main.clj`, `src/app.clj`, `src/index.clj`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`\(:require\s+\[([a-zA-Z0-9_.-]+)`),
		},
	}
	defs.Languages[`fsharp`] = &LanguageDefinition{
		Name:               `fsharp`,
		Extensions:         []string{`.fs`, `.fsi`, `.fsx`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.fs`, `app.fs`, `index.fs`, `src/main.fs`, `src/app.fs`, `src/index.fs`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*(?:open|using)\s+([a-zA-Z0-9_.]+);?`),
		},
	}
	defs.Languages[`groovy`] = &LanguageDefinition{
		Name:               `groovy`,
		Extensions:         []string{`.groovy`},
		ExportConvention:   `all_top_level`,
		ImportBindingStyle: `none`,
		EntryFilePatterns:  []string{`main.groovy`, `app.groovy`, `index.groovy`, `src/main.groovy`, `src/app.groovy`, `src/index.groovy`},
		compiledPatterns: []*regexp.Regexp{
			regexp.MustCompile(`(?:^|\n)\s*import\s+(?:static\s+)?([a-zA-Z0-9_.*]+);?`),
		},
	}

	return defs
}
