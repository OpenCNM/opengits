package pipeline

import (
	"context"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 🧪 空正文短路守卫回归测试（112 字空壳案例）：
// 空 LLM 补全必须被显式判无效，绝不因 Stage 3.5 骨架保底注入而被
// 洗白成"仅骨架的合法 MDX"落库为 PROCESSED。
func TestMdxConvergencePipeline_EmptyDraftSkeletonRescueSuppressed(t *testing.T) {
	const skeleton = "```mermaid\nflowchart TD\n  subgraph ChapterMod[\"第 1 章: 概览\"]\n    fn1[\"InitEnv()\"] --> fn2[\"Setup()\"]\n  end\n```"

	tests := []struct {
		name           string
		draft          string
		withFallback   bool
		wantValid      bool
		wantFallback   bool
		wantErrSubstr  string
		wantBodySubstr string // FinalContent 必须包含的正文证据
	}{
		{
			name:          "空正文 + 骨架 → 判无效，FinalContent 不得只剩骨架",
			draft:         "",
			withFallback:  false,
			wantValid:     false,
			wantFallback:  false,
			wantErrSubstr: "empty llm completion",
		},
		{
			name:          "纯空白正文（换行/空格）同样短路",
			draft:         "  \n\t\n  ",
			withFallback:  false,
			wantValid:     false,
			wantFallback:  false,
			wantErrSubstr: "empty llm completion",
		},
		{
			name:           "空正文 + FallbackBuilder → 走显式确定性保底（设计内分层，非骨架洗白）",
			draft:          "",
			withFallback:   true,
			wantValid:      false,
			wantFallback:   true,
			wantErrSubstr:  "empty llm completion",
			wantBodySubstr: "# Fallback",
		},
		{
			name:           "非空正文缺 mermaid → 骨架保底照常注入（既有能力不倒退）",
			draft:          "# 第一章 概览\n\n本章介绍项目全貌与开发环境搭建流程。\n",
			withFallback:   false,
			wantValid:      true,
			wantFallback:   false,
			wantBodySubstr: "flowchart TD",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			pipeline := MdxConvergencePipeline{
				DocPath:              "chapters/01.mdx",
				Refs:                 nil,
				ArchitectureSkeleton: skeleton,
			}
			if tt.withFallback {
				pipeline.FallbackBuilder = func() string { return "# Fallback" }
			}

			res := pipeline.Execute(context.Background(), tt.draft, nil)

			if !tt.wantValid {
				assert.False(t, res.ValidationError == "", "期望携带校验错误")
				require.NotNil(t, res.Manifest)
				assert.Contains(t, res.ValidationError, tt.wantErrSubstr)
				assert.Equal(t, tt.wantFallback, res.WasFallbackUsed)
			} else {
				assert.Empty(t, res.ValidationError, "非空正文不应误伤")
			}
			if tt.wantBodySubstr != "" {
				assert.Contains(t, res.FinalContent, tt.wantBodySubstr)
			} else {
				// 空正文无 FallbackBuilder：FinalContent 必须为空——骨架不得
				// 单独构成成品（这正是 112 字空壳的病灶）
				assert.Empty(t, res.FinalContent, "空正文不得被骨架救援洗白为成品")
			}
		})
	}
}
