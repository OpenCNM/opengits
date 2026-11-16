package ingest

import "strings"

// ─────────────────────────────────────────────────────────────
// bestUsedFor（课程用途 2~4 条）确定性解析（自 TS lib/mcp/best-used-for-generator
// 移植，2026-11 收口——历史独立 mcp_best_used_for LLM 调用已切除，质量分层：
//  1. 大纲 LLM 伴生产出（draftOutline.bestUsedFor，通读全课程后顺带生成）；
//  2. 确定性模板插值兜底（大纲短路/规则回退/LLM 未输出该字段时）——
//     零 LLM、微秒级、事实来自信封画像技术栈，不编造未经验证的 specifics。
// 🧪 1.3.6.1：采信门槛 ≥2 条有效伴生产物，否则模板兜底。
// ─────────────────────────────────────────────────────────────

// SanitizeOutlineBestUsedFor 修剪伴生产物：非空字符串、去重、单条截断 120 字、至多 4 条。
func SanitizeOutlineBestUsedFor(raw []string) []string {
	seen := make(map[string]struct{}, len(raw))
	list := make([]string, 0, 4)
	for _, item := range raw {
		trimmed := strings.TrimSpace(item)
		if len(trimmed) > 120 {
			trimmed = trimmed[:120]
		}
		if trimmed == "" {
			continue
		}
		if _, dup := seen[trimmed]; dup {
			continue
		}
		seen[trimmed] = struct{}{}
		list = append(list, trimmed)
		if len(list) >= 4 {
			break
		}
	}
	return list
}

// stackLabelFromProfile 技术栈标签（framework (lang1/lang2)），缺栈返回空。
func stackLabelFromProfile(provided *envelopeRepoProfile) string {
	if provided == nil || provided.CodebaseProfile == nil {
		return ""
	}
	cbp := provided.CodebaseProfile
	langs := ""
	if n := len(cbp.PrimaryLanguages); n > 0 {
		if n > 3 {
			n = 3
		}
		langs = strings.Join(cbp.PrimaryLanguages[:n], "/")
	}
	switch {
	case cbp.Framework != "" && langs != "":
		return cbp.Framework + " (" + langs + ")"
	case cbp.Framework != "":
		return cbp.Framework
	default:
		return langs
	}
}

// DeterministicBestUsedFor 确定性模板插值兜底（零 LLM）。
func DeterministicBestUsedFor(owner, repo string, provided *envelopeRepoProfile) []string {
	stack := stackLabelFromProfile(provided)
	first := "学习 " + owner + "/" + repo + " 的核心架构设计与基本概念"
	if stack != "" {
		first = "学习 " + owner + "/" + repo + " 的" + stack + "架构设计与核心概念"
	}
	return []string{
		first,
		"参考 " + repo + " 的代码示例与 API 使用方法",
		"了解 " + owner + "/" + repo + " 的模块结构与项目配置",
	}
}

// ResolveBestUsedFor 落库侧唯一入口：伴生产物 ≥2 条有效优先，否则模板兜底。
func ResolveBestUsedFor(fromOutline []string, provided *envelopeRepoProfile, owner, repo string) []string {
	if sanitized := SanitizeOutlineBestUsedFor(fromOutline); len(sanitized) >= 2 {
		return sanitized
	}
	return DeterministicBestUsedFor(owner, repo, provided)
}
