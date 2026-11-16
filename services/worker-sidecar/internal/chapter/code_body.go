package chapter

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/opengits/worker-sidecar/internal/armor"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 虚拟代码章节正文提纯与快照解析（Zero-Node 虚拟章节引擎）
// ─────────────────────────────────────────────────────────────

// ParseModuleSnapshots 归一化解析 repoProfile["codeClusters"]（兼容 []cluster.ModuleSnapshot、[]any、[]map[string]any）。
func ParseModuleSnapshots(raw any) []cluster.ModuleSnapshot {
	if raw == nil {
		return nil
	}
	switch v := raw.(type) {
	case []cluster.ModuleSnapshot:
		return v
	case []*cluster.ModuleSnapshot:
		res := make([]cluster.ModuleSnapshot, len(v))
		for i, item := range v {
			if item != nil {
				res[i] = *item
			}
		}
		return res
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return nil
		}
		var list []cluster.ModuleSnapshot
		if err := json.Unmarshal(b, &list); err != nil {
			return nil
		}
		return list
	}
}

var (
	chapterDigitsRe = regexp.MustCompile(`\d+`)
	chapterMdxExtRe = mdpat.MdExtRe
)

// ResolveModuleSnapshotFromProfile 从 repoProfile["codeClusters"] 解析模块列表：
// 优先按 docPath（如 chapters/01.mdx）的数字序号匹配 cluster.ChapterNo 或 cluster.TeachingOrder；
// 匹配不到时按 clean slug / title 匹配；均不匹配返回 nil。
func ResolveModuleSnapshotFromProfile(repoProfile map[string]any, docPath, docTitle string) *cluster.ModuleSnapshot {
	if repoProfile == nil {
		return nil
	}
	clustersRaw, ok := repoProfile["codeClusters"]
	if !ok || clustersRaw == nil {
		return nil
	}
	list := ParseModuleSnapshots(clustersRaw)
	if len(list) == 0 {
		return nil
	}

	lastSegment := filepath.Base(docPath)
	if docPath == "" {
		lastSegment = ""
	}

	// 1. 尝试从 docPath 提取章节数字序号（如 chapters/01.mdx -> 1）
	numMatch := chapterDigitsRe.FindString(lastSegment)
	if numMatch != "" {
		if order, err := strconv.Atoi(numMatch); err == nil && order > 0 {
			for _, c := range list {
				if c.ChapterNo == order {
					res := c
					return &res
				}
			}
			for _, c := range list {
				if c.TeachingOrder == order {
					res := c
					return &res
				}
			}
		}
	}

	// 2. clean doc slug 与 title 匹配
	rawSlug := chapterMdxExtRe.ReplaceAllString(lastSegment, "")
	cleanDocSlug := mdpat.SlugifyUnderscore(rawSlug)
	// 支持 Unicode/CJK 标题与文件名匹配；纯标点输入稳定回退至 id_<hash> 规避 Contains("", "") 恒真
	for _, c := range list {
		if strings.TrimSpace(c.Title) == "" {
			continue
		}
		if cleanDocSlug != "" {
			cleanTitle := mdpat.SlugifyUnderscore(c.Title)
			if cleanTitle != "" && (strings.Contains(cleanDocSlug, cleanTitle) || strings.Contains(cleanTitle, cleanDocSlug)) {
				res := c
				return &res
			}
		}
		if docTitle != "" {
			docTitleLower := strings.ToLower(docTitle)
			cTitleLower := strings.ToLower(c.Title)
			if strings.Contains(docTitleLower, cTitleLower) || strings.Contains(cTitleLower, docTitleLower) {
				res := c
				return &res
			}
		}
	}

	return nil
}

// ReadLocalArchiveFile 从本地归档目录直读单文件（含防路径穿越边界校验）。
func ReadLocalArchiveFile(archiveRoot, owner, repo, shaOrBranch, p string) string {
	if archiveRoot == "" || owner == "" || repo == "" || shaOrBranch == "" || p == "" {
		return ""
	}
	base := filepath.Join(archiveRoot, owner, repo, shaOrBranch)
	full := filepath.Join(base, filepath.FromSlash(p))
	rel, err := filepath.Rel(base, full)
	if err != nil || strings.HasPrefix(rel, "..") {
		return ""
	}
	b, err := os.ReadFile(full)
	if err != nil {
		return ""
	}
	return string(b)
}

// PackModuleFilesFromArchive 遍历 files 清单从本地磁盘直读，组装 []armor.ArmorSourceFile 并平滑分配预算（40000 字符）。
func PackModuleFilesFromArchive(archiveRoot, owner, repo, sha string, files []string) []armor.ArmorAllocatedSnippet {
	if len(files) == 0 {
		return nil
	}
	var rawFiles []armor.ArmorSourceFile
	for _, p := range files {
		cleanPath, anchor := mdpat.SplitPathAnchor(p)
		if cleanPath == "" {
			continue
		}
		raw := ReadLocalArchiveFile(archiveRoot, owner, repo, sha, cleanPath)
		if raw == "" {
			continue
		}
		totalLines := strings.Count(raw, "\n") + 1
		resolvedPath := p
		if anchor != "" {
			resolvedPath = mdpat.JoinPathAnchor(cleanPath, anchor)
		}
		rawFiles = append(rawFiles, armor.ArmorSourceFile{
			Path:       resolvedPath,
			TotalLines: totalLines,
			RawContent: raw,
		})
	}
	if len(rawFiles) == 0 {
		return nil
	}
	return armor.AllocateBalancedSourceSnippets(rawFiles, 40000)
}

// selectGroundedAnchorSymbols 从 Tree-sitter AST 符号表提取可用锚点门牌号（SSOT：
// 与 lookupSymbolRange、VerifySymbolGrounding 共享同一 SymbolsByFile 物理事实，
// 杜绝文本扫描误把 docstring 示例或注释当成可引用符号）。
func selectGroundedAnchorSymbols(entries []cognitive.SymbolEntry, limit int) []string {
	if len(entries) == 0 || limit <= 0 {
		return nil
	}
	syms := make([]string, 0, min(len(entries), limit))
	seen := make(map[string]bool, len(entries))
	for _, entry := range entries {
		if entry.Name == "" || seen[entry.Name] {
			continue
		}
		seen[entry.Name] = true
		syms = append(syms, entry.Name)
		if len(syms) >= limit {
			break
		}
	}
	return syms
}

// BuildFilesSummary 格式化输出代码片段清单供 Prompt 使用：
// [File 1] path/to/file (120 lines)
// (Available code slot anchors: [File 1#InitScheduler], [File 1#WorkerPool])
// ```
// snippet
// ```
func BuildFilesSummary(snippets []armor.ArmorAllocatedSnippet, symbolsByFile map[string][]cognitive.SymbolEntry) string {
	if len(snippets) == 0 {
		return ""
	}
	var parts []string
	for idx, f := range snippets {
		cleanPath, anchor := mdpat.SplitPathAnchor(f.Path)
		header := fmt.Sprintf("[File %d] %s (%d lines)", idx+1, cleanPath, f.TotalLines)
		if anchor != "" {
			header = fmt.Sprintf("[File %d] %s (focus: %s, %d lines)", idx+1, cleanPath, anchor, f.TotalLines)
		}
		var entries []cognitive.SymbolEntry
		if symbolsByFile != nil {
			entries = symbolsByFile[cleanPath]
		}
		symbols := selectGroundedAnchorSymbols(entries, 12)
		symHint := ""
		if len(symbols) > 0 {
			tags := make([]string, 0, len(symbols))
			for _, s := range symbols {
				tags = append(tags, fmt.Sprintf("[File %d#%s]", idx+1, s))
			}
			symHint = fmt.Sprintf("\n(Available code slot anchors: %s)", strings.Join(tags, ", "))
		}
		parts = append(parts, fmt.Sprintf("%s%s\n```\n%s\n```", header, symHint, f.Snippet))
	}
	return strings.Join(parts, "\n\n")
}
