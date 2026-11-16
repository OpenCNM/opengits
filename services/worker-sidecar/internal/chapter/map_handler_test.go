package chapter

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestNaturalCompareEngine(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want int // 期望符号（-1/0/1）
	}{
		{name: "数字感知 chapter2 小于 chapter10", a: "chapter2.md", b: "chapter10.md", want: -1},
		{name: "去前导零保留末位按位数比较", a: "01-basics", b: "1-basics", want: 1},
		{name: "位数少者小", a: "09-x", b: "10-x", want: -1},
		{name: "全零段保留最后一位按位数比较", a: "000", b: "0", want: 1},
		{name: "数字段小于字母段", a: "1-a", b: "a-1", want: -1},
		{name: "前缀等长后缀短者小", a: "ab", b: "abc", want: -1},
		{name: "空串最小", a: "", b: "a", want: -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := naturalCompare(tt.a, tt.b)
			assert.Equal(t, tt.want, sign(got))
			assert.Equal(t, -tt.want, sign(naturalCompare(tt.b, tt.a)))
		})
	}
}

func sign(n int) int {
	switch {
	case n < 0:
		return -1
	case n > 0:
		return 1
	}
	return 0
}

func TestJsLocaleCompare(t *testing.T) {
	tests := []struct {
		name string
		a    string
		b    string
		want int
	}{
		{name: "小写先于大写", a: "a.md", b: "A.md", want: -1},
		{name: "casefold 主序 b 大于 a", a: "B.md", b: "a.md", want: 1},
		{name: "纯字典非自然序", a: "chapter-2", b: "chapter-10", want: 1},
		{name: "CJK 后于拉丁", a: "张.md", b: "a.md", want: 1},
		{name: "空白先于标点", a: "a b.md", b: "a-c.md", want: -1},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, sign(JsLocaleCompare(tt.a, tt.b)))
		})
	}
}

// TestChapterMapGoldenParity 章节映射确定性引擎双实现黄金对拍
func TestChapterMapGoldenParity(t *testing.T) {
	fixturePath := "../../testdata/chapter-map.golden.json"
	raw, err := os.ReadFile(fixturePath)
	if err != nil {
		// Fallback if executed from root
		fixturePath = "services/worker-sidecar/testdata/chapter-map.golden.json"
		raw, err = os.ReadFile(fixturePath)
	}
	require.NoError(t, err, "chapter-map.golden.json fixture must exist")

	var fixture struct {
		Signal []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes      []ChapterMapNode `json:"nodes"`
				TocContent string           `json:"tocContent"`
				ReadmeHead string           `json:"readmeHead"`
				Prefix     string           `json:"prefix"`
			} `json:"input"`
			Expected OrderSignal `json:"expected"`
		} `json:"signal"`
		Candidates []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes    []ChapterMapNode `json:"nodes"`
				TextRoot string           `json:"textRoot"`
			} `json:"input"`
			Expected ChapterCandidates `json:"expected"`
		} `json:"candidates"`
		Validate []struct {
			Name  string `json:"name"`
			Input struct {
				Raw   json.RawMessage  `json:"raw"`
				Nodes []ChapterMapNode `json:"nodes"`
			} `json:"input"`
			Expected *[]ChapterMapEntry `json:"expected"`
		} `json:"validate"`
		TocPath []struct {
			Name  string `json:"name"`
			Input struct {
				Nodes    []ChapterMapNode `json:"nodes"`
				TextRoot string           `json:"textRoot"`
			} `json:"input"`
			Expected *string `json:"expected"`
		} `json:"tocPath"`
		FromSidecar []struct {
			Name  string `json:"name"`
			Input struct {
				Content  string           `json:"content"`
				Nodes    []ChapterMapNode `json:"nodes"`
				TextRoot string           `json:"textRoot"`
			} `json:"input"`
			Expected *[]ChapterMapEntry `json:"expected"`
		} `json:"fromSidecar"`
		TextbookSignal []struct {
			Name  string `json:"name"`
			Input struct {
				Profile *TextbookRepoProfile `json:"profile"`
				Nodes   []ChapterMapNode     `json:"nodes"`
			} `json:"input"`
			Expected bool `json:"expected"`
		} `json:"textbookSignal"`
	}
	require.NoError(t, json.Unmarshal(raw, &fixture))
	require.NotEmpty(t, fixture.Signal)
	require.NotEmpty(t, fixture.Candidates)
	require.NotEmpty(t, fixture.Validate)
	require.NotEmpty(t, fixture.TocPath)
	require.NotEmpty(t, fixture.FromSidecar)

	p := getDefaultPatterns()

	t.Run("signal 对拍", func(t *testing.T) {
		for _, tc := range fixture.Signal {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.DetectOrderSignal(tc.Input.Nodes, tc.Input.TocContent, tc.Input.ReadmeHead, tc.Input.Prefix)
				assert.Equal(t, tc.Expected, got, "case %s: TS detectOrderSignal 与 Go 漂移", tc.Name)
			})
		}
	})

	t.Run("candidates 对拍", func(t *testing.T) {
		for _, tc := range fixture.Candidates {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.BuildChapterCandidates(tc.Input.Nodes, tc.Input.TextRoot)
				assert.Equal(t, tc.Expected, got, "case %s: TS buildChapterCandidates 与 Go 漂移", tc.Name)
			})
		}
	})

	t.Run("validate 对拍", func(t *testing.T) {
		for _, tc := range fixture.Validate {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.ValidateChapterMap(tc.Input.Raw, tc.Input.Nodes)
				if tc.Expected == nil {
					assert.Nil(t, got, "case %s: 期望校验不过返回 nil", tc.Name)
				} else {
					require.NotNil(t, got, "case %s: 期望校验通过", tc.Name)
					assert.Equal(t, *tc.Expected, got, "case %s: TS validateChapterMap 与 Go 漂移", tc.Name)
				}
			})
		}
	})

	t.Run("tocPath 对拍", func(t *testing.T) {
		for _, tc := range fixture.TocPath {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.FindTocSidecarPath(tc.Input.Nodes, tc.Input.TextRoot)
				if tc.Expected == nil {
					assert.Nil(t, got, "case %s: 期望无侧车", tc.Name)
				} else {
					require.NotNil(t, got, "case %s: 期望命中侧车", tc.Name)
					assert.Equal(t, *tc.Expected, *got, "case %s: TS findTocSidecarPath 与 Go 漂移", tc.Name)
				}
			})
		}
	})

	t.Run("fromSidecar 对拍", func(t *testing.T) {
		for _, tc := range fixture.FromSidecar {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.ChapterMapFromSidecar(tc.Input.Content, tc.Input.Nodes, tc.Input.TextRoot)
				if tc.Expected == nil {
					assert.Nil(t, got, "case %s: 期望 null", tc.Name)
				} else {
					require.NotNil(t, got, "case %s: 期望非 null", tc.Name)
					assert.Equal(t, *tc.Expected, got, "case %s: TS chapterMapFromSidecar 与 Go 漂移", tc.Name)
				}
			})
		}
	})

	t.Run("textbookSignal 对拍", func(t *testing.T) {
		for _, tc := range fixture.TextbookSignal {
			t.Run(tc.Name, func(t *testing.T) {
				got := p.IsTextbookRepoSignal(tc.Input.Profile, tc.Input.Nodes)
				assert.Equal(t, tc.Expected, got, "case %s: TS isTextbookRepoSignal 与 Go 漂移", tc.Name)
			})
		}
	})
}
