package armor

import (
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestParseCodeSlotHeader(t *testing.T) {
	tests := []struct {
		name       string
		firstLine  string
		wantOK     bool
		wantIndex  int
		wantSymbol string
		wantStart  int
		wantEnd    int
		wantAspect CodeAspect
		wantLang   string
	}{
		{
			name:       "标准句柄加符号",
			firstLine:  "```go // [File 1#InitScheduler]",
			wantOK:     true,
			wantIndex:  1,
			wantSymbol: "InitScheduler",
			wantAspect: AspectAuto,
			wantLang:   "go",
		},
		{
			name:       "符号带 aspect core",
			firstLine:  "```ts // [File 2#WorkerPool:core]",
			wantOK:     true,
			wantIndex:  2,
			wantSymbol: "WorkerPool",
			wantAspect: AspectCore,
			wantLang:   "ts",
		},
		{
			name:       "符号带 aspect contract",
			firstLine:  "```rust // [File 3#Config:contract]",
			wantOK:     true,
			wantIndex:  3,
			wantSymbol: "Config",
			wantAspect: AspectContract,
			wantLang:   "rust",
		},
		{
			name:       "行号区间",
			firstLine:  "```go // [File 1#L10-L45]",
			wantOK:     true,
			wantIndex:  1,
			wantStart:  10,
			wantEnd:    45,
			wantAspect: AspectAuto,
			wantLang:   "go",
		},
		{
			name:       "行号区间带 aspect",
			firstLine:  "```python # [File 4#L20-L80:full]",
			wantOK:     true,
			wantIndex:  4,
			wantStart:  20,
			wantEnd:    80,
			wantAspect: AspectFull,
			wantLang:   "python",
		},
		{
			name:       "无注释斜杠的句柄",
			firstLine:  "```go [File 5#ProcessJob]",
			wantOK:     true,
			wantIndex:  5,
			wantSymbol: "ProcessJob",
			wantAspect: AspectAuto,
			wantLang:   "go",
		},
		{
			name:       "波浪线围栏",
			firstLine:  "~~~sql -- [File 2#CreateSchema]",
			wantOK:     true,
			wantIndex:  2,
			wantSymbol: "CreateSchema",
			wantAspect: AspectAuto,
			wantLang:   "sql",
		},
		{
			name:       "XML 格式独立插槽标签",
			firstLine:  `<!-- CODE_SLOT:file=3 symbol="RunServer" aspect="core" lang="go" -->`,
			wantOK:     true,
			wantIndex:  3,
			wantSymbol: "RunServer",
			wantAspect: AspectCore,
			wantLang:   "go",
		},
		{
			name:       "简写句柄省略File关键词带aspect",
			firstLine:  "```python // [1#create_tasks_prompt:core]",
			wantOK:     true,
			wantIndex:  1,
			wantSymbol: "create_tasks_prompt",
			wantAspect: AspectCore,
			wantLang:   "python",
		},
		{
			name:       "简写句柄省略File关键词纯符号",
			firstLine:  "```python // [1#chat_prompt]",
			wantOK:     true,
			wantIndex:  1,
			wantSymbol: "chat_prompt",
			wantAspect: AspectAuto,
			wantLang:   "python",
		},
		{
			name:      "普通无句柄代码块不命中",
			firstLine: "```bash",
			wantOK:    false,
		},
		{
			name:      "纯语言带文字不命中",
			firstLine: "```go // example pseudo code",
			wantOK:    false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, ok := ParseCodeSlotHeader(tt.firstLine)
			if !tt.wantOK {
				assert.False(t, ok)
				assert.Nil(t, got)
				return
			}
			require.True(t, ok)
			require.NotNil(t, got)
			assert.Equal(t, tt.wantIndex, got.FileIndex)
			assert.Equal(t, tt.wantSymbol, got.Symbol)
			assert.Equal(t, tt.wantStart, got.StartLine)
			assert.Equal(t, tt.wantEnd, got.EndLine)
			assert.Equal(t, tt.wantAspect, got.Aspect)
			assert.Equal(t, tt.wantLang, got.RawLang)
		})
	}
}

func TestSliceCodeByAspect(t *testing.T) {
	shortCode := `func Add(a, b int) int {
	return a + b
}`

	var longLines []string
	longLines = append(longLines, "func LongWorker(ctx context.Context) error {")
	for i := 1; i <= 60; i++ {
		longLines = append(longLines, "    // statement "+string(rune('0'+(i%10))))
	}
	longLines = append(longLines, "    return nil")
	longLines = append(longLines, "}")
	longCode := strings.Join(longLines, "\n")

	t.Run("短函数全量保留", func(t *testing.T) {
		sliced := SliceCodeByAspect(shortCode, "Add", "go", AspectAuto, 1, 3, 40)
		assert.Equal(t, shortCode, sliced)
	})

	t.Run("长函数自动降采样至核心骨架且补齐闭合大括号", func(t *testing.T) {
		sliced := SliceCodeByAspect(longCode, "LongWorker", "go", AspectAuto, 10, 72, 40)
		assert.Contains(t, sliced, "lines of defensive/internal logic omitted for pedagogy (L10-L72)")
		assert.True(t, strings.HasSuffix(sliced, "}"))
		assert.LessOrEqual(t, len(strings.Split(sliced, "\n")), 42)
	})

	t.Run("显式 contract 提取纯契约", func(t *testing.T) {
		sliced := SliceCodeByAspect(longCode, "LongWorker", "go", AspectContract, 10, 72, 40)
		assert.Contains(t, sliced, "func LongWorker(ctx context.Context) error { ... }")
		assert.NotContains(t, sliced, "statement")
	})

	t.Run("显式 full 强制 100% 完整源码", func(t *testing.T) {
		sliced := SliceCodeByAspect(longCode, "LongWorker", "go", AspectFull, 10, 72, 40)
		assert.Equal(t, longCode, sliced)
	})

	t.Run("深度嵌套代码吸附至顶级语句边界绝无堆叠多括号", func(t *testing.T) {
		nestedCode := `func ProcessMain() {
	initLogger()
	defer cleanup()

	if err := configure(); err != nil {
		fatal(err)
	}
	readConfig()

	if options.Enabled {
		log.Info("enabled")
		return
	}

	if options.SignTemplates {
		signer := newSigner()
		for _, item := range options.Templates {
			walk(item, func(sub string) error {
				if sub == "" {
					return nil
				}
				process(sub)
				return nil
			})
		}
	}

	runScan()
	postProcess()
	shutdown()
	cleanupAll()
}`
		sliced := SliceCodeByAspect(nestedCode, "ProcessMain", "go", AspectAuto, 1, 35, 20)
		assert.NotContains(t, sliced, "}\n}\n}\n}")
		assert.NotContains(t, sliced, "}\n}\n}")
		assert.True(t, strings.HasSuffix(sliced, "}"))
		assert.Contains(t, sliced, "lines of defensive/internal logic omitted for pedagogy")
		assert.Contains(t, sliced, "initLogger()")
		assert.Contains(t, sliced, "readConfig()")
	})

	t.Run("Nuclei真实main函数切片验证零多余括号且单括号闭合", func(t *testing.T) {
		nucleiMain := `func main() {
	options.Logger = gologger.DefaultLogger

	defer cleanupInlineSecretsDirs()

	// enables CLI specific configs mostly interactive behavior
	config.CurrentAppMode = config.AppModeCLI

	if err := runner.ConfigureOptions(); err != nil {
		fatalf("Could not initialize options: %s\n", err)
	}
	_ = readConfig()

	if options.ListDslSignatures {
		options.Logger.Info().Msgf("The available custom DSL functions are:")
		fmt.Println(dsl.GetPrintableDslFunctionSignatures(options.NoColor))
		return
	}

	// sign the templates if requested - only glob syntax is supported
	if options.SignTemplates {
		templates.UseOptionsForSigner(options)
		tsigner, err := signer.NewTemplateSigner(nil, nil)
		if err != nil {
			fatalf("Could not initialize signer crypto engine: %s\n", err)
		}

		successCounter := 0
		errorCounter := 0
		for _, item := range options.Templates {
			err := filepath.WalkDir(item, func(iterItem string, d fs.DirEntry, err error) error {
				if err != nil || d.IsDir() || !strings.HasSuffix(iterItem, extensions.YAML) {
					return nil
				}
				return nil
			})
			if err != nil {
				options.Logger.Error().Msgf("%s\n", err)
			}
		}
		return
	}
}`
		sliced := SliceCodeByAspect(nucleiMain, "main", "go", AspectAuto, 58, 138, 40)
		t.Logf("Sliced Nuclei Main Result:\n%s", sliced)
		assert.NotContains(t, sliced, "}\n}")
		assert.True(t, strings.HasSuffix(sliced, "\n}"))
		assert.Contains(t, sliced, "options.Logger = gologger.DefaultLogger")
		assert.Contains(t, sliced, "readConfig()")
		assert.Contains(t, sliced, "defer cleanupInlineSecretsDirs()")
		assert.Contains(t, sliced, "lines of defensive/internal logic omitted for pedagogy (L58-L138)")
	})

	t.Run("非类 C 语言降采样注释特化与零无效大括号", func(t *testing.T) {
		mdContent := strings.Repeat("# Heading\n\nParagraph text\n\n", 25)
		slicedMd := SliceCodeByAspect(mdContent, "README.md", "markdown", AspectAuto, 1, 100, 40)
		assert.Contains(t, slicedMd, "<!-- ... [")
		assert.Contains(t, slicedMd, "lines omitted for pedagogy (L1-L100)] -->")
		assert.NotContains(t, slicedMd, "}")
		assert.NotContains(t, slicedMd, "// ...")

		bashContent := strings.Repeat("echo 'step'\n\n", 30)
		slicedBash := SliceCodeByAspect(bashContent, "run.sh", "bash", AspectAuto, 1, 60, 40)
		assert.Contains(t, slicedBash, "# ... [")
		assert.Contains(t, slicedBash, "lines of defensive/internal logic omitted for pedagogy (L1-L60)]")
		assert.NotContains(t, slicedBash, "}")
		assert.NotContains(t, slicedBash, "// ...")
	})
}

func TestSliceCodeByAspect_PythonClassMethodBaseIndent(t *testing.T) {
	t.Helper()
	buildPyFunc := func(baseSpaces int, withDecorator bool) string {
		base := strings.Repeat(" ", baseSpaces)
		body := strings.Repeat(" ", baseSpaces+4)
		deep := strings.Repeat(" ", baseSpaces+8)
		var lines []string
		if withDecorator {
			lines = append(lines, base+"@classmethod")
		}
		lines = append(lines, base+"def run_pipeline(self, items):")
		for i := 0; i < 12; i++ {
			lines = append(lines, body+"step = i")
		}
		lines = append(lines, body+"if items:")
		for i := 0; i < 20; i++ {
			lines = append(lines, deep+"process(items)")
		}
		lines = append(lines, body+"return step")
		return strings.Join(lines, "\n")
	}

	tests := []struct {
		name         string
		source       string
		maxLines     int
		wantOmitPref string
		wantSnapLine string
		wantNotLast  string
	}{
		{
			name:         "顶层函数 baseIndent=0 吸附 4 空格边界",
			source:       buildPyFunc(0, false),
			maxLines:     20,
			wantOmitPref: "    # ... [",
			wantSnapLine: "    if items:",
			wantNotLast:  "        process(items)",
		},
		{
			name:         "类方法 baseIndent=4 吸附 8 空格边界且 8 空格对齐省略注释",
			source:       buildPyFunc(4, false),
			maxLines:     20,
			wantOmitPref: "        # ... [",
			wantSnapLine: "        if items:",
			wantNotLast:  "            process(items)",
		},
		{
			name:         "带装饰器类方法 baseIndent=4 吸附 8 空格边界",
			source:       buildPyFunc(4, true),
			maxLines:     20,
			wantOmitPref: "        # ... [",
			wantSnapLine: "        if items:",
			wantNotLast:  "            process(items)",
		},
		{
			name:         "嵌套类方法 baseIndent=8 吸附 12 空格边界",
			source:       buildPyFunc(8, false),
			maxLines:     20,
			wantOmitPref: "            # ... [",
			wantSnapLine: "            if items:",
			wantNotLast:  "                process(items)",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			sliced := SliceCodeByAspect(tt.source, "run_pipeline", "python", AspectAuto, 10, 45, tt.maxLines)
			lines := strings.Split(sliced, "\n")
			require.GreaterOrEqual(t, len(lines), 2)
			assert.True(t, strings.HasPrefix(lines[len(lines)-1], tt.wantOmitPref), "omit comment indent mismatch: %q", lines[len(lines)-1])
			assert.Equal(t, tt.wantSnapLine, lines[len(lines)-2])
			assert.NotEqual(t, tt.wantNotLast, lines[len(lines)-2])
		})
	}
}

func TestHydrateCodeSlotsAndSnap(t *testing.T) {
	files := []ArmorFileRef{
		{Path: "pkg/scheduler.go"},
		{Path: "pkg/pool.go"},
		{Path: "README.md"},
	}

	fakeRealInitCode := `func InitScheduler(cfg *Config) (*Scheduler, error) {
	if cfg == nil {
		return nil, errors.New("nil config")
	}
	return &Scheduler{pool: NewPool(cfg.Workers)}, nil
}`

	fakeRealPoolCode := `type Pool struct {
	workers int
}`

	fakeReadmeWithNestedCode := `# Title

` + "```bash\ngit clone repo\n```\n" + `
Done.`

	resolver := func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		if fileIndex == 1 && symbol == "InitScheduler" {
			return fakeRealInitCode, 45, 51, true
		}
		if fileIndex == 2 && symbol == "Pool" {
			return fakeRealPoolCode, 12, 14, true
		}
		if fileIndex == 3 {
			return fakeReadmeWithNestedCode, 1, 10, true
		}
		return "", 0, 0, false
	}

	tests := []struct {
		name     string
		input    string
		contains []string
		omits    []string
	}{
		{
			name: "空槽位回填",
			input: `# 调度系统

` + "```go // [File 1#InitScheduler]\n```\n" + `
解释完毕。`,
			contains: []string{
				"func InitScheduler(cfg *Config) (*Scheduler, error) {",
				"return &Scheduler{pool: NewPool(cfg.Workers)}, nil",
			},
			omits: []string{},
		},
		{
			name:  "占位符标记回填",
			input: "```go // [File 1#InitScheduler]\n<!-- CODE_SLOT -->\n```",
			contains: []string{
				"func InitScheduler(cfg *Config)",
			},
			omits: []string{
				"<!-- CODE_SLOT -->",
			},
		},
		{
			name:  "隐式吸附：覆写 LLM 写的幻觉/截断代码",
			input: "```go // [File 1#InitScheduler]\nfunc InitScheduler() {\n    // 幻觉代码与截断\n}\n```",
			contains: []string{
				"func InitScheduler(cfg *Config) (*Scheduler, error)",
				"return &Scheduler{pool: NewPool(cfg.Workers)}, nil",
			},
			omits: []string{
				"// 幻觉代码与截断",
			},
		},
		{
			name:  "普通伪代码围栏 100% 原样保留未受破坏",
			input: "```bash\ncurl -X POST https://api.example.com\n```",
			contains: []string{
				"```bash\ncurl -X POST https://api.example.com\n```",
			},
			omits: []string{},
		},
		{
			name:  "嵌套围栏自适应升阶：内嵌三反引号时外层自动升阶为四反引号防穿透",
			input: "```bash // [File 3#L1-L10]\n```\n\n正文后续段落 <T>",
			contains: []string{
				"````markdown // [File 3#L1-L10]\n# Title",
				"```bash\ngit clone repo\n```",
				"````\n\n正文后续段落 <T>",
			},
			omits: []string{
				"<!-- CODE_SLOT -->",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := HydrateCodeSlotsAndSnap(tt.input, files, resolver)
			for _, c := range tt.contains {
				assert.Contains(t, res, c)
			}
			for _, o := range tt.omits {
				assert.NotContains(t, res, o)
			}
		})
	}
}

func TestParseCodeSlotHeaderPathGuard(t *testing.T) {
	t.Helper()
	tests := []struct {
		name  string
		input string
		ok    bool
	}{
		{name: "合法：注释前缀 + 方括号句柄", input: "```go // [File 1#InitScheduler]", ok: true},
		{name: "合法：裸方括号句柄", input: "```go [File 2#L10-L45]", ok: true},
		{name: "合法：波浪线注释句柄", input: "~~~ts -- [File 2#Pool]", ok: true},
		{name: "合法：简写句柄", input: "```ts [1#sym:core]", ok: true},
		{name: "防护：已解析路径段含 file+数字 子串拒绝", input: "```ts // src/file2/x.ts#startServer", ok: false},
		{name: "防护：路径中 file-utils 不带紧随数字拒绝", input: "```ts // src/file-utils.ts#foo", ok: false},
		{name: "防护：正文散文中 file 子串拒绝", input: "```go // see the file 3 docs about setup", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, ok := ParseCodeSlotHeader(tt.input)
			assert.Equal(t, tt.ok, ok)
		})
	}
}

func TestHydrateCodeSlotsAndSnapBodyDrift(t *testing.T) {
	files := []ArmorFileRef{
		{Path: "pkg/scheduler.go"},
		{Path: "pkg/pool.go"},
		{Path: "README.md"},
	}

	fakeRealInitCode := `func InitScheduler(cfg *Config) (*Scheduler, error) {
	return &Scheduler{pool: NewPool(cfg.Workers)}, nil
}`

	fakeReadmeWithNestedCode := "# Title\n\n" + "```bash\ngit clone repo\n```\n" + "Done."

	resolver := func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		if fileIndex == 1 && (symbol == "" || symbol == "InitScheduler") {
			if reqStart == 9 && reqEnd == 16 {
				return "readme L9-L16 body", 9, 16, true
			}
			return fakeRealInitCode, 45, 47, true
		}
		if fileIndex == 3 {
			return fakeReadmeWithNestedCode, 1, 10, true
		}
		return "", 0, 0, false
	}

	t.Run("块内第2行注释句柄水合：句柄归一到首行", func(t *testing.T) {
		input := "```ts\n// [File 1#InitScheduler:core]\n<!-- CODE_SLOT -->\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "```go // [File 1#InitScheduler]")
		assert.Contains(t, res, "func InitScheduler(cfg *Config) (*Scheduler, error)")
		assert.NotContains(t, res, "CODE_SLOT")
	})

	t.Run("井号注释句柄（Python 风格）水合", func(t *testing.T) {
		input := "```python\n# [File 1#InitScheduler]\n<!-- CODE_SLOT -->\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "```go // [File 1#InitScheduler]")
		assert.Contains(t, res, "func InitScheduler(cfg *Config) (*Scheduler, error)")
	})

	t.Run("路径载荷反引号形态反查水合", func(t *testing.T) {
		input := "```md\n<!-- CODE_SLOT: `pkg/scheduler.go (L45-L47)` -->\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "[File 1#L45-L47]")
		assert.Contains(t, res, "func InitScheduler(cfg *Config) (*Scheduler, error)")
		assert.NotContains(t, res, "CODE_SLOT")
	})

	t.Run("路径载荷冒号形态反查水合", func(t *testing.T) {
		input := "```md\n<!-- CODE_SLOT: pkg/scheduler.go:L45-L47 -->\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "[File 1#L45-L47]")
		assert.NotContains(t, res, "CODE_SLOT")
	})

	t.Run("路径不在章节文件清单：保持原样交门禁裁决", func(t *testing.T) {
		input := "```md\n<!-- CODE_SLOT: `not-in-chapter/README.md (L1-L5)` -->\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Equal(t, input, res)
	})

	t.Run("md 源经块内句柄路径水合时围栏升阶防穿刺", func(t *testing.T) {
		input := "```md\n# [File 3#L1-L10]\n```\n\n正文后续段落"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "````markdown // [File 3#L1-L10]")
		assert.Contains(t, res, "```bash\ngit clone repo\n```")
	})

	t.Run("注释句柄在第3条非空行仍可探测，第4条不探测", func(t *testing.T) {
		input := "```ts\n\n// 前置说明\n\n// [File 1#InitScheduler]\n```"
		res := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, res, "func InitScheduler(cfg *Config) (*Scheduler, error)")

		tooDeep := "```ts\n// a\n// b\n// c\n// [File 1#InitScheduler]\n```"
		resDeep := HydrateCodeSlotsAndSnap(tooDeep, files, resolver)
		assert.Equal(t, tooDeep, resDeep)
	})
}

func TestScanResidualCodeSlots(t *testing.T) {
	tests := []struct {
		name     string
		input    string
		expected []ResidualSlot
	}{
		{
			name:     "干净正文零残余",
			input:    "# 标题\n\n```go // src/a.ts#Foo\nreal code\n```\n\n收尾。",
			expected: nil,
		},
		{
			name:  "围栏内 CODE_SLOT 标记",
			input: "```ts\n<!-- CODE_SLOT -->\n```",
			expected: []ResidualSlot{
				{BlockIndex: 1, Kind: ResidualKindMarker, Snippet: "```ts"},
			},
		},
		{
			name:  "正文独立 CODE_SLOT 占位",
			input: "段落甲。\n\n<!-- CODE_SLOT: file=1 -->\n\n段落乙。",
			expected: []ResidualSlot{
				{BlockIndex: 0, Kind: ResidualKindMarker, Snippet: "<!-- CODE_SLOT: file=1 -->"},
			},
		},
		{
			name:  "非 mermaid 空体围栏",
			input: "前文。\n\n```ts\n```\n\n后文。",
			expected: []ResidualSlot{
				{BlockIndex: 1, Kind: ResidualKindEmptyBlock, Snippet: "```ts"},
			},
		},
		{
			name:     "mermaid 空体围栏不判缺陷",
			input:    "```mermaid\n```\n",
			expected: nil,
		},
		{
			name:  "not found in archive 失败哨兵",
			input: "```ts // [File 9#Ghost]\n// [Source code for Ghost not found in archive]\n```",
			expected: []ResidualSlot{
				{BlockIndex: 1, Kind: ResidualKindNotFoundSent, Snippet: "```ts // [File 9#Ghost]"},
			},
		},
		{
			name:  "多块混合按块序号上报",
			input: "```ts\n```\n\n正文。\n\n<!-- CODE_SLOT -->\n\n```go\n<!-- CODE_SLOT -->\n```",
			expected: []ResidualSlot{
				{BlockIndex: 1, Kind: ResidualKindEmptyBlock, Snippet: "```ts"},
				{BlockIndex: 0, Kind: ResidualKindMarker, Snippet: "<!-- CODE_SLOT -->"},
				{BlockIndex: 2, Kind: ResidualKindMarker, Snippet: "```go"},
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ScanResidualCodeSlots(tt.input)
			assert.Equal(t, tt.expected, got)
		})
	}
}

func reviewArchiveResolver(calls *int) CodeSlotResolver {
	return func(fileIndex int, relPath, symbol string, reqStart, reqEnd int) (string, int, int, bool) {
		*calls++
		return "package archive\nfunc FromArchive() {}\n", 1, 2, true
	}
}

func TestParseCodeSlotHeaderHandleBoundary(t *testing.T) {
	t.Helper()
	tests := []struct {
		name  string
		input string
		ok    bool
	}{
		{name: "合法：符号句柄", input: "```go // [File 1#InitScheduler]", ok: true},
		{name: "合法：行号区间句柄", input: "```go // [File 1#L10-L45]", ok: true},
		{name: "合法：整文件句柄", input: "```ts // [File 1]", ok: true},
		{name: "合法：波浪线注释句柄", input: "~~~sql -- [File 2#CreateSchema]", ok: true},
		{name: "合法：简写符号句柄", input: "```python // [1#chat_prompt]", ok: true},
		{name: "防护：根级 file1.ts 路径段拒绝", input: "```ts // file1.ts#start", ok: false},
		{name: "防护：根级 file2 目录路径段拒绝", input: "```ts // file2/x.ts#startServer", ok: false},
		{name: "防护：file3_test.go 测试文件路径段拒绝", input: "```go // file3_test.go#TestFoo", ok: false},
		{name: "防护：file 12 后接说明文字拒绝", input: "```ts // file 12 — scheduler notes", ok: false},
		{name: "防护：带目录前缀的 file2 路径段拒绝", input: "```ts // src/file2/x.ts#startServer", ok: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, ok := ParseCodeSlotHeader(tt.input)
			assert.Equal(t, tt.ok, ok)
		})
	}
}

func TestHydrateCodeSlotsAndSnapFreeBlockNotHijacked(t *testing.T) {
	t.Helper()
	files := []ArmorFileRef{{Path: "pkg/a.go"}, {Path: "pkg/b.go"}, {Path: "pkg/c.go"}}
	tests := []struct {
		name  string
		block string
	}{
		{name: "Python 步骤编号注释", block: "```python\n# [1] Import libraries\nimport numpy as np\n\n# [2] Create data\ndata = [1, 2, 3]\n```"},
		{name: "TS 步骤注释", block: "```ts\n// Step [1] define the handler\nconst h = () => 1;\n```"},
		{name: "Go 文献引用注释", block: "```go\n// [1] https://example.com/spec\nfunc A() {}\n```"},
		{name: "SQL 步骤注释", block: "```sql\n-- [1] primary key\nSELECT 1;\n```"},
		{name: "JS 块注释星号行", block: "```js\n/**\n * [2] NOTE here\n */\nfunction f() {}\n```"},
		{name: "file N 说明注释", block: "```go\n// file 2: entry point\nfunc main() {}\n```"},
		{name: "C 预处理宏下标", block: "```c\n#define X[1] 2\nint main(){}\n```"},
		{name: "TS 下标注释", block: "```ts\n// arr[1] is the head\nconst h = 1;\n```"},
		{name: "句柄注释在第 3 行但块内有代码", block: "```python\nimport os\nimport sys\n# [2] data\ndata = 1\n```"},
		{name: "纯注释裸步骤编号", block: "```text\n# [1]\n# [2]\n```"},
		{name: "纯注释编号代码", block: "```python\n# [1] def foo():\n# [2]     return 1\n```"},
		{name: "占位注释后跟手写代码（歧义：回到不水合）", block: "```ts\n<!-- CODE_SLOT -->\nexport const typedByLlm = 1;\n```"},
		{name: "句柄注释后跟手写代码（歧义：回到不水合）", block: "```ts\n// [File 1#Foo]\nexport const Foo = 1;\n```"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			got := HydrateCodeSlotsAndSnap(tt.block, files, reviewArchiveResolver(&calls))
			assert.Equal(t, tt.block, got, "自由代码块必须 100% 原样保留")
			assert.Zero(t, calls, "自由代码块不得触发插槽解析器")
		})
	}
}

func TestHydrateCodeSlotsAndSnapBodyHintSlotBlocks(t *testing.T) {
	t.Helper()
	files := []ArmorFileRef{{Path: "pkg/a.go"}, {Path: "pkg/b.go"}, {Path: "pkg/c.go"}}
	tests := []struct {
		name       string
		block      string
		wantHeader string
	}{
		{name: "句柄注释 + 占位", block: "```ts\n// [File 1#Foo:core]\n<!-- CODE_SLOT -->\n```", wantHeader: "```go // [File 1#Foo]"},
		{name: "说明注释 + 句柄注释", block: "```ts\n\n// 前置说明\n\n// [File 1#Foo]\n```", wantHeader: "```go // [File 1#Foo]"},
		{name: "井号简写句柄", block: "```python\n# [1#foo]\n<!-- CODE_SLOT -->\n```", wantHeader: "```go // [File 1#foo]"},
		{name: "井井号简写句柄", block: "```ts\n// [#1#foo]\n```", wantHeader: "```go // [File 1#foo]"},
		{name: "整文件关键字句柄", block: "```ts\n// [File 1]\n```", wantHeader: "```go // [File 1]"},
		{name: "XML 路径载荷", block: "```md\n<!-- CODE_SLOT: `pkg/b.go (L1-L2)` -->\n```", wantHeader: "```go // [File 2#L1-L2]"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			calls := 0
			got := HydrateCodeSlotsAndSnap(tt.block, files, reviewArchiveResolver(&calls))
			assert.Contains(t, got, tt.wantHeader)
			assert.Contains(t, got, "func FromArchive() {}", "槽块必须被归档源码水合")
			assert.NotContains(t, got, "CODE_SLOT")
			assert.Equal(t, 1, calls)
		})
	}
}

func TestScanResidualCodeSlotsCodeSlotLiteral(t *testing.T) {
	t.Helper()
	files := []ArmorFileRef{{Path: "armor/code_slot.go"}}
	resolver := func(int, string, string, int, int) (string, int, int, bool) {
		return "// CODE_SLOT marker handling\nfunc scan() { _ := \"CODE_SLOT\" }", 1, 2, true
	}
	hydrated := HydrateCodeSlotsAndSnap("```go // [File 1#scan]\n```\n", files, resolver)
	assert.Empty(t, ScanResidualCodeSlots(hydrated), "已水合真实源码里的 CODE_SLOT 字面量不是残余")

	tests := []struct {
		name  string
		input string
	}{
		{name: "HTML 占位行", input: "```ts\n<!-- CODE_SLOT -->\n```"},
		{name: "纯注释块占位", input: "```ts\n// CODE_SLOT\n```"},
		{name: "散文独立占位", input: "段落甲。\n\n<!-- CODE_SLOT: file=1 -->\n\n段落乙。"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.NotEmpty(t, ScanResidualCodeSlots(tt.input), "真占位必须被检出")
		})
	}
}

func TestIsResolvedFenceHeader(t *testing.T) {
	t.Helper()
	tests := []struct {
		input string
		want  bool
	}{
		{input: "```ts // src/main.ts#start", want: true},
		{input: "```go // pkg/a.go (L10-L45)", want: true},
		{input: "```go // pkg/a.go (L10)", want: true},
		{input: "```md // docs/README.md", want: true},
		{input: "````md // docs/README.md#Intro", want: true},
		{input: "```ts // src/main.ts#start", want: true},
		{input: "```ts // [File 2#InitScheduler]", want: false},
		{input: "```js // example usage", want: false},
		{input: "```bash # install deps", want: false},
		{input: "```ts", want: false},
		{input: "```python", want: false},
		{input: "```ts // src/main.ts trailing prose", want: false},
	}
	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			assert.Equal(t, tt.want, IsResolvedFenceHeader(tt.input))
		})
	}
}

func TestSplitFencedRegions(t *testing.T) {
	t.Helper()
	content := "导言。\n\n```mermaid\n\nflowchart LR\n\nA-->B\n\n```\n\n尾段。"
	regions := SplitFencedRegions(content)
	require.Len(t, regions, 3)
	assert.False(t, regions[0].IsFence)
	assert.Equal(t, "导言。\n\n", regions[0].Text)
	assert.True(t, regions[1].IsFence)
	assert.Equal(t, "```mermaid\n\nflowchart LR\n\nA-->B\n\n```", regions[1].Text)
	assert.False(t, regions[2].IsFence)
	assert.Equal(t, "\n\n尾段。", regions[2].Text)

	joined := ""
	for _, r := range regions {
		joined += r.Text
	}
	assert.Equal(t, content, joined, "区域拼接必须逐字节还原")
}

func TestApplyFencedBlockEdits(t *testing.T) {
	t.Helper()
	const fenceHead = "```ts // [File 1#Foo]"
	tests := []struct {
		name  string
		input string
		edits []SlotEdit
		want  string
	}{
		{
			name:  "map：整块替换为规范空体槽",
			input: "前文。\n\n```ts\n<!-- CODE_SLOT -->\n```\n\n后文。",
			edits: []SlotEdit{{BlockIndex: 1, Mode: SlotEditModeMap, FenceHeader: fenceHead}},
			want:  "前文。\n\n```ts // [File 1#Foo]\n```\n\n后文。",
		},
		{
			name:  "drop：移除并收敛相邻空行",
			input: "前文。\n\n```ts\n```\n\n后文。",
			edits: []SlotEdit{{BlockIndex: 1, Mode: SlotEditModeDrop}},
			want:  "前文。\n\n后文。",
		},
		{
			name:  "drop 连续两块：不遗留 3+ 连续换行",
			input: "前文。\n\n```ts\n```\n\n中段。\n\n```go\n```\n\n后文。",
			edits: []SlotEdit{{BlockIndex: 1, Mode: SlotEditModeDrop}, {BlockIndex: 2, Mode: SlotEditModeDrop}},
			want:  "前文。\n\n中段。\n\n后文。",
		},
		{
			name:  "文档开头的块被 drop",
			input: "```ts\n```\n\n后文。",
			edits: []SlotEdit{{BlockIndex: 1, Mode: SlotEditModeDrop}},
			want:  "后文。",
		},
		{
			name:  "越界与未知序号静默忽略",
			input: "```ts\n```\n",
			edits: []SlotEdit{{BlockIndex: 9, Mode: SlotEditModeDrop}},
			want:  "```ts\n```\n",
		},
		{
			name:  "内联紧凑围栏计入序号但不产出视图",
			input: "行内 ```x``` 示例。\n\n```ts\n```\n",
			edits: []SlotEdit{{BlockIndex: 2, Mode: SlotEditModeDrop}},
			want:  "行内 ```x``` 示例。\n\n",
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, ApplyFencedBlockEdits(tt.input, tt.edits))
		})
	}
}

func TestEnumerateFencedBlocksDroppable(t *testing.T) {
	t.Helper()
	content := "a ```x``` b\n\n```ts\n<!-- CODE_SLOT -->\n```\n\n```ts\n<!-- CODE_SLOT -->\nconsole.log(1)\n```\n\n```ts\n// [Source code for Ghost not found in archive]\n```\n"
	views := EnumerateFencedBlocks(content)
	require.Len(t, views, 3)
	assert.Equal(t, []int{2, 3, 4}, []int{views[0].Index, views[1].Index, views[2].Index})
	assert.Equal(t, []bool{true, false, true}, []bool{views[0].BodyDroppable, views[1].BodyDroppable, views[2].BodyDroppable})

	residualIdx := []int{}
	for _, r := range ScanResidualCodeSlots(content) {
		residualIdx = append(residualIdx, r.BlockIndex)
	}
	assert.Equal(t, []int{2, 3, 4}, residualIdx, "枚举与残余扫描的块序号严格同源（块 2、3 含占位行，块 4 为失败哨兵）")
}

func TestHydrateCodeSlotsAndSnapReRunOnConvergedContent(t *testing.T) {
	t.Helper()
	files := []ArmorFileRef{{Path: "a.ts"}, {Path: "file1.ts"}}
	src := map[string]string{
		"a.ts":     "export function start() { return 'A' }",
		"file1.ts": "export function start() { return 'FILE1' }",
	}
	resolver := func(_ int, relPath, _ string, _, _ int) (string, int, int, bool) {
		return src[relPath], 1, 1, true
	}
	first := HydrateCodeSlotsAndSnap("```ts // [File 2#start]\n```\n", files, resolver)
	assert.Contains(t, first, "return 'FILE1'")

	second := HydrateCodeSlotsAndSnap(first, files, resolver)
	assert.Equal(t, first, second, "已收敛正文重跑漏斗必须幂等")
	assert.Contains(t, second, "return 'FILE1'", "file1.ts#start 的块体不得被换成 a.ts 的代码")
}

func TestHydrateCodeSlotsPhysicalLanguageOverride(t *testing.T) {
	t.Helper()

	files := []ArmorFileRef{
		{Path: "pkg/scheduler.go"},
		{Path: "src/main.ts"},
		{Path: "docs/communication-protocol-layers.md"},
		{Path: "Makefile"},
	}

	longMarkdown := strings.Repeat("# Protocol Layer\n\nDetails about IPC.\n\n", 20)
	nestedMarkdown := "# Z Code 通信协议分层\n\n```text\n第 3 层: 内容\n```\n\n总结。"

	tests := []struct {
		name           string
		input          string
		resolveFn      CodeSlotResolver
		wantContains   []string
		wantNotContain []string
		checkResolved  bool
		wantResolved   string
	}{
		{
			name:  "长 md 文件被错标 ts：覆写为 markdown 并走文档空行切片与 HTML 省略注释",
			input: "```ts // [File 3#L1-L60]\n```\n",
			resolveFn: func(fileIndex int, _ string, _ string, _, _ int) (string, int, int, bool) {
				if fileIndex == 3 {
					return longMarkdown, 1, 60, true
				}
				return "", 0, 0, false
			},
			wantContains: []string{
				"```markdown // [File 3#L1-L60]",
				"<!-- ... [",
				"lines omitted for pedagogy (L1-L60)] -->",
			},
			wantNotContain: []string{
				"```ts",
				"// ...",
				"}",
			},
		},
		{
			name:  "含内嵌围栏的 md 被错标 ts：围栏升阶且语言覆写为 markdown 并可被 Stage 2 还原",
			input: "```ts // [File 3#L1-L10]\n```\n",
			resolveFn: func(fileIndex int, _ string, _ string, _, _ int) (string, int, int, bool) {
				if fileIndex == 3 {
					return nestedMarkdown, 1, 10, true
				}
				return "", 0, 0, false
			},
			wantContains: []string{
				"````markdown // [File 3#L1-L10]",
				"```text\n第 3 层: 内容\n```",
			},
			wantNotContain: []string{
				"```ts",
				"````ts",
			},
			checkResolved: true,
			wantResolved:  "````markdown // docs/communication-protocol-layers.md (L1-L10)",
		},
		{
			name:  "空语言标记围栏按物理后缀补齐为 go",
			input: "``` // [File 1#InitScheduler]\n```\n",
			resolveFn: func(fileIndex int, _ string, _ string, _, _ int) (string, int, int, bool) {
				if fileIndex == 1 {
					return "func InitScheduler() {}", 1, 1, true
				}
				return "", 0, 0, false
			},
			wantContains: []string{
				"```go // [File 1#InitScheduler]",
				"func InitScheduler() {}",
			},
		},
		{
			name:  "无扩展名文件（DetectSourceLanguage 回退 text）保留 LLM 指定语言",
			input: "```makefile // [File 4#L1-L5]\n```\n",
			resolveFn: func(fileIndex int, _ string, _ string, _, _ int) (string, int, int, bool) {
				if fileIndex == 4 {
					return "build:\n\tgo build ./...", 1, 2, true
				}
				return "", 0, 0, false
			},
			wantContains: []string{
				"```makefile // [File 4#L1-L5]",
				"build:\n\tgo build ./...",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			hydrated := HydrateCodeSlotsAndSnap(tt.input, files, tt.resolveFn)
			for _, want := range tt.wantContains {
				assert.Contains(t, hydrated, want)
			}
			for _, forbid := range tt.wantNotContain {
				assert.NotContains(t, hydrated, forbid)
			}
			if tt.checkResolved {
				resolved := ResolveFileHandles(hydrated, files)
				assert.Contains(t, resolved, tt.wantResolved)
			}
		})
	}
}

func TestHydrateCodeSlotsMarkdownBareHandleGuards(t *testing.T) {
	t.Helper()

	files := []ArmorFileRef{
		{Path: "src/main.ts"},
		{Path: "docs/communication-protocol-layers.md"},
		{Path: "README.md"},
	}

	resolver := func(fileIndex int, _ string, symbol string, _, _ int) (string, int, int, bool) {
		if fileIndex == 2 {
			return "# Z Code 通信协议分层\n\n正文说明", 1, 3, true
		}
		if fileIndex == 3 && symbol == "get_current_time" {
			return "def get_current_time():\n    return 42", 10, 11, true
		}
		if fileIndex == 3 {
			return "# README Title\n\nIntro line", 1, 3, true
		}
		return "", 0, 0, false
	}

	t.Run("json/ts 示例带裸 md 句柄时不被 md L1-L60 覆盖且剥离句柄", func(t *testing.T) {
		input := "```json // [File 2]\n{\n  \"id\": \"req-1\",\n  \"method\": \"v4/command\"\n}\n```\n\n" +
			"```ts // [File 2]\nwindow.postMessage({ type: 'ready' });\n```"

		hydrated := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, hydrated, "```json\n{\n  \"id\": \"req-1\",\n  \"method\": \"v4/command\"\n}\n```")
		assert.Contains(t, hydrated, "```ts\nwindow.postMessage({ type: 'ready' });\n```")
		assert.NotContains(t, hydrated, "# Z Code 通信协议分层")
		assert.NotContains(t, hydrated, "[File 2]")
	})

	t.Run("同章多次出现同一 md 裸句柄：首块水合，次块带图体保留去句柄，三块空槽剔除", func(t *testing.T) {
		input := "```text // [File 2]\n```\n\n" +
			"```text // [File 2]\nUI -> Host -> CLI\n```\n\n" +
			"```text // [File 2]\n<!-- CODE_SLOT -->\n```\n\n收尾。"

		hydrated := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Equal(t, 1, strings.Count(hydrated, "# Z Code 通信协议分层"), "同章裸 .md 句柄最多水合一次")
		assert.Contains(t, hydrated, "```markdown // [File 2]\n# Z Code 通信协议分层")
		assert.Contains(t, hydrated, "```text\nUI -> Host -> CLI\n```")
		assert.NotContains(t, hydrated, "<!-- CODE_SLOT -->")
		assert.Empty(t, ScanResidualCodeSlots(hydrated))
	})

	t.Run("md 带 symbol 锚点提取嵌入式代码时保留原代码语言", func(t *testing.T) {
		input := "```python // [File 3#get_current_time]\n```\n"
		hydrated := HydrateCodeSlotsAndSnap(input, files, resolver)
		assert.Contains(t, hydrated, "```python // [File 3#get_current_time]\ndef get_current_time():")
		assert.NotContains(t, hydrated, "```markdown")
	})
}
