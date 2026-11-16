package cognitive

import (
	"fmt"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// SanitizeAndIntersectOutline 防大模型路径幻觉硬装甲 (严格与 Git Tree 真实节点做集合交集)
func SanitizeAndIntersectOutline(
	chapters []OutlineChapter,
	nodes []GitNode,
	prefix string,
	targetLanguage string,
	candidateFiles []CandidateOutlineFile,
	patterns Patterns,
) SanitizeOutlineResult {
	isZh := targetLanguage == "" || targetLanguage == "zh-CN" || targetLanguage == "zh"
	isJa := targetLanguage == "ja"
	cleanPrefix := strings.Trim(strings.Trim(prefix, " "), "/")

	var realBlobPaths []string
	realFilePaths := make(map[string]bool)
	for _, n := range nodes {
		if n.Type == "blob" {
			if !realFilePaths[n.Path] {
				realFilePaths[n.Path] = true
				realBlobPaths = append(realBlobPaths, n.Path)
			}
		}
	}

	droppedPaths := []string{}
	seenAnchors := make(map[string]bool)
	sanitized := []OutlineChapter{}

	type candidateAnchorMeta struct {
		canonicalPath   string
		canonicalAnchor string
		kind            string
	}
	candidateAnchorMap := make(map[string]candidateAnchorMeta)
	hasCandidateAnchors := false

	indexCandidateAnchor := func(path, anchor, kind string) {
		meta := candidateAnchorMeta{
			canonicalPath:   path,
			canonicalAnchor: anchor,
			kind:            kind,
		}
		cleanAnchor := strings.TrimSuffix(anchor, "()")
		slug := slugifyAnchor(anchor)

		keys := []string{
			path + "#" + anchor,
			path + "#" + strings.ToLower(anchor),
			path + "#" + cleanAnchor,
			path + "#" + strings.ToLower(cleanAnchor),
		}
		if slug != "" {
			keys = append(keys, path+"#"+slug)
		}

		for _, k := range keys {
			candidateAnchorMap[k] = meta
		}
	}

	for _, c := range candidateFiles {
		if c.Anchor != "" {
			hasCandidateAnchors = true
			indexCandidateAnchor(c.Path, c.Anchor, c.Kind)
			if cleanPrefix != "" && strings.HasPrefix(c.Path, cleanPrefix+"/") {
				rel := strings.TrimPrefix(c.Path, cleanPrefix+"/")
				indexCandidateAnchor(rel, c.Anchor, c.Kind)
			}
			idx := strings.LastIndex(c.Path, "/")
			if idx >= 0 {
				base := c.Path[idx+1:]
				indexCandidateAnchor(base, c.Anchor, c.Kind)
			}
		}
	}

	for _, ch := range chapters {
		validFiles := []ChapterFile{}
		for _, f := range ch.Files {

			rawPath := strings.TrimSpace(f.Path)
			anchor := strings.TrimSpace(f.Anchor)

			// ① 句柄解析 (Handle Resolution): 优先根据候选集序号换取真实路径与绑定锚点
			if f.Handle > 0 && f.Handle <= len(candidateFiles) {
				candidate := candidateFiles[f.Handle-1]
				if candidate.Path != "" {
					rawPath = candidate.Path
				}
				if candidate.Anchor != "" && anchor == "" {
					anchor = candidate.Anchor
				}
			}

			if rawPath == "" {
				continue
			}

			// ② 支持 path#anchor 语法（无论 anchor 是否已传，均剥离 rawPath 中的 # 后缀）
			if strings.Contains(rawPath, "#") {
				parts := strings.SplitN(rawPath, "#", 2)
				rawPath = parts[0]
				if anchor == "" {
					anchor = strings.TrimSpace(parts[1])
				}
			}

			// 路径预处理：剥离前导 ./ 与 /
			trimmed := rawPath
			if strings.HasPrefix(trimmed, "./") {
				trimmed = strings.TrimPrefix(trimmed, "./")
			}
			trimmed = strings.TrimLeft(trimmed, "/")

			// 检查是否命中已声明的候选测试规格锚点 (c.Kind == "spec")
			isCandidateSpec := false
			if hasCandidateAnchors && anchor != "" {
				lookupKeys := []string{
					trimmed + "#" + anchor,
					trimmed + "#" + strings.ToLower(anchor),
					trimmed + "#" + strings.TrimSuffix(anchor, "()"),
					trimmed + "#" + strings.ToLower(strings.TrimSuffix(anchor, "()")),
					trimmed + "#" + slugifyAnchor(anchor),
				}
				for _, lk := range lookupKeys {
					if meta, ok := candidateAnchorMap[lk]; ok {
						if meta.kind == "spec" {
							isCandidateSpec = true
						}
						break
					}
				}
			}

			// 严格排除非内容目录、测试文件、二进制归档资产、治理非内容文件与运行记录转储
			// （UUID/散列命名 .txt、.log 是机器产出的原始日志，非认知单元，严禁成为一等大纲节点）
			if !isCandidateSpec && (patterns.IsNonContentDir(trimmed) ||
				patterns.IsNonContentFile(trimmed) ||
				patterns.IsBinaryOrArchiveFile(trimmed) ||
				(!patterns.IsCodeFile(trimmed) && !patterns.IsDocFile(trimmed)) ||
				patterns.IsTestFile(trimmed) ||
				mdpat.IsRunRecordDump(trimmed)) {
				droppedPaths = append(droppedPaths, rawPath)
				continue
			}

			var matchedPath string
			if realFilePaths[trimmed] {
				matchedPath = trimmed
			} else if cleanPrefix != "" {
				withPrefix := cleanPrefix + "/" + trimmed
				if realFilePaths[withPrefix] {
					matchedPath = withPrefix
				}
			}

			if matchedPath == "" {
				// 后缀容错匹配
				var tailMatches []string
				for _, p := range realBlobPaths {
					isCandidateSpecBlob := isCandidateSpec && (strings.HasSuffix(p, "/"+trimmed) || p == trimmed)
					if !patterns.IsNonContentDir(p) &&
						!patterns.IsNonContentFile(p) &&
						!patterns.IsBinaryOrArchiveFile(p) &&
						!mdpat.IsRunRecordDump(p) &&
						((patterns.IsCodeFile(p) || patterns.IsDocFile(p)) || isCandidateSpecBlob) &&
						(!patterns.IsTestFile(p) || isCandidateSpecBlob) &&
						(strings.HasSuffix(p, "/"+trimmed) || p == trimmed) {
						tailMatches = append(tailMatches, p)
					}
				}

				matchedPath = disambiguateTailMatches(tailMatches, candidateFiles, validFiles)
			}

			if matchedPath == "" {
				droppedPaths = append(droppedPaths, rawPath)
				continue
			}

			// ③ 物理锚点校验 (Fail-Closed against hallucinations)
			if anchor != "" && hasCandidateAnchors {
				lookupKeys := []string{
					matchedPath + "#" + anchor,
					matchedPath + "#" + strings.ToLower(anchor),
					matchedPath + "#" + strings.TrimSuffix(anchor, "()"),
					matchedPath + "#" + strings.ToLower(strings.TrimSuffix(anchor, "()")),
					matchedPath + "#" + slugifyAnchor(anchor),
				}
				matchedCanonical := ""
				for _, lk := range lookupKeys {
					if meta, ok := candidateAnchorMap[lk]; ok {
						matchedCanonical = meta.canonicalAnchor
						break
					}
				}
				if matchedCanonical != "" {
					anchor = matchedCanonical
				} else {
					// 虚构符号锚点：优雅降级为文件主干或剔除
					anchor = ""
				}
			}

			anchorKey := matchedPath
			if anchor != "" {
				anchorKey = matchedPath + "#" + strings.ToLower(anchor)
			}

			if seenAnchors[anchorKey] {
				continue
			}
			seenAnchors[anchorKey] = true

			shortTitle := strings.TrimSpace(f.ShortTitle)
			isRawPathTitle := shortTitle == "" ||
				shortTitle == matchedPath ||
				shortTitle == rawPath ||
				shortTitle == f.Path ||
				shortTitle == matchedPath+"#"+anchor ||
				shortTitle == rawPath+"#"+anchor ||
				strings.HasPrefix(shortTitle, matchedPath+"#") ||
				strings.HasPrefix(shortTitle, rawPath+"#")

			if isRawPathTitle {
				if anchor != "" {
					shortTitle = anchor
				} else {
					shortTitle = cleanShortTitle(matchedPath)
				}
			}

			var validCompanions []string
			for _, comp := range f.CompanionFiles {
				if len(realFilePaths) == 0 || realFilePaths[comp] {
					validCompanions = append(validCompanions, comp)
				}
			}

			validFiles = append(validFiles, ChapterFile{
				Path:           matchedPath,
				Anchor:         anchor,
				ShortTitle:     shortTitle,
				CompanionFiles: validCompanions,
			})
		}

		if len(validFiles) > 0 {
			chName := ch.Name
			if chName == "" {
				if isZh {
					chName = "核心教程章节"
				} else if isJa {
					chName = "コアチュートリアル章"
				} else {
					chName = "Core Tutorial Chapter"
				}
			}
			summary := ch.Summary
			if summary == "" {
				if isZh {
					summary = "章节内容与教程要点"
				} else if isJa {
					summary = "章の概要とチュートリアルのポイント"
				} else {
					summary = "Chapter overview and tutorial highlights"
				}
			}
			sanitized = append(sanitized, OutlineChapter{
				Name:      chName,
				Summary:   summary,
				Files:     validFiles,
				PartTitle: ch.PartTitle,
			})
		}
	}

	// 检查 README 是否存在但未被纳入，未纳入则保底补充在第一章首位
	readmePath := FindReadmePath(nodes, cleanPrefix, patterns)
	if readmePath != "" && realFilePaths[readmePath] && !seenAnchors[readmePath] {
		readmeIncluded := false
		for _, ch := range sanitized {
			for _, file := range ch.Files {
				if file.Path == readmePath {
					readmeIncluded = true
					break
				}
			}
			if readmeIncluded {
				break
			}
		}
		if !readmeIncluded && len(sanitized) > 0 {
			shortTitle := "Project Overview & Quickstart"
			if isZh {
				shortTitle = "项目概览与入门指南"
			} else if isJa {
				shortTitle = "プロジェクト概要とクイックスタートガイド"
			}
			sanitized[0].Files = append([]ChapterFile{
				{
					Path:       readmePath,
					ShortTitle: shortTitle,
				},
			}, sanitized[0].Files...)
			seenAnchors[readmePath] = true
		}
	}

	sanitized = RenumberOutlineChapters(sanitized)

	return SanitizeOutlineResult{
		Sanitized:    sanitized,
		DroppedPaths: droppedPaths,
	}
}

// isParenSymbolDump 判断括号内是否为罗列的代码符号或标识符清单。
func isParenSymbolDump(inner string) bool {
	inner = strings.TrimSpace(inner)
	if inner == "" {
		return false
	}
	// 知名技术生态单名保留（如 Node.js）
	if mdpat.PreservedTechNamesRe.MatchString(inner) && !strings.ContainsAny(inner, "、,，") {
		return false
	}
	// 包含枚举标点 (顿号、逗号、分号)
	if strings.ContainsAny(inner, "、,，;") {
		return true
	}
	// 包含中文或英文连词
	if strings.Contains(inner, " 与 ") || strings.Contains(inner, " 和 ") ||
		strings.Contains(inner, " 及 ") || strings.Contains(inner, " and ") ||
		strings.Contains(inner, " or ") || strings.Contains(inner, "与") {
		return true
	}
	// 包含代码扩展名（如 train.py）
	if mdpat.EmbeddedCodeExtRe.MatchString(inner) {
		return true
	}
	// 单个代码标识符（如 snake_case, camelCase 或含数字下划线等：multi_buffer, matcherset）
	if mdpat.CodeIdentifierRe.MatchString(inner) {
		return true
	}
	return false
}

// cleanTitleBody 清洗章节主体文本，消除物理文件名、代码扩展名后缀、末尾括号罗列符号与前置抽象维度标签。
func cleanTitleBody(body string) string {
	cleaned := strings.TrimSpace(body)
	if cleaned == "" {
		return ""
	}

	// 1. 若末尾包含物理文件名与后缀（如 "项目全景与训练入口 train.py"）
	if loc := mdpat.TrailingFileWithExtRe.FindStringSubmatchIndex(cleaned); len(loc) >= 6 {
		fileToken := cleaned[loc[4]:loc[5]]
		if !mdpat.PreservedTechNamesRe.MatchString(fileToken) {
			prefix := strings.TrimSpace(cleaned[:loc[0]])
			if len([]rune(prefix)) >= 2 {
				cleaned = prefix
			}
		}
	}

	// 2. 剥除末尾括号罗列代码符号/清单（如 " (Domain、NewDomain 与 matcherset)", " (Command、errors)"）
	if loc := mdpat.TrailingParenSymbolsRe.FindStringSubmatchIndex(cleaned); len(loc) >= 4 {
		inner := strings.TrimSpace(cleaned[loc[2]:loc[3]])
		if isParenSymbolDump(inner) {
			prefix := strings.TrimSpace(cleaned[:loc[0]])
			if len([]rune(prefix)) >= 2 {
				cleaned = prefix
			}
		}
	}

	// 3. 剥除前置抽象架构维度标签（如 "门面契约与域名匹配体系" -> "域名匹配体系", "核心执行引擎: 命令框架..." -> "命令框架..."）
	if loc := mdpat.DimensionPrefixZhRe.FindStringIndex(cleaned); len(loc) >= 2 {
		rest := strings.TrimSpace(cleaned[loc[1]:])
		if len([]rune(rest)) >= 3 {
			cleaned = rest
		}
	} else if loc := mdpat.DimensionPrefixEnRe.FindStringIndex(cleaned); len(loc) >= 2 {
		rest := strings.TrimSpace(cleaned[loc[1]:])
		if len(strings.Fields(rest)) >= 2 {
			cleaned = rest
		}
	}

	// 4. 若仍含有裸露的代码扩展名（如 "train.py" 剥除为 "train"）
	if mdpat.EmbeddedCodeExtRe.MatchString(cleaned) {
		cleaned = mdpat.EmbeddedCodeExtRe.ReplaceAllStringFunc(cleaned, func(m string) string {
			if strings.EqualFold(m, ".js") && mdpat.PreservedTechNamesRe.MatchString(cleaned) {
				return m
			}
			return ""
		})
		cleaned = strings.TrimSpace(cleaned)
	}

	// 5. 清除末尾残留标点符号
	cleaned = strings.TrimRight(cleaned, ":：-—–、. ()（）[]\"'`")
	return strings.TrimSpace(cleaned)
}

// CleanChapterTitle 对整章标题执行确定性清洗，去除物理代码扩展名后缀（File ≠ Cognitive Unit）。
func CleanChapterTitle(title string) string {
	title = strings.TrimSpace(title)
	if title == "" {
		return ""
	}
	matches := mdpat.ChapterPrefixRe.FindStringSubmatch(title)
	if len(matches) == 0 {
		return cleanTitleBody(title)
	}
	isZh := matches[1] != ""
	num := matches[1]
	if !isZh {
		num = matches[2]
	}
	rest := strings.TrimSpace(matches[3])
	rest = strings.TrimLeft(rest, ":：-—–、. ")
	rest = cleanTitleBody(rest)

	if isZh {
		if rest != "" {
			return fmt.Sprintf("第 %s 章：%s", num, rest)
		}
		return fmt.Sprintf("第 %s 章", num)
	}
	if rest != "" {
		return fmt.Sprintf("Chapter %s: %s", num, rest)
	}
	return fmt.Sprintf("Chapter %s", num)
}

// RenumberChapterTitle 对单章标题执行连续重编号 (1..M)。
// 若包含 "第 X 章" 或 "Chapter X" 前缀，则替换为新的序号；若无前缀，保持原样。
func RenumberChapterTitle(title string, newNo int) string {
	matches := mdpat.ChapterPrefixRe.FindStringSubmatch(strings.TrimSpace(title))
	if len(matches) == 0 {
		return CleanChapterTitle(title)
	}
	isZh := matches[1] != ""
	rest := strings.TrimSpace(matches[3])
	rest = strings.TrimLeft(rest, ":：-—–、. ")
	rest = cleanTitleBody(rest)
	if isZh {
		if rest != "" {
			return fmt.Sprintf("第 %d 章：%s", newNo, rest)
		}
		return fmt.Sprintf("第 %d 章", newNo)
	}
	if rest != "" {
		return fmt.Sprintf("Chapter %d: %s", newNo, rest)
	}
	return fmt.Sprintf("Chapter %d", newNo)
}

// RenumberOutlineChapters 对大纲章节序列重新进行连续编号 (1..M)。
// 剔除空章后，保证留存的章节序号严格单调递增，不出现类似 "第 1, 2, 4, 6 章" 的跳号断号。
func RenumberOutlineChapters(chapters []OutlineChapter) []OutlineChapter {
	if len(chapters) == 0 {
		return chapters
	}
	out := make([]OutlineChapter, len(chapters))
	for i, ch := range chapters {
		ch.Name = RenumberChapterTitle(ch.Name, i+1)
		out[i] = ch
	}
	return out
}

func disambiguateTailMatches(tailMatches []string, candidateFiles []CandidateOutlineFile, validFiles []ChapterFile) string {
	if len(tailMatches) == 0 {
		return ""
	}
	if len(tailMatches) == 1 {
		return tailMatches[0]
	}

	// 1) 优先匹配存在于 candidateFiles 候选列表中的真实路径
	for _, c := range candidateFiles {
		for _, tm := range tailMatches {
			if tm == c.Path {
				return tm
			}
		}
	}

	// 2) 优先与当前章节已收录文件共享父目录的路径
	if len(validFiles) > 0 {
		currentDirs := extractParentDirs(validFiles)
		for _, tm := range tailMatches {
			for _, d := range currentDirs {
				if strings.HasPrefix(tm, d+"/") {
					return tm
				}
			}
		}
	}

	// 3) 确定性回退：选取路径深度最浅（最靠近根部）的项
	sorted := make([]string, len(tailMatches))
	copy(sorted, tailMatches)
	sort.Slice(sorted, func(i, j int) bool {
		depthI := strings.Count(sorted[i], "/")
		depthJ := strings.Count(sorted[j], "/")
		if depthI != depthJ {
			return depthI < depthJ
		}
		return sorted[i] < sorted[j]
	})
	return sorted[0]
}

func extractParentDirs(files []ChapterFile) []string {
	var dirs []string
	for _, vf := range files {
		idx := strings.LastIndex(vf.Path, "/")
		if idx > 0 {
			dir := vf.Path[:idx]
			if dir != "" {
				dirs = append(dirs, dir)
			}
		}
	}
	return dirs
}

// SanitizeDraftModules 校验并清洗模块目录列表
func SanitizeDraftModules(
	modules []DraftModule,
	nodes []GitNode,
	prefix string,
	patterns Patterns,
) []DraftModule {
	var realBlobs []GitNode
	realFilePaths := make(map[string]bool)
	realDirsMap := make(map[string]bool)
	var realDirsList []string

	for _, n := range nodes {
		if n.Type == "blob" {
			realBlobs = append(realBlobs, n)
			realFilePaths[n.Path] = true
			parts := strings.Split(n.Path, "/")
			accum := ""
			for i := 0; i < len(parts)-1; i++ {
				accum += parts[i] + "/"
				if !realDirsMap[accum] {
					realDirsMap[accum] = true
					realDirsList = append(realDirsList, accum)
				}
			}
		}
	}

	var validModules []DraftModule

	for _, mod := range modules {
		var cleanDirs []string
		for _, rawDir := range mod.Directories {
			trimmed := strings.TrimSpace(rawDir)
			if strings.HasPrefix(trimmed, "./") {
				trimmed = strings.TrimPrefix(trimmed, "./")
			}
			trimmed = strings.TrimLeft(trimmed, "/")
			if trimmed == "" {
				cleanDirs = append(cleanDirs, "")
				continue
			}
			norm := trimmed
			if !strings.HasSuffix(norm, "/") {
				norm += "/"
			}

			if patterns.IsNonContentDir(norm) || patterns.IsTestFile(norm) {
				continue
			}

			if realDirsMap[norm] {
				cleanDirs = append(cleanDirs, norm)
				continue
			}

			if prefix != "" {
				normPrefix := strings.TrimPrefix(prefix, "./")
				normPrefix = strings.TrimLeft(normPrefix, "/")
				var withPrefix string
				if strings.HasSuffix(normPrefix, "/") {
					withPrefix = normPrefix + norm
				} else {
					withPrefix = normPrefix + "/" + norm
				}
				if realDirsMap[withPrefix] && !patterns.IsNonContentDir(withPrefix) && !patterns.IsTestFile(withPrefix) {
					cleanDirs = append(cleanDirs, withPrefix)
					continue
				}
			}

			lastSeg := strings.TrimSuffix(norm, "/")
			if idx := strings.LastIndex(lastSeg, "/"); idx >= 0 {
				lastSeg = lastSeg[idx+1:]
			}
			if lastSeg != "" {
				var matched string
				for _, d := range realDirsList {
					if !patterns.IsNonContentDir(d) && !patterns.IsTestFile(d) &&
						(d == lastSeg+"/" || strings.HasSuffix(d, "/"+lastSeg+"/")) {
						matched = d
						break
					}
				}
				if matched != "" {
					cleanDirs = append(cleanDirs, matched)
					continue
				}
			}

			hasPrefixFiles := false
			for _, b := range realBlobs {
				if strings.HasPrefix(b.Path, norm) && !patterns.IsNonContentDir(b.Path) && !patterns.IsTestFile(b.Path) {
					hasPrefixFiles = true
					break
				}
			}
			if hasPrefixFiles {
				cleanDirs = append(cleanDirs, norm)
			}
		}

		var uniqueDirs []string
		seenDir := make(map[string]bool)
		for _, d := range cleanDirs {
			if !seenDir[d] {
				seenDir[d] = true
				uniqueDirs = append(uniqueDirs, d)
			}
		}

		if len(uniqueDirs) > 0 {
			validModules = append(validModules, DraftModule{
				Name:        mod.Name,
				Summary:     mod.Summary,
				Directories: uniqueDirs,
				Granularity: mod.Granularity,
			})
		} else {
			validModules = append(validModules, DraftModule{
				Name:        mod.Name,
				Summary:     mod.Summary,
				Directories: []string{prefix},
				Granularity: mod.Granularity,
			})
		}
	}

	return validModules
}
