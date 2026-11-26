package fingerprint

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

func TestComputeFingerprintDefaults(t *testing.T) {
	t.Run("nil config 回落默认配置", func(t *testing.T) {
		chapters := []FingerprintChapterMeta{
			{Path: "a.md", WordCount: 300, CodeBlockCount: 1, HeadingCount: 4, PageURL: "/docs/o/r/a"},
		}
		events := []FingerprintRawEvent{
			{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/a", Duration: float64Ptr(30000)},
		}

		got := ComputeFingerprint(chapters, events, nil)
		require.Len(t, got.ChapterScores, 1)

		assert.InDelta(t, 50, got.ChapterScores[0].Score, 0)
		assert.Equal(t, 1, got.ChapterScores[0].VisitCount)
	})

	t.Run("空章节返回零结果且 chapterScores 序列化为空数组而非 null", func(t *testing.T) {
		got := ComputeFingerprint(nil, nil, nil)
		assert.Equal(t, float64(0), got.OverallProgress)
		assert.Equal(t, 0, got.TotalChapters)
		assert.NotNil(t, got.ChapterScores)
		assert.Empty(t, got.ChapterScores)

		encoded, err := json.Marshal(got)
		require.NoError(t, err)
		assert.Contains(t, string(encoded), `"chapterScores":[]`)
	})
}

func TestNormalizeFingerprintURL(t *testing.T) {
	tests := []struct {
		name string
		in   string
		want string
	}{
		{name: "大小写归一并剥尾斜杠", in: "/Docs/O/R/Intro/", want: "/docs/o/r/intro"},
		{name: "仅剥一个尾斜杠", in: "/docs/o/r/intro//", want: "/docs/o/r/intro/"},
		{name: "无尾斜杠仅归一大小写", in: "/Docs/O/R/Intro", want: "/docs/o/r/intro"},
		{name: "空串安全", in: "", want: ""},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, normalizeFingerprintURL(tt.in))
		})
	}
}

func TestScoreFingerprintChapterBranches(t *testing.T) {
	cfg := DefaultFingerprintConfig()
	longChapter := FingerprintChapterMeta{Path: "guide.md", WordCount: 300, CodeBlockCount: 1, HeadingCount: 4, PageURL: "/docs/o/r/guide"}

	tests := []struct {
		name           string
		chapter        FingerprintChapterMeta
		events         []FingerprintRawEvent
		wantScore      float64
		wantScroll     float64
		wantTime       float64
		wantVisitCount int
	}{
		{
			name:           "短文档有 PV 即满百且 scroll 判满",
			chapter:        FingerprintChapterMeta{Path: "tiny.md", WordCount: 100, CodeBlockCount: 0, HeadingCount: 3, PageURL: "/docs/o/r/tiny"},
			events:         []FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/tiny"}},
			wantScore:      100,
			wantScroll:     100,
			wantVisitCount: 1,
		},
		{
			name:           "短文档无 PV 计零分但 breakdown 仍判满",
			chapter:        FingerprintChapterMeta{Path: "tiny.md", WordCount: 100, CodeBlockCount: 0, HeadingCount: 3, PageURL: "/docs/o/r/tiny"},
			events:         []FingerprintRawEvent{{EventType: "SECTION_FOCUS", PageURL: "/docs/o/r/tiny", Duration: float64Ptr(12000)}},
			wantScore:      0,
			wantScroll:     100,
			wantTime:       60,
			wantVisitCount: 0,
		},
		{
			name:      "滚到底(≥90)直接满百",
			chapter:   longChapter,
			events:    []FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Metadata: map[string]any{"scrollPercent": 95.0}}},
			wantScore: 100, wantScroll: 95, wantVisitCount: 1,
		},
		{
			name:      "时间进度半程填分",
			chapter:   longChapter,
			events:    []FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Duration: float64Ptr(30000)}},
			wantScore: 50, wantTime: 50, wantVisitCount: 1,
		},
		{
			name:      "滚动与时间取最大值",
			chapter:   longChapter,
			events:    []FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Duration: float64Ptr(30000), Metadata: map[string]any{"scrollPercent": 42.5}}},
			wantScore: 50, wantScroll: 42.5, wantTime: 50, wantVisitCount: 1,
		},
		{
			name:           "字符串 scrollPercent 与 null duration 一律忽略",
			chapter:        longChapter,
			events:         []FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Metadata: map[string]any{"scrollPercent": "85"}}},
			wantScore:      0,
			wantVisitCount: 1,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ScoreFingerprintChapter(tt.chapter, tt.events, 1.0, &cfg)
			assert.InDelta(t, tt.wantScore, got.Score, 0)
			assert.InDelta(t, tt.wantScroll, got.Breakdown.ScrollProgress, 0)
			assert.InDelta(t, tt.wantTime, got.Breakdown.TimeProgress, 0)
			assert.Equal(t, tt.wantVisitCount, got.VisitCount)
		})
	}
}

func TestCalculateFingerprintContentWeights(t *testing.T) {
	cfg := DefaultFingerprintConfig()

	t.Run("全零元数据回落均匀权重", func(t *testing.T) {
		chapters := []FingerprintChapterMeta{
			{Path: "a.md"}, {Path: "b.md"}, {Path: "c.md"},
		}
		weights := CalculateFingerprintContentWeights(chapters, &cfg)
		require.Len(t, weights, 3)
		for _, w := range weights {
			assert.InDelta(t, 1.0/3.0, w, 1e-12)
		}
	})

	t.Run("代码块权重占优并归一", func(t *testing.T) {
		chapters := []FingerprintChapterMeta{
			{Path: "prose.md", WordCount: 1000, CodeBlockCount: 0, HeadingCount: 10},
			{Path: "code.md", WordCount: 200, CodeBlockCount: 20, HeadingCount: 5},
		}
		weights := CalculateFingerprintContentWeights(chapters, &cfg)

		assert.InDelta(t, 1200.0/2500.0, weights["prose.md"], 1e-12)
		assert.InDelta(t, 1300.0/2500.0, weights["code.md"], 1e-12)
	})
}

func TestHandleFingerprintCompute(t *testing.T) {
	oversizedBody := `{"chapters":[],"events":[],"config":null,"junk":"` + strings.Repeat("x", int(httpx.LimitMedium)+10) + `"}`

	tests := []struct {
		name       string
		body       string
		wantStatus int
		check      func(t *testing.T, rec *httptest.ResponseRecorder)
	}{
		{
			name: "合法请求返回 ok 包络且与引擎直调一致",
			body: func() string {
				b, _ := json.Marshal(FingerprintComputeRequest{
					Chapters: []FingerprintChapterMeta{
						{Path: "guide.md", WordCount: 300, CodeBlockCount: 1, HeadingCount: 4, PageURL: "/docs/o/r/guide"},
					},
					Events: []FingerprintRawEvent{
						{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Duration: float64Ptr(30000)},
					},
				})
				return string(b)
			}(),
			wantStatus: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				var res FingerprintComputeResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				require.True(t, res.OK)
				require.NotNil(t, res.Result)
				expected := ComputeFingerprint(
					[]FingerprintChapterMeta{{Path: "guide.md", WordCount: 300, CodeBlockCount: 1, HeadingCount: 4, PageURL: "/docs/o/r/guide"}},
					[]FingerprintRawEvent{{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Duration: float64Ptr(30000)}},
					nil,
				)
				assert.Equal(t, expected, *res.Result)
			},
		},
		{
			name:       "畸形 JSON 返回 400 与 error 详情",
			body:       "{not-json",
			wantStatus: http.StatusBadRequest,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				var res FingerprintComputeResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.False(t, res.OK)
				assert.NotEmpty(t, res.Error)
			},
		},
		{
			name:       "载荷超限 10MB 返回 413",
			body:       oversizedBody,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/fingerprint/compute", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			HandleCompute(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.check != nil {
				tt.check(t, rec)
			}
		})
	}
}

func TestHandleFingerprintComputeBatch(t *testing.T) {
	oversizedBody := `{"items":[],"junk":"` + strings.Repeat("x", int(httpx.LimitMedium)+10) + `"}`

	tests := []struct {
		name       string
		body       string
		wantStatus int
		check      func(t *testing.T, rec *httptest.ResponseRecorder)
	}{
		{
			name:       "畸形 JSON 返回 400 与 error 详情",
			body:       "{bad-json",
			wantStatus: http.StatusBadRequest,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				var res FingerprintComputeBatchResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.False(t, res.OK)
				assert.NotEmpty(t, res.Error)
			},
		},
		{
			name:       "载荷超限 10MB 返回 413",
			body:       oversizedBody,
			wantStatus: http.StatusRequestEntityTooLarge,
		},
		{
			name: "🧪 [3.6.1.5 · HIGH] 合法批量请求正确计算多仓进度且跳过空 repoId",
			body: func() string {
				batchReq := FingerprintComputeBatchRequest{
					Items: []FingerprintBatchItem{
						{
							RepoID: "repo-1",
							Chapters: []FingerprintChapterMeta{
								{Path: "guide.md", WordCount: 300, CodeBlockCount: 1, HeadingCount: 4, PageURL: "/docs/o/r/guide"},
							},
							Events: []FingerprintRawEvent{
								{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/guide", Duration: float64Ptr(30000)},
							},
						},
						{
							RepoID: "repo-2",
							Chapters: []FingerprintChapterMeta{
								{Path: "intro.md", WordCount: 100, CodeBlockCount: 0, HeadingCount: 1, PageURL: "/docs/o/r/intro"},
							},
							Events: []FingerprintRawEvent{
								{EventType: "PAGE_VIEW", PageURL: "/docs/o/r/intro", Duration: float64Ptr(20000)},
							},
						},
						{
							RepoID: "",
							Chapters: []FingerprintChapterMeta{
								{Path: "skip.md", WordCount: 50, CodeBlockCount: 0, HeadingCount: 1, PageURL: "/docs/o/r/skip"},
							},
						},
					},
				}
				raw, _ := json.Marshal(batchReq)
				return string(raw)
			}(),
			wantStatus: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				var res FingerprintComputeBatchResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.True(t, res.OK)
				require.Len(t, res.Results, 2)
				assert.Contains(t, res.Results, "repo-1")
				assert.Contains(t, res.Results, "repo-2")
				assert.NotContains(t, res.Results, "")

				r1 := res.Results["repo-1"]
				assert.Equal(t, 1, r1.TotalChapters)
				assert.InDelta(t, 50.0, r1.OverallProgress, 0.001)

				r2 := res.Results["repo-2"]
				assert.Equal(t, 1, r2.TotalChapters)
				assert.InDelta(t, 100.0, r2.OverallProgress, 0.001)
			},
		},
		{
			name:       "空列表批量计算返回空 map",
			body:       `{"items":[]}`,
			wantStatus: http.StatusOK,
			check: func(t *testing.T, rec *httptest.ResponseRecorder) {
				var res FingerprintComputeBatchResponse
				require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &res))
				assert.True(t, res.OK)
				assert.NotNil(t, res.Results)
				assert.Empty(t, res.Results)
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/fingerprint/compute-batch", strings.NewReader(tt.body))
			rec := httptest.NewRecorder()
			HandleComputeBatch(rec, req)

			assert.Equal(t, tt.wantStatus, rec.Code)
			if tt.check != nil {
				tt.check(t, rec)
			}
		})
	}
}

func float64Ptr(v float64) *float64 { return &v }
