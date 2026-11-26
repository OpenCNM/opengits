package ingest

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/archive"
	"github.com/opengits/worker-sidecar/internal/cluster"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

type GitNode = cluster.GitNode
type ModuleSnapshot = cluster.ModuleSnapshot
type ClusterDiffResult = cluster.ClusterDiffResult
type ClusterMatchedPair = cluster.ClusterMatchedPair
type ClusterRemovedItem = cluster.ClusterRemovedItem
type ClusterRecomputeRequest = cluster.ClusterRecomputeRequest
type ClusterRecomputeResponse = cluster.ClusterRecomputeResponse
type DraftModuleInput = cluster.DraftModuleInput

func RecomputeModuleSnapshots(oldModules []ModuleSnapshot, nodes []GitNode, patterns *IngestPatterns) []ModuleSnapshot {
	return cluster.RecomputeModuleSnapshots(oldModules, nodes, patterns)
}

func DiffCodeClusters(oldClusters, newClusters []ModuleSnapshot) ClusterDiffResult {
	return cluster.DiffCodeClusters(oldClusters, newClusters)
}

func MatchModuleFiles(nodes []GitNode, directories []string, patterns *IngestPatterns) []string {
	return cluster.MatchModuleFiles(nodes, directories, patterns)
}

func InferDirectories(files []string) []string {
	return cluster.InferDirectories(files)
}

func JaccardSimilarity(a, b []string) float64 {
	return cluster.JaccardSimilarity(a, b)
}

func GroupModulesByDirectory(nodes []GitNode, patterns *IngestPatterns) []ModuleSnapshot {
	return cluster.GroupModulesByDirectory(nodes, patterns)
}

func BuildModuleSnapshots(modules []DraftModuleInput, nodes []GitNode, patterns *IngestPatterns) []ModuleSnapshot {
	return cluster.BuildModuleSnapshots(modules, nodes, patterns)
}

func (p *IngestPatterns) IsDocFile(fp string) bool {
	if fp == "" {
		return false
	}
	return p.DocExtensions[strings.ToLower(mdpat.ExtractExtension(fp))]
}

func (p *IngestPatterns) IsCodeFile(fp string) bool {
	if fp == "" {
		return false
	}
	return p.CodeExtensions[strings.ToLower(mdpat.ExtractExtension(fp))]
}

func (p *IngestPatterns) IsNonContentDir(fp string) bool {
	if fp == "" {
		return false
	}
	trimmed := strings.Trim(fp, "/")
	if trimmed == "" {
		return false
	}
	for _, seg := range strings.Split(trimmed, "/") {
		if seg == "" {
			continue
		}
		for _, re := range p.nonContentDir {
			if re.MatchString(seg) {
				return true
			}
		}
	}
	return false
}

func (p *IngestPatterns) IsNonContentFile(fp string) bool {
	if fp == "" {
		return false
	}
	parts := strings.Split(fp, "/")
	fileName := parts[len(parts)-1]
	if i := strings.LastIndex(fileName, "."); i >= 0 && i > 0 {
		if re := extTailRe.FindString(fileName); re != "" {
			fileName = strings.TrimSuffix(fileName, re)
		}
	}
	if fileName == "" {
		return false
	}
	for _, re := range p.nonContentFile {
		if re.MatchString(fileName) {
			return true
		}
	}
	return false
}

var extTailRe = mdpat.ExtTailRe

type DocCodeRatio = archive.DocCodeRatio

type IngestModeResult struct {
	Mode         string       `json:"mode"`
	DocCodeRatio DocCodeRatio `json:"docCodeRatio"`
}

func (p *IngestPatterns) ComputeIngestMode(nodes []GitNode, existingTextRoot string) IngestModeResult {
	docFiles, codeFiles, otherFiles := 0, 0, 0
	var docBytes, codeBytes int64
	docExts := map[string]int{}
	codeExts := map[string]int{}

	for _, node := range nodes {
		if node.Type != "blob" {
			continue
		}
		if p.IsNonContentDir(node.Path) || p.IsNonContentFile(node.Path) {
			otherFiles++
			continue
		}
		dirPath := ""
		if i := strings.LastIndex(node.Path, "/"); i >= 0 {
			dirPath = node.Path[:i]
		}
		if dirPath != "" {
			matched := false
			for _, re := range p.Sniffer.translationDir {
				if re.MatchString(dirPath) {
					matched = true
					break
				}
			}
			if matched {
				otherFiles++
				continue
			}
		}

		ext := strings.ToLower(pathExt(node.Path))

		if p.IsDocFile(node.Path) {
			docFiles++
			docBytes += node.Size
			docExts[ext]++
		} else if p.IsCodeFile(node.Path) {
			codeFiles++
			codeBytes += node.Size
			codeExts[ext]++
		} else {
			otherFiles++
		}
	}

	validTotal := docFiles + codeFiles
	ratio := 1.0
	if validTotal > 0 {
		ratio = float64(docFiles) / float64(validTotal)
	}

	r := DocCodeRatio{
		DocFiles:       docFiles,
		CodeFiles:      codeFiles,
		OtherFiles:     otherFiles,
		TotalFiles:     len(nodes),
		Ratio:          roundTo(ratio, 4),
		CodeExtensions: codeExts,
		DocExtensions:  docExts,
		CodeBytes:      codeBytes,
		DocBytes:       docBytes,
	}

	if codeFiles == 0 {
		return IngestModeResult{Mode: "text_only", DocCodeRatio: r}
	}
	if docFiles <= 1 {
		return IngestModeResult{Mode: "code_only", DocCodeRatio: r}
	}
	if existingTextRoot != "" {
		for _, re := range p.Sniffer.docRoot {
			if re.MatchString(existingTextRoot) {
				return IngestModeResult{Mode: "text_only", DocCodeRatio: r}
			}
		}
	}
	hasDocRoot := false
	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		for _, re := range p.Sniffer.docRoot {
			if re.MatchString(n.Path) {
				hasDocRoot = true
				break
			}
		}
		if hasDocRoot {
			break
		}
	}
	if hasDocRoot && docFiles >= 5 && docFiles >= codeFiles {
		return IngestModeResult{Mode: "text_only", DocCodeRatio: r}
	}

	switch {
	case ratio >= p.TextOnlyRatioThreshold:
		return IngestModeResult{Mode: "text_only", DocCodeRatio: r}
	case ratio <= p.CodeOnlyRatioThreshold:
		return IngestModeResult{Mode: "code_only", DocCodeRatio: r}
	default:
		return IngestModeResult{Mode: "hybrid", DocCodeRatio: r}
	}
}

type ScaleDecision = archive.ScaleDecision

type ScaleAccumulator struct {
	patterns        *IngestPatterns
	totalValidFiles int
	maxDepth        int
	deepFiles       int
}

func NewScaleAccumulator(patterns *IngestPatterns) *ScaleAccumulator {
	return &ScaleAccumulator{patterns: patterns}
}

func (acc *ScaleAccumulator) IngestPath(path string) {
	if acc.patterns.IsNonContentDir(path) || acc.patterns.IsNonContentFile(path) {
		return
	}
	dirPath := ""
	if i := strings.LastIndex(path, "/"); i >= 0 {
		dirPath = path[:i]
	}
	if dirPath != "" {
		for _, re := range acc.patterns.Sniffer.translationDir {
			if re.MatchString(dirPath) {
				return
			}
		}
	}
	acc.totalValidFiles++
	depth := strings.Count(path, "/") + 1
	if depth >= 6 {
		acc.deepFiles++
	}
	if depth > acc.maxDepth {
		acc.maxDepth = depth
	}
}

func (acc *ScaleAccumulator) IsGiantNow() bool {
	return acc.totalValidFiles > 1000 || (acc.maxDepth >= 6 && acc.totalValidFiles >= 300)
}

func (acc *ScaleAccumulator) Decision() ScaleDecision {
	deepRatio := 0.0
	if acc.totalValidFiles > 0 {
		deepRatio = float64(acc.deepFiles) / float64(acc.totalValidFiles)
	}

	if acc.totalValidFiles < 300 && deepRatio < 0.3 {
		return ScaleDecision{Scale: "normal", Confidence: "high",
			Reason:     cn("有效文件数 (%d) 与目录深度 (%d) 适中，适合生成结构化线性教程", acc.totalValidFiles, acc.maxDepth),
			TotalFiles: acc.totalValidFiles, MaxDepth: acc.maxDepth}
	}
	if acc.totalValidFiles > 1000 || (acc.maxDepth >= 6 && acc.totalValidFiles >= 300) {
		return ScaleDecision{Scale: "giant", Confidence: "high",
			Reason:     cn("有效文件数 (%d) 庞大或目录极深 (%d)，自动分流至网状架构探索器形态", acc.totalValidFiles, acc.maxDepth),
			TotalFiles: acc.totalValidFiles, MaxDepth: acc.maxDepth}
	}
	return ScaleDecision{Scale: "ambiguous", Confidence: "low",
		Reason: cn("处于规模灰区 (%d 文件, 深度 %d, 深层占比 %.0f%%)，建议结合顶层子系统分布进行智能分析或由用户按需选择",
			acc.totalValidFiles, acc.maxDepth, roundHalfAway(deepRatio*100)),
		TotalFiles: acc.totalValidFiles, MaxDepth: acc.maxDepth}
}

func (p *IngestPatterns) ComputeRepoScale(nodes []GitNode) ScaleDecision {
	acc := NewScaleAccumulator(p)
	for _, node := range nodes {
		if node.Type == "blob" {
			acc.IngestPath(node.Path)
		}
	}
	return acc.Decision()
}

type SniffProfile = archive.SniffProfile

func (p *IngestPatterns) SniffRepo(nodes []GitNode, isTreeTruncated bool) SniffProfile {
	mdCount := 0
	labDirs := map[string]bool{}
	docsRootCandidates := map[string]int{}
	var docsRootOrder []string
	var textRoot *string
	var answerFile *string
	prof := SniffProfile{IsTreeTruncated: isTreeTruncated, LabRoots: []string{},
		TranslationRoots: []string{}, ExcludeFromNav: []string{}, SemanticTags: map[string]string{}}
	prof.GlobalAssets.Pdfs = make([]struct {
		Path string `json:"path"`
		Size int64  `json:"size"`
		Lang string `json:"lang,omitempty"`
	}, 0)
	prof.GlobalAssets.Translations = make([]struct {
		Lang string `json:"lang"`
		Dir  string `json:"dir"`
	}, 0)
	prof.GlobalAssets.BuildScripts = make([]string, 0)
	prof.GlobalAssets.Misc = make([]string, 0)

	for _, node := range nodes {
		if node.Type == "blob" {
			isMd := p.IsDocFile(node.Path)
			if isMd {
				mdCount++
				for _, re := range p.Sniffer.docRootDir {
					if m := re.FindStringSubmatch(node.Path); m != nil {
						root := strings.ToLower(m[1])
						recordDocsRootCandidate(docsRootCandidates, &docsRootOrder, root)
						break
					}
				}
			}
			isCourse := false
			for _, re := range p.Sniffer.course {
				if re.MatchString(node.Path) {
					isCourse = true
					break
				}
			}
			if isCourse {
				for _, re := range p.Sniffer.courseRootDir {
					if m := re.FindStringSubmatch(node.Path); m != nil {
						labDirs[strings.ToLower(m[1])+"/"] = true
						break
					}
				}
			}
			var pdfLang string
			for _, re := range p.Sniffer.pdfLang {
				if m := re.FindStringSubmatch(node.Path); m != nil {
					pdfLang = m[1]
					break
				}
			}
			if pdfLang != "" || (strings.HasSuffix(strings.ToLower(node.Path), ".pdf") && node.Size > 500*1024) {
				prof.GlobalAssets.Pdfs = append(prof.GlobalAssets.Pdfs, struct {
					Path string `json:"path"`
					Size int64  `json:"size"`
					Lang string `json:"lang,omitempty"`
				}{Path: node.Path, Size: node.Size, Lang: pdfLang})
				prof.ExcludeFromNav = append(prof.ExcludeFromNav, node.Path,
					strings.TrimSuffix(node.Path, ".pdf")+".md")
			}
			if isMd {
				for _, re := range p.Sniffer.answer {
					if re.MatchString(node.Path) {
						s := node.Path
						answerFile = &s
						prof.ExcludeFromNav = append(prof.ExcludeFromNav, node.Path)
						prof.SemanticTags[node.Path] = "answer"
						break
					}
				}
			}
			for _, re := range p.Sniffer.buildScript {
				if re.MatchString(node.Path) {
					prof.GlobalAssets.BuildScripts = append(prof.GlobalAssets.BuildScripts, node.Path)
					prof.ExcludeFromNav = append(prof.ExcludeFromNav, node.Path, node.Path+".md")
					break
				}
			}
		}
		dirPath := ""
		if node.Type == "tree" {
			dirPath = node.Path
		} else if i := strings.LastIndex(node.Path, "/"); i >= 0 {
			dirPath = node.Path[:i]
		}
		if dirPath != "" {
			for _, re := range p.Sniffer.translationDir {
				if m := re.FindStringSubmatch(dirPath); m != nil {
					fullDir := dirPath + "/"
					if !sliceContains(prof.TranslationRoots, fullDir) {
						prof.GlobalAssets.Translations = append(prof.GlobalAssets.Translations, struct {
							Lang string `json:"lang"`
							Dir  string `json:"dir"`
						}{Lang: m[1], Dir: fullDir})
						prof.TranslationRoots = append(prof.TranslationRoots, fullDir)
					}
					break
				}
			}
		}
	}

	if len(docsRootCandidates) > 0 {
		sorted := append([]string(nil), docsRootOrder...)
		sort.SliceStable(sorted, func(i, j int) bool {
			return docsRootCandidates[sorted[i]] > docsRootCandidates[sorted[j]]
		})
		if docsRootCandidates[sorted[0]] >= 3 {
			s := sorted[0] + "/"
			textRoot = &s
		}
	}

	labRoots := make([]string, 0, len(labDirs))
	for d := range labDirs {
		labRoots = append(labRoots, d)
	}
	sort.Strings(labRoots)
	prof.LabRoots = labRoots
	prof.TextRoot = textRoot
	prof.AnswerFile = answerFile

	hasTextRoot := textRoot != nil
	hasLabs := len(labRoots) >= 3
	hasCourseOrLabs := len(labRoots) >= 1
	hasPDF := len(prof.GlobalAssets.Pdfs) > 0
	hasAnswer := answerFile != nil

	switch {
	case hasTextRoot && hasLabs && (hasPDF || hasAnswer):
		prof.Tier, prof.RepoType = "S", "textbook"
	case hasTextRoot && hasCourseOrLabs:
		prof.Tier, prof.RepoType = "A", "course"
	case hasTextRoot || mdCount >= 5:
		prof.Tier, prof.RepoType = "B", "docs"
	case mdCount >= 2 && mdCount <= 4:
		prof.Tier, prof.RepoType = "C", "notebook"
	default:
		prof.Tier, prof.RepoType = "D", "codebase"
	}

	modeRes := p.ComputeIngestMode(nodes, derefStrPtr(textRoot))
	prof.IngestMode = modeRes.Mode
	prof.DocCodeRatio = modeRes.DocCodeRatio
	prof.HasTranslations = len(prof.TranslationRoots) > 0
	prof.ChapterCount = 0
	return prof
}

func pathExt(fp string) string {
	if m := pathExtRe.FindStringSubmatch(fp); m != nil {
		return "." + strings.ToLower(m[1])
	}
	return ""
}

var pathExtRe = regexp.MustCompile(`\.([a-zA-Z0-9]+)$`)

func roundTo(v float64, digits int) float64 {
	pow := math.Pow(10, float64(digits))
	return math.Round(v*pow) / pow
}

func roundHalfAway(v float64) float64 {
	return math.Floor(v + 0.5)
}

func cn(format string, args ...any) string { return fmt.Sprintf(format, args...) }

func sliceContains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

func derefStrPtr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func recordDocsRootCandidate(docsRootCandidates map[string]int, docsRootOrder *[]string, root string) {
	if _, seen := docsRootCandidates[root]; !seen {
		*docsRootOrder = append(*docsRootOrder, root)
	}
	docsRootCandidates[root]++
}
