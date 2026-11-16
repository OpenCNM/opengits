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
		// 严禁包含机械堆叠的多个顶格括号
		assert.NotContains(t, sliced, "}\n}\n}\n}")
		assert.NotContains(t, sliced, "}\n}\n}")
		// 必须吸附到语句边界，且末尾由单个括号优雅闭合
		assert.True(t, strings.HasSuffix(sliced, "}"))
		assert.Contains(t, sliced, "lines of defensive/internal logic omitted for pedagogy")
		// 验证完整保留了关键顶层语句
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
		// 严禁包含多括号堆叠
		assert.NotContains(t, sliced, "}\n}")
		// 结尾为单个闭合大括号
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
		assert.Contains(t, slicedMd, "lines of defensive/internal logic omitted for pedagogy (L1-L100)] -->")
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
			name: "占位符标记回填",
			input: "```go // [File 1#InitScheduler]\n<!-- CODE_SLOT -->\n```",
			contains: []string{
				"func InitScheduler(cfg *Config)",
			},
			omits: []string{
				"<!-- CODE_SLOT -->",
			},
		},
		{
			name: "隐式吸附：覆写 LLM 写的幻觉/截断代码",
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
			name: "普通伪代码围栏 100% 原样保留未受破坏",
			input: "```bash\ncurl -X POST https://api.example.com\n```",
			contains: []string{
				"```bash\ncurl -X POST https://api.example.com\n```",
			},
			omits: []string{},
		},
		{
			name: "嵌套围栏自适应升阶：内嵌三反引号时外层自动升阶为四反引号防穿透",
			input: "```bash // [File 3#L1-L10]\n```\n\n正文后续段落 <T>",
			contains: []string{
				"````bash // [File 3#L1-L10]\n# Title",
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
