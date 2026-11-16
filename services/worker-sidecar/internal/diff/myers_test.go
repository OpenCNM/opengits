package diff

import (
	"fmt"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func intPtr(v int) *int {
	return &v
}

func TestMyersDiffTableDriven(t *testing.T) {
	tests := []struct {
		name         string
		oldText      string
		newText      string
		oldPath      *string
		newPath      *string
		contextLines *int
		wantHunkCnt  int
		wantAdds     int
		wantDels     int
		checkFn      func(t *testing.T, res UnifiedDiffResult)
	}{
		{
			name:        "completely identical text",
			oldText:     "alpha\nbeta\ngamma",
			newText:     "alpha\nbeta\ngamma",
			wantHunkCnt: 0,
			wantAdds:    0,
			wantDels:    0,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				assert.Empty(t, res.Unified)
				assert.Empty(t, res.Hunks)
			},
		},
		{
			name:        "pure additions into empty file",
			oldText:     "",
			newText:     "line1\nline2\nline3",
			wantHunkCnt: 1,
			wantAdds:    3,
			wantDels:    0,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 1)
				assert.Equal(t, 0, res.Hunks[0].OldStart)
				assert.Equal(t, 0, res.Hunks[0].OldLines)
				assert.Equal(t, 1, res.Hunks[0].NewStart)
				assert.Equal(t, 3, res.Hunks[0].NewLines)
				assert.Contains(t, res.Unified, "@@ -0,0 +1,3 @@")
			},
		},
		{
			name:        "pure deletions from non-empty file",
			oldText:     "line1\nline2\nline3",
			newText:     "",
			wantHunkCnt: 1,
			wantAdds:    0,
			wantDels:    3,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 1)
				assert.Equal(t, 1, res.Hunks[0].OldStart)
				assert.Equal(t, 3, res.Hunks[0].OldLines)
				assert.Equal(t, 0, res.Hunks[0].NewStart)
				assert.Equal(t, 0, res.Hunks[0].NewLines)
				assert.Contains(t, res.Unified, "@@ -1,3 +0,0 @@")
			},
		},
		{
			name:        "single line modification with context",
			oldText:     "line1\nline2\nline3\nline4\nline5",
			newText:     "line1\nline2\nLINE3_NEW\nline4\nline5",
			wantHunkCnt: 1,
			wantAdds:    1,
			wantDels:    1,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 1)
				h := res.Hunks[0]
				assert.Equal(t, 1, h.OldStart)
				assert.Equal(t, 5, h.OldLines)
				assert.Equal(t, 1, h.NewStart)
				assert.Equal(t, 5, h.NewLines)
				assert.Contains(t, h.Lines, "-line3")
				assert.Contains(t, h.Lines, "+LINE3_NEW")
			},
		},
		{
			name:        "adjacent hunks merged (distance <= 2*contextLines)",
			oldText:     "c1\nc2\nMOD_A\nm1\nm2\nMOD_B\nc3\nc4",
			newText:     "c1\nc2\nMOD_A_NEW\nm1\nm2\nMOD_B_NEW\nc3\nc4",
			wantHunkCnt: 1,
			wantAdds:    2,
			wantDels:    2,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				// Distance between MOD_A and MOD_B is 2 context lines (m1, m2) <= 2*3=6 -> 1 hunk
				assert.Len(t, res.Hunks, 1)
			},
		},
		{
			name:        "distant hunks split (distance > 2*contextLines)",
			oldText:     "c1\nMOD_A\ns1\ns2\ns3\ns4\ns5\ns6\ns7\nMOD_B\nc2",
			newText:     "c1\nMOD_A_NEW\ns1\ns2\ns3\ns4\ns5\ns6\ns7\nMOD_B_NEW\nc2",
			wantHunkCnt: 2,
			wantAdds:    2,
			wantDels:    2,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				// Distance is 7 lines > 6 -> 2 separate hunks
				require.Len(t, res.Hunks, 2)
				assert.Equal(t, 1, res.Hunks[0].OldStart)
				assert.Contains(t, res.Hunks[0].Lines, "+MOD_A_NEW")
				assert.Contains(t, res.Hunks[1].Lines, "+MOD_B_NEW")
			},
		},
		{
			name:         "zero context lines emits only modified lines",
			oldText:      "a\nb\nc\nd",
			newText:      "a\nB\nc\nD",
			contextLines: intPtr(0),
			wantHunkCnt:  2,
			wantAdds:     2,
			wantDels:     2,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 2)
				for _, h := range res.Hunks {
					for _, l := range h.Lines {
						assert.True(t, l[0] == '+' || l[0] == '-', "line must not be context: %s", l)
					}
				}
			},
		},
		{
			name:        "unicode and chinese character diff",
			oldText:     "标题：第一版\n内容：原始说明文字\n结束。",
			newText:     "标题：第二版\n内容：修改后的说明文字 🚀\n结束。",
			wantHunkCnt: 1,
			wantAdds:    2,
			wantDels:    2,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 1)
				assert.Contains(t, res.Unified, "+标题：第二版")
				assert.Contains(t, res.Unified, "+内容：修改后的说明文字 🚀")
			},
		},
		{
			name:        "deletions strictly precede additions in hunk lines",
			oldText:     "a\nb\nc\nd\ne",
			newText:     "a\nX\nY\ne",
			wantHunkCnt: 1,
			wantAdds:    2,
			wantDels:    3,
			checkFn: func(t *testing.T, res UnifiedDiffResult) {
				require.Len(t, res.Hunks, 1)
				h := res.Hunks[0]
				seenAdd := false
				for _, l := range h.Lines {
					if l[0] == '+' {
						seenAdd = true
					}
					if l[0] == '-' && seenAdd {
						t.Fatalf("found delete after addition: %s", l)
					}
				}
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			res := ComputeMyersDiff(tt.oldText, tt.newText, tt.oldPath, tt.newPath, tt.contextLines)
			assert.Equal(t, tt.wantHunkCnt, len(res.Hunks), "hunk count mismatch")
			assert.Equal(t, tt.wantAdds, res.Additions, "additions mismatch")
			assert.Equal(t, tt.wantDels, res.Deletions, "deletions mismatch")
			if tt.checkFn != nil {
				tt.checkFn(t, res)
			}
		})
	}
}

func TestMyersDiffBailoutProtection(t *testing.T) {
	// 构造 3000 行完全不同内容，触发 maxDiffSteps 安全阻断，验证不会因 OOM 崩溃并平稳降级输出粗粒度 hunk
	var oldBuilder, newBuilder strings.Builder
	for i := 0; i < 3000; i++ {
		oldBuilder.WriteString(fmt.Sprintf("old-line-%d\n", i))
		newBuilder.WriteString(fmt.Sprintf("new-line-%d\n", i))
	}
	res := ComputeMyersDiff(oldBuilder.String(), newBuilder.String(), nil, nil, nil)
	assert.NotEmpty(t, res.Unified)
	assert.Equal(t, 3000, res.Additions)
	assert.Equal(t, 3000, res.Deletions)
	assert.Len(t, res.Hunks, 1)
}

// 降级 diff 必须显式标记（决策 A：当作有变化处理，但统计非精确）。
func TestComputeMyersDiffDegradedFlag(t *testing.T) {
	// 构造编辑距离超限的两份无关多行文本（max>8192 行时步数上限 2048）
	var oldB, newB strings.Builder
	for i := 0; i < 20_000; i++ {
		oldB.WriteString(fmt.Sprintf("old-line-%d-unique-content\n", i))
		newB.WriteString(fmt.Sprintf("new-line-%d-other-content\n", i))
	}
	res := ComputeMyersDiff(oldB.String(), newB.String(), nil, nil, nil)
	assert.True(t, res.Degraded, "超限兜底必须置 Degraded")
	assert.Equal(t, 1, len(res.Hunks), "兜底形态为单 hunk 整文件删+加")

	small := ComputeMyersDiff("hello\nworld\n", "hello\ngo\n", nil, nil, nil)
	assert.False(t, small.Degraded, "正常 diff 不得误标降级")
	assert.Equal(t, 1, small.Additions)
	assert.Equal(t, 1, small.Deletions)
}
