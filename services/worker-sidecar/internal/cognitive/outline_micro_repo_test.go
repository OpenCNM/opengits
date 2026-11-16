package cognitive

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// setupMittMicroRepoFixture creates in-memory file content and tree nodes mimicking developit/mitt.
func setupMittMicroRepoFixture(t *testing.T) ([]GitNode, FileReader, Patterns) {
	t.Helper()

	files := map[string]string{
		"README.md": `# Mitt

> Tiny 200 byte functional event emitter / pubsub.

## Install
npm install --save mitt

## Quick Start
Get up and running in seconds.

## Usage
import mitt from 'mitt'

const emitter = mitt()

emitter.on('foo', e => console.log('foo', e) )
emitter.emit('foo', { a: 'b' })

## API
### mitt
Creates an event emitter.
### on
Register an event handler for the given type.
### off
Remove an event handler for the given type.
### emit
Invoke all handlers for the given type.
`,
		"src/index.ts": `export type EventType = string | symbol;
export type Handler<T = unknown> = (event: T) => void;
export type WildcardHandler<T = Record<string, unknown>> = (type: EventType, event: T) => void;
export type EventHandlerList<T = unknown> = Array<Handler<T>>;
export type WildCardEventHandlerList<T = Record<string, unknown>> = Array<WildcardHandler<T>>;
export type EventHandlerMap<Events extends Record<EventType, unknown>> = Map<
	keyof Events | '*',
	EventHandlerList<Events[keyof Events]> | WildCardEventHandlerList<Events>
>;

export interface Emitter<Events extends Record<EventType, unknown>> {
	all: EventHandlerMap<Events>;
	on<Key extends keyof Events>(type: Key, handler: Handler<Events[Key]>): void;
	off<Key extends keyof Events>(type: Key, handler?: Handler<Events[Key]>): void;
	emit<Key extends keyof Events>(type: Key, event: Events[Key]): void;
}

export default function mitt<Events extends Record<EventType, unknown>>(
	all?: EventHandlerMap<Events>
): Emitter<Events> {
	all = all || new Map();
	return {
		all,
		on(type, handler) {},
		off(type, handler) {},
		emit(type, event) {}
	};
}
`,
		"test/index.test.ts": `import mitt from '../src';

describe('mitt', () => {
	it('should default to empty all map', () => {
		const inst = mitt();
		expect(inst.all).toBeDefined();
	});

	it('should register handler with on', () => {
		const inst = mitt();
		inst.on('foo', () => {});
	});

	it('should emit events with emit', () => {
		const inst = mitt();
		inst.emit('foo', 'bar');
	});
});
`,
		"package.json":  `{"name": "mitt", "version": "3.0.1"}`,
		"tsconfig.json": `{"compilerOptions": {"target": "es5"}}`,
	}

	nodes := []GitNode{
		{Path: "README.md", Type: "blob", Size: int64(len(files["README.md"]))},
		{Path: "src/index.ts", Type: "blob", Size: int64(len(files["src/index.ts"]))},
		{Path: "test/index.test.ts", Type: "blob", Size: int64(len(files["test/index.test.ts"]))},
		{Path: "package.json", Type: "blob", Size: int64(len(files["package.json"]))},
		{Path: "tsconfig.json", Type: "blob", Size: int64(len(files["tsconfig.json"]))},
	}

	fileReader := func(path string) ([]byte, error) {
		content, ok := files[path]
		if !ok {
			return nil, fmt.Errorf("file not found: %s", path)
		}
		return []byte(content), nil
	}

	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)

	return nodes, fileReader, patterns
}

func TestOutlineMicroRepo_PrepareSignals(t *testing.T) {
	nodes, fileReader, patterns := setupMittMicroRepoFixture(t)

	tests := []struct {
		name                 string
		opts                 OutlineSignalOptions
		expectAnchors        bool
		expectedAnchorSubstr []string
	}{
		{
			// BUG-65 关闭后正则符号兜底退役:无 extractor 时代码符号锚点
			// 不再被伪造,仅剩文档标题锚点与测试规格锚点(物理事实)。
			name: "micro repo without symbol extractor keeps doc/spec anchors only",
			opts: OutlineSignalOptions{
				FileReader: fileReader,
			},
			expectAnchors: true,
			expectedAnchorSubstr: []string{
				"Usage",
				"API",
				"should default to empty all map",
			},
		},
		{
			name: "micro repo with explicit symbol extractor",
			opts: OutlineSignalOptions{
				FileReader: fileReader,
				SymbolExtractor: SymbolExtractorFunc(func(content, filePath string) []SymbolEntry {
					if filePath == "src/index.ts" {
						return []SymbolEntry{
							{Name: "mitt", Kind: "function", Exported: true},
							{Name: "Emitter", Kind: "type", Exported: true},
							{Name: "EventHandlerList", Kind: "type", Exported: true},
						}
					}
					return nil
				}),
			},
			expectAnchors: true,
			expectedAnchorSubstr: []string{
				"mitt",
				"Emitter",
				"EventHandlerList",
				"Usage",
				"API",
			},
		},
		{
			name: "no file reader provided degrades gracefully to Zoom 1 candidates",
			opts: OutlineSignalOptions{
				FileReader: nil,
			},
			expectAnchors: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			candidates, isFlat, _, fileCount := PrepareOutlineSignalsWithOptions(nodes, "", 60, patterns, tt.opts)
			assert.NotEmpty(t, candidates)
			assert.False(t, isFlat, "micro-repo with <= 3 code files should not be classified as flat repo")
			assert.Equal(t, 5, fileCount)

			hasAnchors := false
			anchorNames := []string{}
			for _, c := range candidates {
				if c.Anchor != "" {
					hasAnchors = true
					anchorNames = append(anchorNames, c.Anchor)
				}
				assert.Greater(t, c.Handle, 0)
			}

			if tt.expectAnchors {
				assert.True(t, hasAnchors, "expected candidates to contain sub-file anchors")
				for _, expected := range tt.expectedAnchorSubstr {
					found := false
					for _, a := range anchorNames {
						if strings.Contains(a, expected) {
							found = true
							break
						}
					}
					assert.True(t, found, "expected anchor containing %q in %v", expected, anchorNames)
				}
			} else {
				assert.False(t, hasAnchors, "expected no anchors when fileReader is nil")
			}
		})
	}
}

func TestOutlineMicroRepo_SanitizeAndIntersectMultiAnchor(t *testing.T) {
	nodes, fileReader, patterns := setupMittMicroRepoFixture(t)

	candidates, _, _, _ := PrepareOutlineSignalsWithOptions(nodes, "", 60, patterns, OutlineSignalOptions{
		FileReader: fileReader,
		SymbolExtractor: SymbolExtractorFunc(func(content, filePath string) []SymbolEntry {
			if filePath == "src/index.ts" {
				return []SymbolEntry{
					{Name: "mitt", Kind: "function", Exported: true},
					{Name: "EventHandlerList", Kind: "type", Exported: true},
				}
			}
			return nil
		}),
	})
	require.NotEmpty(t, candidates)

	// Map to look up handles
	handleByPathAnchor := make(map[string]int)
	for _, c := range candidates {
		key := c.Path
		if c.Anchor != "" {
			key += "#" + c.Anchor
		}
		handleByPathAnchor[key] = c.Handle
	}

	mittHandle := handleByPathAnchor["src/index.ts#mitt"]
	usageHandle := handleByPathAnchor["README.md#Usage"]

	tests := []struct {
		name                   string
		chapters               []OutlineChapter
		expectedLessonCount    int
		expectedChapterCount   int
		assertLessonPaths      []string
		assertLessonAnchors    []string
		expectDroppedPathCount int
	}{
		{
			name: "multiple lessons under same source file with distinct anchors are preserved",
			chapters: []OutlineChapter{
				{
					Name:    "入门与概览",
					Summary: "快速了解 Mitt 的设计背景与使用范式",
					Files: []ChapterFile{
						{Path: "README.md", Anchor: "Usage", ShortTitle: "使用范式"},
					},
				},
				{
					Name:    "核心事件调度器",
					Summary: "解析 mitt 核心调度函数实现细节",
					Files: []ChapterFile{
						{Path: "src/index.ts#mitt", ShortTitle: "mitt 构造器"},
						{Path: "src/index.ts#EventHandlerList", ShortTitle: "事件处理列表类型"},
					},
				},
				{
					Name:    "行为规范验证",
					Summary: "测试驱动视角审视事件分发完整契约",
					Files: []ChapterFile{
						{Path: "test/index.test.ts#should default to empty all map", ShortTitle: "默认初始化规格"},
					},
				},
			},
			expectedChapterCount: 3,
			expectedLessonCount:  4,
			assertLessonPaths:    []string{"README.md", "src/index.ts", "src/index.ts", "test/index.test.ts"},
			assertLessonAnchors:  []string{"Usage", "mitt", "EventHandlerList", "should default to empty all map"},
		},
		{
			name: "handle resolution resolves path and bound anchor",
			chapters: []OutlineChapter{
				{
					Name:    "句柄解析测试",
					Summary: "通过 Handle 序号直接引用锚点候选条目",
					Files: []ChapterFile{
						{Handle: usageHandle, ShortTitle: "快速上手"},
						{Handle: mittHandle, ShortTitle: "核心调度"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  2,
			assertLessonPaths:    []string{"README.md", "src/index.ts"},
			assertLessonAnchors:  []string{"Usage", "mitt"},
		},
		{
			name: "hallucinated symbol anchor degrades or is rejected fail-closed",
			chapters: []OutlineChapter{
				{
					Name:    "防幻觉拦截",
					Summary: "拦截虚构的 AST 符号锚点",
					Files: []ChapterFile{
						{Path: "README.md", Anchor: "Usage", ShortTitle: "使用范式"},
						{Path: "src/index.ts#fakeNonExistentSymbol123", ShortTitle: "虚构符号"},
						{Path: "src/index.ts#mitt", ShortTitle: "真实符号"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  3, // fakeNonExistentSymbol123 degrades to base file "src/index.ts", mitt passes as "src/index.ts#mitt"
			assertLessonPaths:    []string{"README.md", "src/index.ts", "src/index.ts"},
			assertLessonAnchors:  []string{"Usage", "", "mitt"},
		},
		{
			name: "both path#anchor and explicit anchor simultaneously supported and normalized",
			chapters: []OutlineChapter{
				{
					Name:    "双重路径锚点归一",
					Summary: "测试 Path 包含 # 且 Anchor 字段同时存在时的健壮解析",
					Files: []ChapterFile{
						{Path: "src/index.ts#mitt", Anchor: "mitt", ShortTitle: "src/index.ts#mitt"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  2,
			assertLessonPaths:    []string{"README.md", "src/index.ts"},
			assertLessonAnchors:  []string{"", "mitt"},
		},
		{
			name: "suffix-omitted test spec file matches candidate spec and is not dropped",
			chapters: []OutlineChapter{
				{
					Name:    "测试规格后缀容错匹配",
					Summary: "测试省略前导 test/ 目录的测试规格条目能够正确后缀容错匹配放行",
					Files: []ChapterFile{
						{Path: "index.test.ts#should default to empty all map", ShortTitle: "默认初始化规格"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  2,
			assertLessonPaths:    []string{"README.md", "test/index.test.ts"},
			assertLessonAnchors:  []string{"", "should default to empty all map"},
		},
		{
			name: "markdown slug anchor resolves to canonical heading name and avoids deduplication drop",
			chapters: []OutlineChapter{
				{
					Name:    "Markdown 锚点 Slug 归一",
					Summary: "测试 kebab-case 格式的 Markdown 锚点正确解析为标准大小写标题",
					Files: []ChapterFile{
						{Path: "README.md#quick-start", ShortTitle: "快速入门"},
						{Path: "README.md#usage", ShortTitle: "使用指南"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  2,
			assertLessonPaths:    []string{"README.md", "README.md"},
			assertLessonAnchors:  []string{"Quick Start", "Usage"},
		},
		{
			name: "raw path#anchor shortTitle is cleaned to anchor name",
			chapters: []OutlineChapter{
				{
					Name:    "标题净化测试",
					Summary: "测试直接传入原始 path#anchor 格式的短标题被自动提炼为纯符号名",
					Files: []ChapterFile{
						{Path: "src/index.ts#mitt", ShortTitle: "src/index.ts#mitt"},
					},
				},
			},
			expectedChapterCount: 1,
			expectedLessonCount:  2,
			assertLessonPaths:    []string{"README.md", "src/index.ts"},
			assertLessonAnchors:  []string{"", "mitt"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := SanitizeAndIntersectOutline(tt.chapters, nodes, "", "zh-CN", candidates, patterns)
			require.Len(t, res.Sanitized, tt.expectedChapterCount)

			var allFiles []ChapterFile
			for _, ch := range res.Sanitized {
				allFiles = append(allFiles, ch.Files...)
			}
			assert.Len(t, allFiles, tt.expectedLessonCount)

			if len(tt.assertLessonPaths) > 0 {
				for i, expectedPath := range tt.assertLessonPaths {
					assert.Equal(t, expectedPath, allFiles[i].Path)
				}
			}
			if len(tt.assertLessonAnchors) > 0 {
				for i, expectedAnchor := range tt.assertLessonAnchors {
					assert.Equal(t, expectedAnchor, allFiles[i].Anchor)
				}
			}
		})
	}
}

func TestOutlineMicroRepo_MaxFilesCapping(t *testing.T) {
	nodes, fileReader, patterns := setupMittMicroRepoFixture(t)
	candidates, _, _, _ := PrepareOutlineSignalsWithOptions(nodes, "", 4, patterns, OutlineSignalOptions{
		FileReader: fileReader,
	})
	assert.Len(t, candidates, 4)
	for i, c := range candidates {
		assert.Equal(t, i+1, c.Handle)
	}
}

func TestExtractLivingTestSpecs_AST(t *testing.T) {
	nodes := []GitNode{
		{Path: "foo_test.go", Type: "blob", Size: 100},
	}
	content := `package foo
func TestAuthenticationFlow(t *testing.T) {}
func TestTokenRefresh(t *testing.T) {}
`
	fileReader := func(path string) ([]byte, error) {
		if path == "foo_test.go" {
			return []byte(content), nil
		}
		return nil, fmt.Errorf("not found")
	}

	extractor := SymbolExtractorFunc(func(c, p string) []SymbolEntry {
		return []SymbolEntry{
			{Name: "TestAuthenticationFlow", Kind: "function", StartLine: 2},
			{Name: "TestTokenRefresh", Kind: "function", StartLine: 3},
		}
	})

	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)

	anchors := ExtractSubFileAnchors(nil, nil, nodes, fileReader, extractor, patterns)
	require.Len(t, anchors, 2)
	assert.Equal(t, "foo_test.go", anchors[0].Path)
	assert.Equal(t, "TestAuthenticationFlow", anchors[0].Anchor)
	assert.Equal(t, "TestTokenRefresh", anchors[1].Anchor)
}

func TestOutlineMicroRepo_AdaptiveOneTwoChapters(t *testing.T) {
	patterns, err := LoadIngestPatterns("")
	require.NoError(t, err)

	tests := []struct {
		name                 string
		nodes                []GitNode
		files                map[string]string
		symbols              map[string][]SymbolEntry
		expectedChapterCount int
		expectedTitles       []string
	}{
		{
			name: "single compact file with only functions produces 1 cohesive masterclass chapter",
			nodes: []GitNode{
				{Path: "engine.py", Type: "blob", Size: 200},
			},
			files: map[string]string{
				"engine.py": "def add(): pass\ndef mul(): pass",
			},
			symbols: map[string][]SymbolEntry{
				"engine.py": {
					{Name: "add", Kind: "function", Exported: true},
					{Name: "mul", Kind: "function", Exported: true},
				},
			},
			expectedChapterCount: 1,
			expectedTitles: []string{
				"第 1 章：核心分发器与业务实现",
			},
		},
		{
			name: "compact repo with types and functions produces 2 dual-kernel chapters",
			nodes: []GitNode{
				{Path: "engine.py", Type: "blob", Size: 300},
			},
			files: map[string]string{
				"engine.py": "class Value: pass\ndef backward(): pass",
			},
			symbols: map[string][]SymbolEntry{
				"engine.py": {
					{Name: "Value", Kind: "type", Exported: true},
					{Name: "backward", Kind: "function", Exported: true},
				},
			},
			expectedChapterCount: 2,
			expectedTitles: []string{
				"第 1 章：类型契约与状态定义",
				"第 2 章：核心分发器与业务实现",
			},
		},
		{
			name: "compact repo with readme and functions produces 2 chapters (intro + implementation)",
			nodes: []GitNode{
				{Path: "README.md", Type: "blob", Size: 100},
				{Path: "core.go", Type: "blob", Size: 200},
			},
			files: map[string]string{
				"README.md": "# Tiny\nFast tiny library.",
				"core.go":   "package main\nfunc Run() {}",
			},
			symbols: map[string][]SymbolEntry{
				"core.go": {
					{Name: "Run", Kind: "function", Exported: true},
				},
			},
			expectedChapterCount: 2,
			expectedTitles: []string{
				"第 1 章：起步与使用指南",
				"第 2 章：核心分发器与业务实现",
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			fileReader := func(p string) ([]byte, error) {
				content, ok := tt.files[p]
				if !ok {
					return nil, fmt.Errorf("not found: %s", p)
				}
				return []byte(content), nil
			}
			extractor := SymbolExtractorFunc(func(c, p string) []SymbolEntry {
				return tt.symbols[p]
			})

			opts := OutlineSignalOptions{
				FileReader:      fileReader,
				SymbolExtractor: extractor,
			}

			chapters := BuildRuleFallbackOutline(tt.nodes, "", "zh-CN", patterns, opts)
			require.Len(t, chapters, tt.expectedChapterCount)
			for i, expectedTitle := range tt.expectedTitles {
				assert.Equal(t, expectedTitle, chapters[i].Name)
			}
		})
	}
}
