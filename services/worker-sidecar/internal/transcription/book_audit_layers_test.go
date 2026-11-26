package transcription

import (
	"strings"
	"testing"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const (
	auditSlotFence  = "```ts // src/main.ts#run\nexport function run() {}\n```"
	auditPlainFence = "```bash\necho hi\n```"
	auditDeepOpen   = "<details data-layer=\"deep\">\n<summary>源码深潜</summary>\n\n"
	auditDeepClose  = "\n\n</details>\n"
)

func TestBookAuditHealthCheckLayers(t *testing.T) {
	tests := []struct {
		name               string
		content            string
		wantForced         int
		wantHint           string
		wantThinCand       bool
		wantPeripheralCand bool
		wantMain           int
		wantMainAnchored   int
		wantCodeBlocks     int
		wantDives          int
	}{
		{
			name:           "代码全部藏在深潜块：主线零代码 → 强制",
			content:        "## 机制\n\n泛泛而谈。\n\n" + auditDeepOpen + auditSlotFence + auditDeepClose,
			wantForced:     1,
			wantHint:       "all code blocks sit inside collapsed deep-dive blocks",
			wantMain:       0,
			wantCodeBlocks: 1,
			wantDives:      1,
		},
		{
			name:             "主线 1 锚定块 + 深潜 2 块：仅进 thin_code 候选",
			content:          "## 机制\n\n" + auditSlotFence + "\n\n" + auditDeepOpen + auditSlotFence + "\n\n" + auditPlainFence + auditDeepClose,
			wantThinCand:     true,
			wantMain:         1,
			wantMainAnchored: 1,
			wantCodeBlocks:   3,
			wantDives:        1,
		},
		{
			name:               "主线 1 非锚定块 + 深潜 2 锚定块：同时触发 thin_code 与 peripheral_only 候选",
			content:            "## 机制\n\n" + auditPlainFence + "\n\n" + auditDeepOpen + auditSlotFence + "\n\n" + auditSlotFence + auditDeepClose,
			wantThinCand:       true,
			wantPeripheralCand: true,
			wantMain:           1,
			wantMainAnchored:   0,
			wantCodeBlocks:     3,
			wantDives:          1,
		},
		{
			name:               "主线 2 非锚定块 + 深潜 4 锚定块：不能被深潜锚定掩盖，必须触发 peripheral_only 候选",
			content:            "## 机制\n\n" + auditPlainFence + "\n\n" + auditPlainFence + "\n\n" + auditDeepOpen + auditSlotFence + "\n\n" + auditSlotFence + "\n\n" + auditSlotFence + "\n\n" + auditSlotFence + auditDeepClose,
			wantPeripheralCand: true,
			wantMain:           2,
			wantMainAnchored:   0,
			wantCodeBlocks:     6,
			wantDives:          1,
		},
		{
			name:             "主线 2 锚定块 + 深潜 2 非锚定块：主线锚定达标，无强制无候选",
			content:          "## 机制\n\n" + auditSlotFence + "\n\n" + auditSlotFence + "\n\n" + auditDeepOpen + auditPlainFence + "\n\n" + auditPlainFence + auditDeepClose,
			wantMain:         2,
			wantMainAnchored: 2,
			wantCodeBlocks:   4,
			wantDives:        1,
		},
		{
			name:             "主线 2 块：无强制无候选",
			content:          "## 机制\n\n" + auditSlotFence + "\n\n" + auditSlotFence + "\n",
			wantMain:         2,
			wantMainAnchored: 2,
			wantCodeBlocks:   2,
		},
		{
			name:               "主线 2 块但存在 2 段胶囊超密散文：仍产生 dense 候选供 AI 审校",
			content:            "## 机制\n\n第1段由 [a.ts](code:a.ts)、[b.ts](code:b.ts)、[c.ts](code:c.ts) 与 [d.ts](code:d.ts) 协作。\n\n第2段由 `f1`、`f2`、`f3` 与 `f4` 协同。\n\n" + auditSlotFence + "\n\n" + auditSlotFence + "\n",
			wantPeripheralCand: true,
			wantMain:           2,
			wantMainAnchored:   2,
			wantCodeBlocks:     2,
		},
		{
			name:             "无深潜的历史章节（1 锚定块）：沿用「仅候选」判据",
			content:          "## 机制\n\n" + auditSlotFence + "\n",
			wantThinCand:     true,
			wantMain:         1,
			wantMainAnchored: 1,
			wantCodeBlocks:   1,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			docs := []BookAuditDoc{{ID: "d1", Path: "chapters/01.mdx", Title: "机制", Content: tt.content}}
			filesByPath := map[string][]string{"chapters/01.mdx": {"src/main.ts"}}

			digests, forced, candidates := bookAuditHealthCheck(docs, filesByPath, 2)
			require.Len(t, digests, 1)
			assert.Equal(t, tt.wantMain, digests[0].MainCodeBlocks)
			assert.Equal(t, tt.wantMainAnchored, digests[0].MainAnchored)
			assert.Equal(t, tt.wantDives, digests[0].DeepDives)
			assert.Equal(t, tt.wantCodeBlocks, digests[0].CodeBlocks)

			require.Len(t, forced, tt.wantForced)
			for _, f := range forced {
				assert.Equal(t, bookDefectThinCode, f.IssueType)
				assert.True(t, f.forced)
				assert.Contains(t, f.FixHint, tt.wantHint)
			}
			gotThinCand := false
			gotPeripheralCand := false
			for _, c := range candidates {
				if c.IssueType == bookDefectThinCode {
					gotThinCand = true
				}
				if c.IssueType == bookDefectPeripheralOnly {
					gotPeripheralCand = true
				}
			}
			assert.Equal(t, tt.wantThinCand, gotThinCand, "thin_code 候选")
			assert.Equal(t, tt.wantPeripheralCand, gotPeripheralCand, "peripheral_only 候选")
		})
	}
}

func TestLastProseParagraph_SkipsFencesAndDeepDives(t *testing.T) {
	t.Helper()
	tests := []struct {
		name    string
		content string
		want    string
	}{
		{
			name:    "末尾为深潜块：跳过深潜与闭合 </details>，取主线最后一段",
			content: "---\nsummary: s\n---\n## 机制\n\n第一段。\n\n主线收尾小结。\n\n" + auditDeepOpen + "深潜内部段。\n\n" + auditSlotFence + auditDeepClose,
			want:    "主线收尾小结。",
		},
		{
			name:    "深潜块后有空行与最终小结：取最终小结",
			content: "## 机制\n\n" + auditDeepOpen + "深潜内容。\n" + auditDeepClose + "\n最终主线小结。\n",
			want:    "最终主线小结。",
		},
		{
			name:    "深潜闭合标签紧邻单换行后的小结：剥离 </details> 前缀",
			content: "## 机制\n\n" + auditDeepOpen + "深潜内容。\n\n</details>\n紧邻小结。",
			want:    "紧邻小结。",
		},
		{
			name:    "未闭合深潜块延续到文末：跳过深潜内容",
			content: "## 机制\n\n主线结论。\n\n" + auditDeepOpen + "未闭合的深潜段。\n\n## 深潜伪标题\n\n深潜尾段。",
			want:    "主线结论。",
		},
		{
			name:    "末尾代码块含空行：跳过整个围栏块",
			content: "## 机制\n\n围栏前总结。\n\n```ts\nconst a = 1\n\nconst b = 2\n```\n",
			want:    "围栏前总结。",
		},
		{
			name:    "全文仅标题与深潜块：返回空串",
			content: "## 机制\n\n" + auditDeepOpen + "深潜内部。\n" + auditDeepClose,
			want:    "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := lastProseParagraph(tt.content)
			assert.Equal(t, tt.want, got)
			assert.NotContains(t, got, "</details>")
		})
	}
}

func TestFindH2OffsetsOutsideFencesSkipsDeepDive(t *testing.T) {
	tests := []struct {
		name       string
		body       string
		wantTitles []string
	}{
		{
			name:       "深潜内的二级标题被跳过",
			body:       "## 机制\n\n正文。\n\n" + auditDeepOpen + "## 深潜内标题\n\n实现细节。\n\n" + auditDeepClose + "\n## 小结\n\n收尾。",
			wantTitles: []string{"## 机制", "## 小结"},
		},
		{
			name:       "最后一个二级标题在未闭合的深潜块里：同样跳过",
			body:       "## 机制\n\n正文。\n\n" + auditDeepOpen + "## 深潜内标题\n\n实现细节。\n",
			wantTitles: []string{"## 机制"},
		},
		{
			name:       "围栏内的 ## 不算标题",
			body:       "## 机制\n\n" + auditPlainFence + "\n\n## 小结\n\n收尾。",
			wantTitles: []string{"## 机制", "## 小结"},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			offsets := findH2OffsetsOutsideFences(tt.body)
			got := make([]string, 0, len(offsets))
			for _, off := range offsets {
				line := tt.body[off:]
				if nl := strings.IndexByte(line, '\n'); nl >= 0 {
					line = line[:nl]
				}
				got = append(got, line)
			}
			assert.Equal(t, tt.wantTitles, got)
		})
	}

	t.Run("增强节插在主线最后一个二级标题之前，不进入深潜块", func(t *testing.T) {
		content := "## 机制\n\n正文。\n\n" + auditDeepOpen + "## 深潜内标题\n\n细节。\n\n" + auditDeepClose + "\n## 小结\n\n收尾。"
		got := insertSectionBeforeLastH2(content, "## 实战代码透视\n\n```ts // src/main.ts#run\n```")
		assert.Less(t, strings.Index(got, "## 实战代码透视"), strings.Index(got, "## 小结"))
		assert.Greater(t, strings.Index(got, "## 实战代码透视"), strings.LastIndex(got, "</details>"), "增强节必须落在深潜块之外")
		assert.Equal(t, 1, strings.Count(got, "## 实战代码透视"))
	})
}

func TestGroundingLedgerLayerFields(t *testing.T) {
	dense := "状态机由 `A`、`B`、`C` 与 `D` 共同维护。"
	content := "---\nsummary: \"`a` `b` `c` `d` `e`\"\n---\n## 机制\n\n" + dense + "\n\n" + auditSlotFence + "\n\n" +
		auditDeepOpen + auditSlotFence + "\n\n" + auditPlainFence + auditDeepClose

	ledger := buildGroundingLedger(groundingGateParams{DocPath: "chapters/01.mdx", FirstBriefState: "plan"}, cognitive.GroundingReport{}, GroundingPassed, "", 0, 0, content)
	assert.Equal(t, 1, ledger.MainAnchored, "主线锚定槽")
	assert.Equal(t, 1, ledger.DeepAnchored, "深潜锚定槽")
	assert.Equal(t, 2, ledger.DeepBlocks, "深潜代码块")
	assert.Equal(t, 1, ledger.DeepDives, "深潜块个数")
	assert.Equal(t, 1, ledger.DenseParas, "frontmatter 里的反引号不计入超密段落")
	assert.Equal(t, "plan", ledger.BriefState)
	assert.Contains(t, ledger.LogLine(),
		"retries=0 slots=0 main_anchored=1 deep_anchored=1 deep_blocks=2 deep_dives=1 dense_paras=1 brief_state=plan")
}
