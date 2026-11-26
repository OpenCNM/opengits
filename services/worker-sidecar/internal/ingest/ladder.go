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
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

func snapshotsFromCustomOutline(categories []CustomOutlineCategory, activeModuleNames []string, nodes []GitNode) []ModuleSnapshot {
	scopeBlobSet := make(map[string]bool, len(nodes))
	for _, n := range nodes {
		if n.Type == "blob" {
			scopeBlobSet[n.Path] = true
		}
	}
	return buildSnapshotsFromCustomOutline(categories, activeModuleNames, scopeBlobSet)
}

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

// Reorder snapshots by dependency-graph phase (0.25 entry mass threshold) so teaching order follows call topology.
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

// Enrich customOutline/draft snapshots with cognitive metadata while preserving user-defined chapter order.
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

// Build RSG lazily only when higher-authority steps yield no chapters to avoid wasted tree-sitter work.
func ladderRSGProjection(ctx context.Context, cfg Config, deps IngestBodyDeps, job JobRow, sha string, nodes []GitNode, targetLanguage string) ([]ModuleSnapshot, bool, error) {
	artifact, err := buildGraphArtifact(ctx, cfg, deps, job, sha, nodes)
	if err != nil {
		return nil, false, err
	}

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

func assembleTextPlan(chapters []ChapterInput, navTree []*NavNode, draftContent DraftOutlineContent) *ChapterPlan {
	draft := OutlineDraft{Parts: []OutlinePart{}, Chapters: []StoredOutlineChapter{}}
	derivedTree := make([]*NavNode, 0, len(chapters))
	// Match draft summaries by title rather than index because empty chapters are pruned and indices shift.
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
	applyOutlineParts(&draft, chapters, navTree, providedTree)
	return &ChapterPlan{Chapters: chapters, NavTree: navTree, Draft: draft}
}

func applyOutlineParts(draft *OutlineDraft, chapters []ChapterInput, navTree []*NavNode, providedTree bool) {
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

type EvidenceLadderStep interface {
	Name() string
	Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error)
}

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
		if payload, ok := client.FormatGatewaySSEErrorPayload("语义图谱构建失败：", gerr); ok {
			env.Deps.emit("error", payload)
		} else {
			env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		}
		return nil, false, gerr
	}
	return plan, true, nil
}

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
		if payload, ok := client.FormatGatewaySSEErrorPayload("语义图谱构建失败：", gerr); ok {
			env.Deps.emit("error", payload)
		} else {
			env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		}
		return nil, false, gerr
	}
	return plan, true, nil
}

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

type rsgProjectionStep struct{}

func (s *rsgProjectionStep) Name() string { return "rsgProjection" }

func (s *rsgProjectionStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	if !env.CodeRepo {
		return nil, false, nil
	}
	snapshots, built, gerr := ladderRSGProjection(ctx, env.Cfg, env.Deps, env.Job, env.Sha, env.Nodes, env.TargetLanguage)
	if gerr != nil {
		log.Printf("[ingest-body] %v", gerr)
		if payload, ok := client.FormatGatewaySSEErrorPayload("语义图谱构建失败：", gerr); ok {
			env.Deps.emit("error", payload)
		} else {
			env.Deps.emit("error", map[string]any{"message": "语义图谱构建失败，任务终止（Fail-Closed），请重试或反馈"})
		}
		return nil, false, gerr
	}
	if !built {
		log.Printf("[ingest-body] code repo no modules built for %s/%s", env.Job.Owner, env.Job.Repo)
		return nil, false, fmt.Errorf("code repo no modules built for %s/%s", env.Job.Owner, env.Job.Repo)
	}
	plan := buildCodeRepoPlan(snapshots, env.Nodes, env.Patterns, env.Job.Owner, env.Job.Repo, env.TargetLanguage)
	return plan, true, nil
}

type ruleTreeFallbackStep struct{}

func (s *ruleTreeFallbackStep) Name() string { return "ruleTreeFallback" }

func (s *ruleTreeFallbackStep) Evaluate(ctx context.Context, env *IngestContext) (*ChapterPlan, bool, error) {
	ruleTree := env.Patterns.BuildNavTree(env.TextNodes, env.Job.Owner, env.Job.Repo, "")
	if len(ruleTree) == 0 {
		return nil, false, fmt.Errorf("empty rule tree for %s/%s", env.Job.Owner, env.Job.Repo)
	}
	return planFromRuleTree(ruleTree), true, nil
}

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
