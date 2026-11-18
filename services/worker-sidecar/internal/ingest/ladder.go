package ingest

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"path/filepath"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// 证据阶梯（章节派生单一有序链，按证据权威降级，命中即停）：
// customOutline(用户确认/树管线产物) → draftOutline(LLM草稿) → chapterMap(tier S/A 教材)
// → RSG 认知投影(code仓) → 规则树兜底。
// 规模/tier 只决定格子资格，不改变链序；本文件是各格子的纯函数产物面。
// ─────────────────────────────────────────────────────────────

// snapshotsFromCustomOutline 阶梯 4.0（code 口径）：用户确认大纲 → 作用域
// 校验后的模块快照（教学顺序保持用户定义）。
func snapshotsFromCustomOutline(categories []CustomOutlineCategory, activeModuleNames []string, nodes []GitNode) []ModuleSnapshot {
	scopeBlobSet := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if n.Type == "blob" {
			scopeBlobSet[n.Path] = true
		}
	}
	return buildSnapshotsFromCustomOutline(categories, activeModuleNames, scopeBlobSet)
}

// snapshotsFromDraftModules 阶梯 4.2（code 口径）：LLM 草稿模块（activeModuleNames
// 收窄）→ 目录匹配模块快照。
func snapshotsFromDraftModules(modules []ConfirmedModule, activeModuleNames []string, nodes []GitNode, patterns *Patterns) []ModuleSnapshot {
	draftModules := modules
	if len(activeModuleNames) > 0 {
		activeSet := make(map[string]bool, len(activeModuleNames))
		for _, name := range activeModuleNames {
			activeSet[name] = true
		}
		var filtered []ConfirmedModule
		for _, m := range draftModules {
			if activeSet[m.Name] {
				filtered = append(filtered, m)
			}
		}
		if len(filtered) > 0 {
			draftModules = filtered
		}
	}

	draftInputs := make([]DraftModuleInput, len(draftModules))
	for i, m := range draftModules {
		draftInputs[i] = DraftModuleInput{
			Name:        m.Name,
			Summary:     m.Summary,
			Directories: m.Directories,
			Granularity: m.Granularity,
		}
	}
	return BuildModuleSnapshots(draftInputs, nodes, patterns)
}

// normalizeSnapshots 快照字段缺省补齐（ChapterNo/Granularity/Directories/Files）。
func normalizeSnapshots(snapshots []ModuleSnapshot) []ModuleSnapshot {
	for i := range snapshots {
		if snapshots[i].ChapterNo == 0 {
			snapshots[i].ChapterNo = snapshots[i].TeachingOrder
		}
		if snapshots[i].Granularity == "" {
			snapshots[i].Granularity = "standard"
		}
		if snapshots[i].Directories == nil {
			snapshots[i].Directories = make([]string, 0)
		}
		if snapshots[i].Files == nil {
			snapshots[i].Files = make([]string, 0)
		}
	}
	return snapshots
}

// cognitionJSON 投影元数据 → ModuleSnapshot.Cognitive JSON（编码失败返回 nil）。
func cognitionJSON(p ProjectedModule) []byte {
	cog := ModuleCognition{
		Phase:             p.Phase,
		PhaseOrder:        p.PhaseOrder,
		Rationale:         p.CognitiveRationale,
		UpstreamModules:   p.UpstreamModules,
		DownstreamModules: p.DownstreamModules,
		GoldenSymbols:     p.GoldenSymbols,
		CallFlow:          p.CallFlow,
	}
	b, err := json.Marshal(cog)
	if err != nil {
		return nil
	}
	return b
}

// projectSnapshotsInPhaseOrder 图论认知梯度投影重排：按投影相位序重赋
// chapterNo/teachingOrder 并绑定认知元数据（教学顺序由调用依赖拓扑决定）。
// 相位投票阈值走 projector 默认 0.25（原对齐 ENGINE_CONFIG.semanticGraph.
// primaryEntryMassRatio，该键已于 2026-11 清算移除；此前的 0.15 属无来源硬编码）。
func projectSnapshotsInPhaseOrder(artifact *SemanticGraphArtifact, snapshots []ModuleSnapshot) []ModuleSnapshot {
	drafts := make([]ModuleDraftInput, len(snapshots))
	for i, s := range snapshots {
		idx := i
		drafts[i] = ModuleDraftInput{
			Name:        s.Title,
			Summary:     s.Summary,
			Directories: s.Directories,
			DraftIndex:  &idx,
		}
	}
	projected := ProjectToCognitiveGradient(artifact, drafts, PhaseVoteOptions{})

	sorted := make([]ModuleSnapshot, len(projected))
	for i, p := range projected {
		origIdx := i
		if p.DraftIndex != nil && *p.DraftIndex < len(snapshots) {
			origIdx = *p.DraftIndex
		}
		s := snapshots[origIdx]
		s.TeachingOrder = i + 1
		s.ChapterNo = i + 1
		s.Title = cognitive.RenumberChapterTitle(s.Title, i+1)
		s.Cognitive = cognitionJSON(p)
		sorted[i] = s
	}
	return sorted
}

// attachCognitiveMetadata 保序认知增强：仅绑定 Cognitive 元数据（相位/金标
// 符号/调用流），绝不重排 TeachingOrder/ChapterNo——对齐 Node code-ingest.
// ts:244-254（customOutline/draft 路径同样投影，"保留用户章节排序，仅丰富
// 认知元数据"）。
func attachCognitiveMetadata(artifact *SemanticGraphArtifact, snapshots []ModuleSnapshot) {
	if artifact == nil || len(snapshots) == 0 {
		return
	}
	drafts := make([]ModuleDraftInput, len(snapshots))
	for i, s := range snapshots {
		idx := i
		drafts[i] = ModuleDraftInput{
			Name:        s.Title,
			Summary:     s.Summary,
			Directories: s.Directories,
			DraftIndex:  &idx,
		}
	}
	projected := ProjectToCognitiveGradient(artifact, drafts, PhaseVoteOptions{})
	byIdx := make(map[int]ProjectedModule, len(projected))
	for _, p := range projected {
		if p.DraftIndex != nil {
			byIdx[*p.DraftIndex] = p
		}
	}
	for i := range snapshots {
		if p, ok := byIdx[i]; ok {
			snapshots[i].Cognitive = cognitionJSON(p)
		}
	}
}

// buildGraphArtifact RSG 语义图构建（code 仓共享内核）。Fail-Closed：构建
// 失败显式报错（Node code-ingest.ts:205 "严禁静默降级"——错误绝不吞成
// 零符号投影的静默降级大纲）。
func buildGraphArtifact(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow, sha string, nodes []GitNode) (*SemanticGraphArtifact, error) {
	if deps.Languages == nil {
		return nil, fmt.Errorf("language definitions not configured — semantic graph build unavailable for %s/%s", job.Owner, job.Repo)
	}
	graphDir := deps.GraphDir
	if graphDir == "" {
		graphDir = cfg.SemanticGraphDir
	}
	if graphDir == "" {
		graphDir = "storage/graphs"
	}
	artifact, err := BuildRepoSemanticGraph(ctx, deps.ArchiveRoot, graphDir, job.Owner, job.Repo, sha, deps.Languages, deps.Patterns, nodes)
	if err != nil {
		return nil, fmt.Errorf("semantic graph build failed for %s/%s: %w", job.Owner, job.Repo, err)
	}
	if deps.GraphRepo != nil && artifact != nil {
		if serr := deps.GraphRepo.SaveArtifact(ctx, job.Owner, job.Repo, sha, artifact); serr != nil {
			log.Printf("[ingest] persist semantic graph to DB failed (%s/%s@%s): %v", job.Owner, job.Repo, sha, serr)
		}
	}
	return artifact, nil
}

// snapshotsFromOutlineChapters 将认知大纲章节转化为模块快照（保留 path[#anchor] 物理锚点）。
func snapshotsFromOutlineChapters(chapters []cognitive.OutlineChapter) []ModuleSnapshot {
	snapshots := make([]ModuleSnapshot, 0, len(chapters))
	for i, ch := range chapters {
		var files []string
		for _, f := range ch.Files {
			if f.Path == "" {
				continue
			}
			files = append(files, mdpat.JoinPathAnchor(f.Path, f.Anchor))
		}
		if len(files) == 0 {
			continue
		}
		order := i + 1
		title := ch.Name
		if title == "" {
			title = fmt.Sprintf("Chapter %d", order)
		}
		dirs := InferDirectories(files)
		snapshots = append(snapshots, ModuleSnapshot{
			TeachingOrder: order,
			ChapterNo:     order,
			Title:         title,
			Summary:       ch.Summary,
			Directories:   dirs,
			Granularity:   "standard",
			Files:         files,
		})
	}
	return snapshots
}

// ladderRSGProjection 阶梯 4.4（code 仓格）：规则模块快照 + RSG 认知梯度投影。
// 建图惰性化：仅当前面格子全空轮到本格，才执行 BuildRepoSemanticGraph
// （tree-sitter 语义解析昂贵，用户已给出更高权威证据时绝不空烧）。
func ladderRSGProjection(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow, sha string, nodes []GitNode, targetLanguage string) ([]ModuleSnapshot, bool, error) {
	artifact, err := buildGraphArtifact(ctx, cfg, deps, job, sha, nodes)
	if err != nil {
		return nil, false, err
	}

	// 微型仓自适应判定：有效代码文件 <= 3 时激活 Zoom-In 符号级下钻与 Living Spec 规格归位
	candidates := cognitive.SelectCandidateFilesForOutline(nodes, 40, deps.Patterns)
	var codeCandidates []cognitive.CandidateOutlineFile
	for _, c := range candidates {
		if !c.IsDoc {
			codeCandidates = append(codeCandidates, c)
		}
	}

	if len(codeCandidates) > 0 && len(codeCandidates) <= 3 && deps.Languages != nil {
		fileReader := func(path string) ([]byte, error) {
			cleanPath, _ := mdpat.SplitPathAnchor(path)
			raw, err := readLocalArchiveFile(deps.ArchiveRoot, job.Owner, job.Repo, sha, cleanPath)
			if err != nil {
				return nil, err
			}
			if raw == "" {
				return nil, fmt.Errorf("archive file empty: %s", cleanPath)
			}
			return []byte(raw), nil
		}
		opts := cognitive.OutlineSignalOptions{
			FileReader:      fileReader,
			SymbolExtractor: deps.Languages,
		}
		chapters := cognitive.BuildRuleFallbackOutline(nodes, "", targetLanguage, deps.Patterns, opts)
		hasAnchors := false
		for _, ch := range chapters {
			for _, f := range ch.Files {
				if f.Anchor != "" || strings.Contains(f.Path, "#") {
					hasAnchors = true
					break
				}
			}
			if hasAnchors {
				break
			}
		}
		if hasAnchors && len(chapters) >= 1 {
			snapshots := normalizeSnapshots(snapshotsFromOutlineChapters(chapters))
			if len(snapshots) > 0 {
				attachCognitiveMetadata(artifact, snapshots)
				return snapshots, true, nil
			}
		}
	}

	snapshots := normalizeSnapshots(BuildModuleSnapshots(nil, nodes, deps.Patterns))
	if len(snapshots) == 0 {
		return nil, false, nil
	}
	return projectSnapshotsInPhaseOrder(artifact, snapshots), true, nil
}

// buildCodeRepoPlan 组装 code 仓 ChapterPlan：虚拟模块章节（chapters/NN.mdx）+
// 文档附页收编 + navTree 双序 + V2 大纲 + codeClusters 画像。
func buildCodeRepoPlan(snapshots []ModuleSnapshot, nodes []GitNode, patterns *Patterns, owner, repo, targetLanguage string) *ChapterPlan {
	snapshots = normalizeSnapshots(snapshots)

	totalFiles := 0
	moduleFileSet := make(map[string]bool)
	for _, s := range snapshots {
		totalFiles += len(s.Files)
		for _, f := range s.Files {
			basePath, _ := mdpat.SplitPathAnchor(f)
			if basePath != "" {
				moduleFileSet[basePath] = true
			}
			moduleFileSet[f] = true
		}
	}

	// 收编文档附页：不在任何模块内的 doc 文件 → PROCESSED 原文直存。
	// 测试目录/测试文件拒绝入场（cognitive 侧 IsTestFile 同款口径——
	// 内部测试文档不是教学认知单元，严禁混入正典，File ≠ Cognitive Unit）。
	var appendixDocs []GitNode
	for _, n := range nodes {
		if n.Type != "blob" {
			continue
		}
		if patterns != nil {
			if patterns.IsNonContentDir(n.Path) || patterns.IsNonContentFile(n.Path) {
				continue
			}
			if !patterns.IsDocFile(n.Path) {
				continue
			}
			if patterns.IsTestFile(n.Path) {
				continue
			}
		}
		if moduleFileSet[n.Path] {
			continue
		}
		appendixDocs = append(appendixDocs, n)
	}

	navTree := make([]*NavNode, 0, len(snapshots)+len(appendixDocs))
	hasParts := false
	for _, s := range snapshots {
		if strings.TrimSpace(s.PartTitle) != "" {
			hasParts = true
			break
		}
	}

	if hasParts {
		var topNodes []*NavNode
		partMap := make(map[string]*NavNode)
		partIdx := 0

		for _, s := range snapshots {
			chPath := fmt.Sprintf("chapters/%02d.mdx", s.ChapterNo)
			chNode := &NavNode{
				Name:  fmt.Sprintf("chapter-%d", s.ChapterNo),
				Title: s.Title,
				Type:  "file",
				Path:  chPath,
				Url:   fmt.Sprintf("/docs/%s/%s/chapters/%02d", strings.ToLower(owner), strings.ToLower(repo), s.ChapterNo),
			}
			pTitle := strings.TrimSpace(s.PartTitle)
			if pTitle == "" {
				topNodes = append(topNodes, chNode)
			} else {
				dirNode, exists := partMap[pTitle]
				if !exists {
					partIdx++
					dirNode = &NavNode{
						Name:     fmt.Sprintf("part-%d", partIdx),
						Title:    pTitle,
						Type:     "directory",
						Children: make([]*NavNode, 0),
					}
					partMap[pTitle] = dirNode
					topNodes = append(topNodes, dirNode)
				}
				dirNode.Children = append(dirNode.Children, chNode)
			}
		}
		navTree = append(navTree, topNodes...)
	} else {
		for _, s := range snapshots {
			chPath := fmt.Sprintf("chapters/%02d.mdx", s.ChapterNo)
			navTree = append(navTree, &NavNode{
				Name:  fmt.Sprintf("chapter-%d", s.ChapterNo),
				Title: s.Title,
				Type:  "file",
				Path:  chPath,
				Url:   fmt.Sprintf("/docs/%s/%s/chapters/%02d", strings.ToLower(owner), strings.ToLower(repo), s.ChapterNo),
			})
		}
	}
	for idx, doc := range appendixDocs {
		cleanDocTitle := docFallbackTitle(doc.Path)
		docPathClean := mdExtStripRe.ReplaceAllString(doc.Path, "")
		navTree = append(navTree, &NavNode{
			Name:  fmt.Sprintf("appendix-doc-%d", idx),
			Title: cleanDocTitle,
			Type:  "file",
			Path:  doc.Path,
			Url:   fmt.Sprintf("/docs/%s/%s/%s", strings.ToLower(owner), strings.ToLower(repo), docPathClean),
		})
	}

	profilePatch := map[string]any{"codeClusters": snapshots}
	if targetLanguage != "" {
		profilePatch["targetLanguage"] = targetLanguage
	}
	return &ChapterPlan{
		Chapters:     chaptersFromSnapshots(snapshots),
		NavTree:      navTree,
		Draft:        OutlineFromNavTree(navTree),
		ProfilePatch: profilePatch,
		AppendixDocs: appendixDocs,
	}
}

// ───────── text 口径格子产物 ─────────

// chaptersFromDraftOutline 阶梯 4.1：LLM 草稿预构章节（outline）→ ChapterInput
// （标题链 shortTitle → title → 路径末段兜底）。
func chaptersFromDraftOutline(outline []DraftOutlineChapter) []ChapterInput {
	var chapters []ChapterInput
	for _, ch := range outline {
		var files []ChapterFile
		for _, f := range ch.Files {
			if f.Path == "" {
				continue
			}
			shortTitle := f.ShortTitle
			if shortTitle == "" {
				shortTitle = f.Title
			}
			if shortTitle == "" {
				shortTitle = docFallbackTitle(f.Path)
			}
			files = append(files, ChapterFile{Path: f.Path, Anchor: f.Anchor, ShortTitle: shortTitle})
		}
		if len(files) > 0 {
			title := ch.Title
			if title == "" {
				title = ch.Name
			}
			if title == "" {
				title = fmt.Sprintf("Chapter %d", len(chapters)+1)
			}
			chapters = append(chapters, ChapterInput{Title: title, Files: files})
		}
	}
	return chapters
}

// chaptersFromDraftModules 阶梯 4.2（text 口径）：LLM 草稿模块 → 目录前缀匹配章节。
func chaptersFromDraftModules(modules []ConfirmedModule, nodes []GitNode, patterns *Patterns) []ChapterInput {
	var chapters []ChapterInput
	for idx, mod := range modules {
		matched := MatchModuleFiles(nodes, mod.Directories, patterns)
		if len(matched) == 0 {
			continue
		}
		files := make([]ChapterFile, 0, len(matched))
		for _, p := range matched {
			files = append(files, ChapterFile{
				Path:       p,
				ShortTitle: docFallbackTitle(p),
			})
		}
		title := mod.Name
		if title == "" {
			title = fmt.Sprintf("Module %d", idx+1)
		}
		chapters = append(chapters, ChapterInput{Title: title, Files: files})
	}
	return chapters
}

// assembleTextPlan 章节优先的 text 计划组装：由 chapters 派生大纲模型
// （摘要自 draftOutline 同位章节继承）；导航树仅在未直接提供时派生
// （课程树分支自带 navTree）。
func assembleTextPlan(chapters []ChapterInput, navTree []*NavNode, draftContent DraftOutlineContent) *ChapterPlan {
	draft := OutlineDraft{Parts: []OutlinePart{}, Chapters: []StoredOutlineChapter{}}
	derivedTree := make([]*NavNode, 0, len(chapters))
	// 摘要按章节身份（标题）继承：草稿章文件全空时会被压缩掉，同位下标
	// 从此错位一格；customOutline/chapterMap 路径的章节更来自不同来源，
	// 位置配对会把不相干摘要挂到用户章节上。重复标题首见者胜（确定性）。
	summaryByTitle := make(map[string]string, len(draftContent.Outline))
	for _, och := range draftContent.Outline {
		title := och.Title
		if title == "" {
			title = och.Name
		}
		if title == "" || och.Summary == "" {
			continue
		}
		if _, dup := summaryByTitle[title]; !dup {
			summaryByTitle[title] = och.Summary
		}
	}
	for i, ch := range chapters {
		childNodes := make([]*NavNode, 0, len(ch.Files))
		outNodes := make([]OutlineNode, 0, len(ch.Files))
		for _, f := range ch.Files {
			childNodes = append(childNodes, &NavNode{
				Name:  filepath.Base(f.Path),
				Title: f.ShortTitle,
				Type:  "file",
				Path:  f.Path,
			})
			outNodes = append(outNodes, OutlineNode{
				Title:      f.ShortTitle,
				NodeType:   "file",
				SourcePath: f.Path,
			})
		}
		derivedTree = append(derivedTree, &NavNode{
			Name:     ch.Title,
			Title:    ch.Title,
			Type:     "directory",
			Path:     ch.Title,
			Children: childNodes,
		})
		var summaryPtr *string
		if s, ok := summaryByTitle[ch.Title]; ok {
			summaryPtr = &s
		}
		draft.Chapters = append(draft.Chapters, StoredOutlineChapter{
			Title:         ch.Title,
			ChapterType:   "doc",
			TeachingOrder: i + 1,
			Nodes:         outNodes,
			Summary:       summaryPtr,
		})
	}
	providedTree := navTree != nil
	if navTree == nil {
		navTree = derivedTree
	}
	// 两级分组（Node outline-derive.ts:47-81）：显式 PartTitle 优先建组；
	// 否则仅在提供导航树（课程树分支）时按顶层目录派生 Parts 并给章打标
	//（合成树每章一目录，不构成分组语义）——教材/课程导入不再落扁平大纲
	applyOutlineParts(&draft, chapters, navTree, providedTree)
	return &ChapterPlan{Chapters: chapters, NavTree: navTree, Draft: draft}
}

// applyOutlineParts Parts 派生：① 章节自带 PartTitle（distinct 保序）→ 直接建组；
// ② 提供的导航树顶层目录 → Parts，章按首个文件归属打 PartTitle（未命中留根部）。
func applyOutlineParts(draft *OutlineDraft, chapters []ChapterInput, navTree []*NavNode, providedTree bool) {
	// ① 显式分组
	explicit := false
	for _, ch := range chapters {
		if ch.PartTitle != "" {
			explicit = true
			break
		}
	}
	if explicit {
		partOrder := make(map[string]int)
		for i := range draft.Chapters {
			if i >= len(chapters) {
				break
			}
			draft.Chapters[i].PartTitle = chapters[i].PartTitle
			if t := chapters[i].PartTitle; t != "" {
				if _, ok := partOrder[t]; !ok {
					partOrder[t] = len(draft.Parts) + 1
					draft.Parts = append(draft.Parts, OutlinePart{Title: t, TeachingOrder: partOrder[t]})
				}
			}
		}
		return
	}
	if !providedTree {
		return
	}
	// ② 导航树顶层目录分组
	type partFiles struct {
		title string
		files map[string]bool
	}
	var parts []partFiles
	for _, top := range navTree {
		if top.Type != "directory" {
			continue
		}
		files := collectFiles(top)
		if len(files) == 0 {
			continue
		}
		fs := make(map[string]bool, len(files))
		for _, f := range files {
			fs[f.SourcePath] = true
		}
		parts = append(parts, partFiles{title: navTitle(top), files: fs})
		draft.Parts = append(draft.Parts, OutlinePart{Title: navTitle(top), TeachingOrder: len(draft.Parts) + 1})
	}
	if len(parts) == 0 {
		draft.Parts = []OutlinePart{}
		return
	}
	for i := range draft.Chapters {
		if i >= len(chapters) || len(chapters[i].Files) == 0 {
			continue
		}
		for _, p := range parts {
			if p.files[chapters[i].Files[0].Path] {
				draft.Chapters[i].PartTitle = p.title
				break
			}
		}
	}
}

// planFromRuleTree 阶梯兜底（text 口径）：规则导航树 1:1 投影
// （navTree → OutlineFromNavTree → chapters）。
func planFromRuleTree(navTree []*NavNode) *ChapterPlan {
	draft := OutlineFromNavTree(navTree)
	chapters := make([]ChapterInput, 0, len(draft.Chapters))
	for _, ch := range draft.Chapters {
		files := make([]ChapterFile, 0, len(ch.Nodes))
		for _, n := range ch.Nodes {
			files = append(files, ChapterFile{Path: n.SourcePath, ShortTitle: n.Title})
		}
		chapters = append(chapters, ChapterInput{Title: ch.Title, Files: files})
	}
	return &ChapterPlan{Chapters: chapters, NavTree: navTree, Draft: draft}
}

// IngestContext 封装证据阶梯运行上下文，避免长参数列表与全局状态隐式依赖
type IngestContext struct {
	Cfg               Config
	Deps              IngestBodyDeps
	Job               JobRow
	Sha               string
	Nodes             []GitNode
	TextNodes         []GitNode
	Patterns          *Patterns
	Profile           SniffProfile
	ProvidedProfile   *envelopeRepoProfile
	CodeRepo          bool
	CustomCats        []CustomOutlineCategory
	DraftContent      DraftOutlineContent
	ScopePrefix       string
	UserId            string
	TargetLanguage    string
	ActiveModuleNames []string
}

// EvidenceLadderStep 证据阶梯评估规约接口
type EvidenceLadderStep interface {
	Name() string
	Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error)
}

// ChapterPlanLadder 章节规划证据阶梯责任链
type ChapterPlanLadder struct {
	steps []EvidenceLadderStep
}

func NewChapterPlanLadder(steps ...EvidenceLadderStep) *ChapterPlanLadder {
	return &ChapterPlanLadder{steps: steps}
}

func (l *ChapterPlanLadder) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, error) {
	for _, step := range l.steps {
		plan, ok, err := step.Evaluate(ctx, env)
		if err != nil {
			return nil, err
		}
		if ok && plan != nil {
			return plan, nil
		}
	}
	return nil, fmt.Errorf("no evidence ladder step matched for %s/%s", env.Job.Owner, env.Job.Repo)
}

// 4.0 用户工作台自定义大纲（code 口径）
type customOutlineCodeStep struct{}

func (s *customOutlineCodeStep) Name() string { return "customOutlineCode" }

func (s *customOutlineCodeStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if len(env.CustomCats) == 0 || !env.CodeRepo {
		return nil, false, nil
	}
	snapshots := snapshotsFromCustomOutline(env.CustomCats, env.ActiveModuleNames, env.Nodes)
	if len(snapshots) == 0 {
		return nil, false, nil
	}
	plan, gerr := buildCodePlanFromSnapshots(ctx, env.Cfg, env.Deps, env.Job, env.Sha, env.Nodes, env.Patterns, env.TargetLanguage, snapshots)
	if gerr != nil {
		log.Printf("[ingest-body] %v", gerr)
		env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		return nil, false, gerr
	}
	return plan, true, nil
}

// 4.0 用户工作台自定义大纲（text 口径）
type customOutlineTextStep struct{}

func (s *customOutlineTextStep) Name() string { return "customOutlineText" }

func (s *customOutlineTextStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if len(env.CustomCats) == 0 || env.CodeRepo {
		return nil, false, nil
	}
	chapters := buildChaptersFromCustomOutline(env.CustomCats, env.ScopePrefix)
	if len(chapters) == 0 {
		return nil, false, nil
	}
	return assembleTextPlan(chapters, nil, env.DraftContent), true, nil
}

// 4.1 draftOutline 预构章节（outline）
type draftOutlineStep struct{}

func (s *draftOutlineStep) Name() string { return "draftOutline" }

func (s *draftOutlineStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if len(env.DraftContent.Outline) == 0 {
		return nil, false, nil
	}
	chapters := chaptersFromDraftOutline(env.DraftContent.Outline)
	if len(chapters) == 0 {
		return nil, false, nil
	}
	return assembleTextPlan(chapters, nil, env.DraftContent), true, nil
}

// 4.2 draftOutline 模块建议（modules, code 口径）
type draftModulesCodeStep struct{}

func (s *draftModulesCodeStep) Name() string { return "draftModulesCode" }

func (s *draftModulesCodeStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if len(env.DraftContent.Modules) == 0 || !env.CodeRepo {
		return nil, false, nil
	}
	snapshots := snapshotsFromDraftModules(env.DraftContent.Modules, env.ActiveModuleNames, env.Nodes, env.Patterns)
	if len(snapshots) == 0 {
		return nil, false, nil
	}
	plan, gerr := buildCodePlanFromSnapshots(ctx, env.Cfg, env.Deps, env.Job, env.Sha, env.Nodes, env.Patterns, env.TargetLanguage, snapshots)
	if gerr != nil {
		log.Printf("[ingest-body] %v", gerr)
		env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		return nil, false, gerr
	}
	return plan, true, nil
}

// 4.2 draftOutline 模块建议（modules, text 口径）
type draftModulesTextStep struct{}

func (s *draftModulesTextStep) Name() string { return "draftModulesText" }

func (s *draftModulesTextStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if len(env.DraftContent.Modules) == 0 || env.CodeRepo {
		return nil, false, nil
	}
	chapters := chaptersFromDraftModules(env.DraftContent.Modules, env.TextNodes, env.Patterns)
	if len(chapters) == 0 {
		return nil, false, nil
	}
	return assembleTextPlan(chapters, nil, env.DraftContent), true, nil
}

// 4.25 教材/课程信号 → 章节映射链
type textbookMapStep struct{}

func (s *textbookMapStep) Name() string { return "textbookMap" }

func (s *textbookMapStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if env.CodeRepo {
		return nil, false, nil
	}
	reusedChapterMap := providedChapterMapOf(env.ProvidedProfile)
	textbookSignal := len(reusedChapterMap) > 0
	if !textbookSignal {
		chapterCount := env.Profile.ChapterCount
		textbookSignal = env.Patterns.IsTextbookRepoSignal(
			&TextbookRepoProfile{ChapterCount: &chapterCount},
			toChapterNodes(env.TextNodes),
		)
	}
	if !textbookSignal {
		return nil, false, nil
	}
	var chapterMap []ChapterMapEntry
	if len(reusedChapterMap) > 0 {
		chapterMap = reusedChapterMap
	} else {
		textRoot := resolveProfileTextRoot(env.Profile)
		chapterMap = runChapterMapChain(ctx, env.Deps, env.Patterns, env.TextNodes, textRoot, chapterMapChainDeps{
			LLM:         env.Deps.LLM,
			ArchiveRoot: env.Deps.ArchiveRoot,
			Owner:       env.Job.Owner,
			Repo:        env.Job.Repo,
			Sha:         env.Sha,
			UserId:      &env.UserId,
		})
	}
	if len(chapterMap) == 0 {
		return nil, false, nil
	}
	plan := assembleTextPlan(
		chaptersFromChapterMap(chapterMap),
		buildCurriculumTreeFromMap(chapterMap, env.Job.Owner, env.Job.Repo, env.TargetLanguage),
		env.DraftContent,
	)
	plan.ProfilePatch = map[string]any{"chapterMap": chapterMap, "profileVersion": 2}
	return plan, true, nil
}

// 4.4 RSG 认知投影（code 仓格）
type rsgProjectionStep struct{}

func (s *rsgProjectionStep) Name() string { return "rsgProjection" }

func (s *rsgProjectionStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if !env.CodeRepo {
		return nil, false, nil
	}
	snapshots, built, gerr := ladderRSGProjection(ctx, env.Cfg, env.Deps, env.Job, env.Sha, env.Nodes, env.TargetLanguage)
	if gerr != nil {
		log.Printf("[ingest-body] %v", gerr)
		env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		return nil, false, gerr
	}
	if !built {
		log.Printf("[ingest-body] code repo no modules built for %s/%s", env.Job.Owner, env.Job.Repo)
		return nil, false, fmt.Errorf("code repo no modules built for %s/%s", env.Job.Owner, env.Job.Repo)
	}
	plan := buildCodeRepoPlan(snapshots, env.Nodes, env.Patterns, env.Job.Owner, env.Job.Repo, env.TargetLanguage)
	return plan, true, nil
}

// 4.5 规则树兜底（text 口径）
type ruleTreeFallbackStep struct{}

func (s *ruleTreeFallbackStep) Name() string { return "ruleTreeFallback" }

func (s *ruleTreeFallbackStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	ruleTree := env.Patterns.BuildNavTree(env.TextNodes, env.Job.Owner, env.Job.Repo, "")
	if len(ruleTree) == 0 {
		return nil, false, fmt.Errorf("empty rule tree for %s/%s", env.Job.Owner, env.Job.Repo)
	}
	return planFromRuleTree(ruleTree), true, nil
}

// DefaultChapterPlanLadder 构建标准 8 级证据阶梯责任链
func DefaultChapterPlanLadder() *ChapterPlanLadder {
	return NewChapterPlanLadder(
		&customOutlineCodeStep{},
		&customOutlineTextStep{},
		&draftOutlineStep{},
		&draftModulesCodeStep{},
		&draftModulesTextStep{},
		&textbookMapStep{},
		&rsgProjectionStep{},
		&ruleTreeFallbackStep{},
	)
}
