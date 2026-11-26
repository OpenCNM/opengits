package rsg

import (
	"regexp"
	"sort"
	"strings"
)

// LINT-EXEMPT: code-syntax-regex-fallback (1D single-line import fallback for languages without Tree-sitter @import.source queries)

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

		parts := strings.Fields(b)
		if len(parts) > 0 {
			bindings = append(bindings, parts[0])
		}
	}
	return bindings
}
