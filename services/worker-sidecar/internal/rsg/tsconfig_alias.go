package rsg

import (
	"encoding/json"
	"sort"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// tsconfig/jsconfig 路径别名解析（移植 apps/client/src/engine/
// path-alias-resolver.ts parseTsConfigPaths/resolveAlias）：
// - 读取仓根 tsconfig.json / jsconfig.json 的 compilerOptions.paths + baseUrl
// - JSONC 容错（行/块注释剥离）
// - 通配别名（"@/*": ["src/*"]）按最长前缀匹配；非通配别名精确匹配
// 此前 Go 仅硬编码 @/→src/、~/、crate/ 三条约定，任何自定义别名
//（@app/*、#root/*、非 src baseUrl 的 @/*）解析失败 → 语义图静默缺边。
// ─────────────────────────────────────────────────────────────

// TsAlias 单条路径别名（通配：Prefix 为通配符前段、Target 为映射基；
// 非通配：IsExact=true 时 Prefix 须整串相等）。
type TsAlias struct {
	Prefix  string
	Target  string
	IsExact bool
}

// ParseTsConfigAliases 从 tsconfig/jsconfig 源文件提取别名（含 baseUrl
// 相对化；paths 值本身可含 baseUrl 外的绝对映射）。
func ParseTsConfigAliases(configFiles []SourceFileInput) []TsAlias {
	var aliases []TsAlias
	seen := map[string]bool{}

	for _, file := range configFiles {
		if !isTsConfigPath(file.Path) {
			continue
		}
		var doc struct {
			CompilerOptions struct {
				BaseURL string              `json:"baseUrl"`
				Paths   map[string][]string `json:"paths"`
			} `json:"compilerOptions"`
		}
		if err := json.Unmarshal([]byte(stripJsoncComments(file.Content)), &doc); err != nil {
			continue
		}
		baseURL := strings.Trim(doc.CompilerOptions.BaseURL, "/")
		for pattern, targets := range doc.CompilerOptions.Paths {
			for _, rawTarget := range targets {
				target := strings.Trim(rawTarget, "/")
				if target == "" {
					continue
				}
				if baseURL != "" {
					target = baseURL + "/" + target
				}
				if strings.HasSuffix(pattern, "/*") || strings.HasSuffix(pattern, "*") {
					prefix := strings.TrimSuffix(pattern, "*")
					target = strings.TrimSuffix(target, "*")
					key := "w:" + prefix + "->" + target
					if !seen[key] {
						seen[key] = true
						aliases = append(aliases, TsAlias{Prefix: prefix, Target: strings.TrimSuffix(target, "/")})
					}
				} else {
					key := "e:" + pattern + "->" + target
					if !seen[key] {
						seen[key] = true
						aliases = append(aliases, TsAlias{Prefix: pattern, Target: target, IsExact: true})
					}
				}
			}
		}
	}

	// 最长前缀优先（resolveAlias 语义）
	sort.SliceStable(aliases, func(i, j int) bool {
		return len(aliases[i].Prefix) > len(aliases[j].Prefix)
	})
	return aliases
}

func isTsConfigPath(path string) bool {
	normalized := strings.TrimLeft(path, "/")
	if strings.Contains(normalized, "/") {
		// 仅仓根（或 baseUrl 所在根目录）配置生效
		return false
	}
	return normalized == "tsconfig.json" || normalized == "jsconfig.json" ||
		normalized == "tsconfig.base.json"
}

// stripJsoncComments JSONC 容错：剥离 // 行注释与 /* */ 块注释（字符串字面量内豁免）。
func stripJsoncComments(src string) string {
	var b strings.Builder
	b.Grow(len(src))
	inString := false
	escaped := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if inString {
			b.WriteByte(c)
			if escaped {
				escaped = false
			} else if c == '\\' {
				escaped = true
			} else if c == '"' {
				inString = false
			}
			continue
		}
		switch {
		case c == '"':
			inString = true
			b.WriteByte(c)
		case c == '/' && i+1 < len(src) && src[i+1] == '/':
			for i < len(src) && src[i] != '\n' {
				i++
			}
			if i < len(src) {
				b.WriteByte('\n')
			}
		case c == '/' && i+1 < len(src) && src[i+1] == '*':
			i += 2
			for i+1 < len(src) && !(src[i] == '*' && src[i+1] == '/') {
				i++
			}
			i++ // 越过 '/'
		default:
			b.WriteByte(c)
		}
	}
	return b.String()
}
