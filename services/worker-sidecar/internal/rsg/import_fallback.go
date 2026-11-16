package rsg

import (
	"regexp"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// Import 行兜底提取（保留，与已退役的符号/调用点兜底不同）：
// - import 语句是 1D 无嵌套单行文本（正则合法辖区），且模式集中于
//   language-definitions.json（SSOT），非散落硬编码；
// - AST import 捕获（@import.source）目前仅覆盖少数语言——其余语言的
//   import 边一直由本兜底供血（rsg.golden.json 对拍锁定：php 的
//   index.php→Order.php 边即来源于此），删除会静默丢真实边（红线 1）；
// - 迁移路径：逐门补齐 .scm import 捕获（php.scm 已为先例，AST 命中
//   即优先生效），全量覆盖后本文件整体退役。
//
// LINT-EXEMPT: code-syntax-regex-fallback (BUG-65 存量 import 兜底自
// symbol_extractor_fallback.go 迁居至此并收窄为仅 import;符号/调用点
// 兜底已随 BUG-65 关闭退役,本文件待 .scm import 捕获全量覆盖后删除)
// ─────────────────────────────────────────────────────────────

var (
	tsNamedImportRegex = regexp.MustCompile(`import\s+(?:([A-Za-z0-9_$]+)\s*,?\s*)?(?:\{([^}]+)\})?\s*from\s*['"]([^'"]+)['"]`)
	pyFromImport       = regexp.MustCompile(`^\s*from\s+([a-zA-Z0-9_.]+)\s+import\s+([^\n#]+)`)
)

func (d *LanguageDefinitions) extractFallbackImports(content, filePath string, lines []string, importBindingStyle string) []ImportRecord {
	var imports []ImportRecord
	if importBindingStyle == "named_specifiers" {
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "import") {
				continue
			}
			sm := tsNamedImportRegex.FindStringSubmatch(trimmed)
			if len(sm) > 3 {
				module := sm[3]
				var bindings []string
				if sm[1] != "" {
					bindings = append(bindings, sm[1])
				}
				if sm[2] != "" {
					bindings = append(bindings, parseNamedImportBindings(sm[2])...)
				}
				if module != "" {
					imports = append(imports, ImportRecord{
						Module:   module,
						Bindings: bindings,
					})
				}
			}
		}
	} else if importBindingStyle == "from_list" {
		for _, line := range lines {
			trimmed := strings.TrimSpace(line)
			if !strings.HasPrefix(trimmed, "from ") {
				continue
			}
			sm := pyFromImport.FindStringSubmatch(trimmed)
			if len(sm) > 2 {
				module := sm[1]
				var bindings []string
				rawBindings := strings.Split(sm[2], ",")
				for _, b := range rawBindings {
					b = strings.TrimSpace(b)
					if b == "" {
						continue
					}
					// handle "foo as bar" -> original binding is "foo"
					parts := strings.Fields(b)
					if len(parts) > 0 {
						bindings = append(bindings, parts[0])
					}
				}
				if module != "" {
					imports = append(imports, ImportRecord{
						Module:   module,
						Bindings: bindings,
					})
				}
			}
		}
	} else if importBindingStyle == "none" {
		rawImports := d.ExtractImportPaths(content, filePath)
		sort.Strings(rawImports)
		for _, imp := range rawImports {
			imports = append(imports, ImportRecord{
				Module:   imp,
				Bindings: []string{},
			})
		}
	}

	return imports
}

func parseNamedImportBindings(raw string) []string {
	var bindings []string
	for _, b := range strings.Split(raw, ",") {
		b = strings.TrimSpace(b)
		if b == "" {
			continue
		}
		// handle "foo as bar" -> original binding is "foo"
		parts := strings.Fields(b)
		if len(parts) > 0 {
			bindings = append(bindings, parts[0])
		}
	}
	return bindings
}
