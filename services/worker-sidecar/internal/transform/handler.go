package transform

import (
	"net/url"
	"path"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var pathSegmentRE = mdpat.PathSegmentRe

func isSafeSegment(seg string) bool {
	return pathSegmentRE.MatchString(seg) && seg != "." && seg != ".."
}

func isSafeBranch(branch string) bool {
	if branch == "" || strings.Contains(branch, "\x00") {
		return false
	}
	current := branch
	for i := 0; i < 3; i++ {
		unescaped, err := url.PathUnescape(current)
		if err != nil || unescaped == current {
			break
		}
		if strings.Contains(unescaped, "\x00") || strings.Contains(unescaped, "..") || strings.Contains(unescaped, "\\") {
			return false
		}
		if strings.HasPrefix(unescaped, "/") || strings.HasSuffix(unescaped, "/") || strings.Contains(unescaped, "//") {
			return false
		}
		current = unescaped
	}
	for i := 0; i < len(branch); i++ {
		if branch[i] < 32 || branch[i] == 127 {
			return false
		}
	}
	if strings.HasPrefix(branch, "/") || strings.HasSuffix(branch, "/") ||
		strings.HasPrefix(branch, ".") || strings.HasSuffix(branch, ".") ||
		strings.Contains(branch, "..") || strings.Contains(branch, "//") ||
		strings.Contains(branch, "\\") || strings.Contains(branch, "@{") ||
		strings.HasSuffix(branch, ".lock") {
		return false
	}
	if strings.ContainsAny(branch, "<>:\"|?*") {
		return false
	}
	segs := strings.Split(branch, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." || strings.HasPrefix(seg, ".") || strings.HasSuffix(seg, ".") {
			return false
		}
	}
	return true
}

func isSafeRelativePath(p string) bool {
	if p == "" || strings.Contains(p, "\x00") {
		return false
	}
	current := p
	for i := 0; i < 3; i++ {
		unescaped, err := url.PathUnescape(current)
		if err != nil || unescaped == current {
			break
		}
		if strings.Contains(unescaped, "\x00") || strings.Contains(unescaped, "..") || strings.Contains(unescaped, "\\") {
			return false
		}
		current = unescaped
	}
	for i := 0; i < len(p); i++ {
		if p[i] < 32 || p[i] == 127 {
			return false
		}
	}
	if filepath.VolumeName(filepath.FromSlash(p)) != "" {
		return false
	}
	normalized := strings.ReplaceAll(p, "\\", "/")
	if strings.HasPrefix(normalized, "//") {
		return false
	}
	trimmed := strings.TrimPrefix(normalized, "/")
	if trimmed == "" {
		return false
	}
	clean := path.Clean(trimmed)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") {
		return false
	}
	cleanRel := filepath.Clean(filepath.FromSlash(trimmed))
	if filepath.IsAbs(cleanRel) || strings.HasPrefix(cleanRel, "..") || cleanRel == "." {
		return false
	}
	segs := strings.Split(trimmed, "/")
	for _, seg := range segs {
		if seg == "" || seg == "." || seg == ".." {
			return false
		}
		if strings.ContainsAny(seg, "<>:\"|?*") {
			return false
		}
	}
	return true
}

func IsSafeBranch(branch string) bool {
	return isSafeBranch(branch)
}

func IsSafeRelativePath(p string) bool {
	return isSafeRelativePath(p)
}
