package ingest

import "strings"

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

func ResolveBestUsedFor(fromOutline []string, provided *envelopeRepoProfile, owner, repo string) []string {
	if sanitized := SanitizeOutlineBestUsedFor(fromOutline); len(sanitized) >= 2 {
		return sanitized
	}
	return DeterministicBestUsedFor(owner, repo, provided)
}
