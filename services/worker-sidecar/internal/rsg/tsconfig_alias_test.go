package rsg

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseTsConfigAliases(t *testing.T) {
	config := SourceFileInput{
		Path: "tsconfig.json",
		Content: `{
			// 编译选项（JSONC 注释应被剥离）
			"compilerOptions": {
				"baseUrl": "app", /* 块注释 */
				"paths": {
					"@/*": ["src/*"],
					"@app/*": ["modules/app/*"],
					"#root/*": ["src/*"],
					"@shared": ["src/shared/index.ts"]
				}
			}
		}`,
	}

	aliases := ParseTsConfigAliases([]SourceFileInput{config})
	byPrefix := map[string]TsAlias{}
	for _, a := range aliases {
		byPrefix[a.Prefix] = a
	}
	require.Contains(t, byPrefix, "@/")
	assert.Equal(t, "app/src", byPrefix["@/"].Target, "baseUrl 相对化")
	require.Contains(t, byPrefix, "@app/")
	assert.Equal(t, "app/modules/app", byPrefix["@app/"].Target)
	require.Contains(t, byPrefix, "@shared")
	assert.True(t, byPrefix["@shared"].IsExact)
	assert.Equal(t, "app/src/shared/index.ts", byPrefix["@shared"].Target)

	assert.Equal(t, "@shared", aliases[0].Prefix)
	assert.Equal(t, "#root/", aliases[1].Prefix)
}

func TestResolveImportTargetWithTsAliases(t *testing.T) {
	defs := &LanguageDefinitions{ResolvableExtensions: []string{".ts", ".tsx"}}
	fileSet := map[string]bool{
		"app/modules/app/util.ts": true,
		"custom/lib/helper.ts":    true,
		"src/legacy/util.ts":      true,
	}
	tsAliases := []TsAlias{
		{Prefix: "@app/", Target: "app/modules/app"},
		{Prefix: "@/", Target: "custom"},
	}

	tests := []struct {
		name string
		emp  string
		from string
		want string
	}{
		{name: "wildcard alias resolves", emp: "@app/util", from: "app/main.ts", want: "app/modules/app/util.ts"},
		{name: "longest prefix wins", emp: "@app/util", from: "app/main.ts", want: "app/modules/app/util.ts"},
		{name: "custom baseUrl @/ no longer misroutes", emp: "@/lib/helper", from: "app/main.ts", want: "custom/lib/helper.ts"},
		{name: "unresolved stays empty", emp: "@/nope", from: "app/main.ts", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := defs.ResolveImportTarget(tt.emp, tt.from, fileSet, nil, tsAliases)
			assert.Equal(t, tt.want, got)
		})
	}

	t.Run("no tsconfig: @/ falls back to src/ convention", func(t *testing.T) {
		got := defs.ResolveImportTarget("@/legacy/util", "app/main.ts", fileSet, nil)
		assert.Equal(t, "src/legacy/util.ts", got)
	})
}
