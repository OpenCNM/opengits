package transcription

import (
	"context"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
)

type mockSamplingLlm struct {
	responses map[string]LlmTextResult
	calls     []string
}

func (m *mockSamplingLlm) Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error) {
	m.calls = append(m.calls, purpose)
	if res, ok := m.responses[purpose]; ok {
		return res, nil
	}
	return LlmTextResult{Text: "<PASS>"}, nil
}

func TestSamplingAuditAndHealing(t *testing.T) {
	ctx := context.Background()
	original := `# React Architecture Overview

React is a declarative, efficient, and flexible JavaScript library for building user interfaces.

## Fiber Reconciler
The fiber reconciler is the core algorithm powering asynchronous concurrent rendering.`

	t.Run("采样质检合格直接放行无降级", func(t *testing.T) {
		translatedDraft := `# React 架构概述

React 是一个用于构建用户界面的声明式、高效且灵活的 JavaScript 库。

## Fiber 协调器
Fiber 协调器是支撑异步并发渲染的核心算法与底层调度机制。`

		mockLlm := &mockSamplingLlm{
			responses: map[string]LlmTextResult{
				"doc_translation_sample": {Text: "<PASS>"},
			},
		}

		finalContent, degraded := VerifyAndHealTranslation(ctx, mockLlm, translatedDraft, original, "zh-CN", nil)
		assert.False(t, degraded)
		assert.Equal(t, translatedDraft, finalContent)
		assert.Contains(t, mockLlm.calls, "doc_translation_sample")
	})

	t.Run("尾部夹生拦截并微创断点自愈成功", func(t *testing.T) {
		halfBakedDraft := `# React 架构概述

React 是一个用于构建用户界面的声明式、高效且灵活的 JavaScript 库。

## Fiber Reconciler
The fiber reconciler is the core algorithm powering asynchronous concurrent rendering.`

		callCount := 0
		mockLlm := &mockSamplingLlm{}
		// 动态定制：第一次 sample 报 <FAIL>，补翻返回中文，第二次 sample 报 <PASS>
		patchResponse := "Fiber 协调器是支撑异步并发渲染的核心算法与底层调度机制。"
		customMock := &customFuncLlm{
			fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
				if purpose == "doc_translation_sample" {
					callCount++
					if callCount == 1 {
						return LlmTextResult{Text: "<FAIL>"}, nil
					}
					return LlmTextResult{Text: "<PASS>"}, nil
				}
				if purpose == "doc_translate" {
					return LlmTextResult{Text: patchResponse}, nil
				}
				return LlmTextResult{Text: "<PASS>"}, nil
			},
		}

		finalContent, degraded := VerifyAndHealTranslation(ctx, customMock, halfBakedDraft, original, "zh-CN", nil)
		assert.False(t, degraded, "自愈成功不应标记降级")
		assert.Contains(t, finalContent, "Fiber 协调器是支撑异步并发渲染的核心算法")
		assert.NotContains(t, finalContent, "powering asynchronous concurrent rendering")
		_ = mockLlm
	})

	t.Run("自愈失败优雅保全结构化原文绝不输出夹生饭", func(t *testing.T) {
		halfBakedDraft := `# React 架构概述

React 是一个用于构建用户界面的声明式、高效且灵活的 JavaScript 库。

## Fiber Reconciler
The fiber reconciler is the core algorithm powering asynchronous concurrent rendering.`

		customMock := &customFuncLlm{
			fn: func(purpose string, vars map[string]any) (LlmTextResult, error) {
				if purpose == "doc_translation_sample" {
					return LlmTextResult{Text: "<FAIL>"}, nil
				}
				if purpose == "doc_translate" {
					// 补翻依然截断或失败
					return LlmTextResult{Text: "", FinishReason: "length"}, nil
				}
				return LlmTextResult{Text: "<FAIL>"}, nil
			},
		}

		finalContent, degraded := VerifyAndHealTranslation(ctx, customMock, halfBakedDraft, original, "zh-CN", nil)
		assert.True(t, degraded, "自愈失败必须显式标记降级")
		assert.Equal(t, original, finalContent, "降级必须干净交付结构化原文，绝不交付半截夹生饭")
		assert.False(t, strings.Contains(finalContent, "React 架构概述"), "不应残留任何混杂译文片段")
	})

	t.Run("短文本跳过采样", func(t *testing.T) {
		shortDraft := "```ts\nconst a = 1;\n```"
		mockLlm := &mockSamplingLlm{}
		finalContent, degraded := VerifyAndHealTranslation(ctx, mockLlm, shortDraft, shortDraft, "zh-CN", nil)
		assert.False(t, degraded)
		assert.Equal(t, shortDraft, finalContent)
		assert.Empty(t, mockLlm.calls)
	})
}

type customFuncLlm struct {
	fn func(purpose string, vars map[string]any) (LlmTextResult, error)
}

func (c *customFuncLlm) Complete(ctx context.Context, purpose string, variables map[string]any, userId *string) (LlmTextResult, error) {
	if c.fn != nil {
		return c.fn(purpose, variables)
	}
	return LlmTextResult{Text: "<PASS>"}, nil
}
