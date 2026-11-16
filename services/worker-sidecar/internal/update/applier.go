package update

import (
	"context"
	"fmt"
	"strings"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

var mdExtStripRe = mdpat.MdExtRe

// MaxPlanItems defines the maximum allowed chapters in a single update plan.
const MaxPlanItems = 50

// UpdateCandidateSet alias for UpdateCandidateResponse, unifying terminology with TypeScript.
type UpdateCandidateSet = UpdateCandidateResponse

// UpdatePlanChapter represents a chapter operation in the update plan.
type UpdatePlanChapter struct {
	Path     string `json:"path"`
	Action   string `json:"action"` // "update" | "keep" | "remove" | "add"
	Reason   string `json:"reason,omitempty"`
	Title    string `json:"title,omitempty"`
	Position string `json:"position,omitempty"`
}

// UpdatePlan describes the set of chapter updates to apply.
type UpdatePlan struct {
	Chapters []UpdatePlanChapter `json:"chapters"`
	Summary  string              `json:"summary"`
}

// CoercedAction records a deterministic modification applied to the LLM draft.
type CoercedAction struct {
	Path       string `json:"path"`
	FromAction string `json:"fromAction"`
	ToAction   string `json:"toAction"` // "update" | "keep" | "remove" | "add" | "DROP"
	Reason     string `json:"reason"`
}

// CoercePlanResult holds the coerced plan and the list of adjustments made.
type CoercePlanResult struct {
	Plan    UpdatePlan      `json:"plan"`
	Coerced []CoercedAction `json:"coerced"`
}

// NavTreeAdd represents an added node with an optional anchor.
type NavTreeAdd struct {
	Node         *NavNode `json:"node"`
	PositionPath *string  `json:"positionPath,omitempty"`
}

// NavTreeRename represents an in-place rename operation on a NavNode.
type NavTreeRename struct {
	From  string `json:"from"`
	To    string `json:"to"`
	ToUrl string `json:"toUrl"`
}

// NavTreePatch describes structural modifications to apply to the navigation tree.
type NavTreePatch struct {
	Remove []string        `json:"remove"`
	Add    []NavTreeAdd    `json:"add"`
	Rename []NavTreeRename `json:"rename,omitempty"`
}

// UpdateApplyRequest input payload for POST /v1/update/apply.
type UpdateApplyRequest struct {
	RepositoryID   string             `json:"repositoryId"`
	UserID         string             `json:"userId"`
	DocOwnerID     *string            `json:"docOwnerId,omitempty"`
	FromSha        string             `json:"fromSha"`
	ToSha          string             `json:"toSha"`
	Plan           UpdatePlan         `json:"plan"`
	CandidateSet   UpdateCandidateSet `json:"candidateSet"`
	RunID          *string            `json:"runId,omitempty"`
	CurrentNavTree []*NavNode         `json:"currentNavTree,omitempty"`
}

// navNodeBaseName extracts the clean base filename without markdown extensions.
func navNodeBaseName(p string) string {
	parts := strings.Split(p, "/")
	base := parts[len(parts)-1]
	if base == "" {
		return p
	}
	base = mdExtStripRe.ReplaceAllString(base, "")
	if base == "" {
		return p
	}
	return base
}

// buildDocUrl constructs standard documentation path for nav nodes.
func buildDocUrl(path, owner, repo string) string {
	cleanPath := mdExtStripRe.ReplaceAllString(path, "")
	return fmt.Sprintf("/docs/%s/%s/%s", owner, repo, cleanPath)
}

// PlanValidationError indicates a client-correctable validation error (maps to HTTP 400).
type PlanValidationError struct {
	Message string
}

func (e *PlanValidationError) Error() string {
	return e.Message
}

// isGitTrueRemove verifies whether a remove action corresponds to upstream files truly disappearing.
// 1. Structural remove hit -> true remove.
// 2. Rename hit -> never a true remove (deterministic path migration).
// 3. Affected files non-empty and all change == "removed" -> true remove.
// isGitTrueRemove verifies whether a remove action corresponds to upstream files truly disappearing.
// 1. Rename hit -> never a true remove (deterministic path migration).
// 2. Structural remove hit -> true remove.
// 3. Affected files non-empty and all change == "removed" -> true remove.
func isGitTrueRemove(path string, candidateSet UpdateCandidateSet) bool {
	var cand *UpdateCandidateChapter
	for i := range candidateSet.Chapters {
		if candidateSet.Chapters[i].Path == path {
			cand = &candidateSet.Chapters[i]
			break
		}
	}
	if cand != nil && cand.Rename != nil {
		return false
	}
	for _, sr := range candidateSet.StructuralRemoves {
		if sr.Path == path {
			return true
		}
	}
	if cand == nil {
		return false
	}
	if len(cand.AffectedFiles) == 0 {
		return false
	}
	for _, f := range cand.AffectedFiles {
		if f.Change != "removed" {
			return false
		}
	}
	return true
}

// PlanActionSpecification 计划动作物理事实判定规约
type PlanActionSpecification interface {
	Evaluate(ch *UpdatePlanChapter, cand *UpdateCandidateChapter, candidateSet UpdateCandidateSet) (*CoercedAction, bool)
}

// renameDropSpecification 判定重命名是否由代码路径接管
type renameDropSpecification struct{}

func (s *renameDropSpecification) Evaluate(ch *UpdatePlanChapter, cand *UpdateCandidateChapter, _ UpdateCandidateSet) (*CoercedAction, bool) {
	if (cand != nil && cand.Rename != nil) || ch.Action == "rename" {
		return &CoercedAction{
			Path:       ch.Path,
			FromAction: ch.Action,
			ToAction:   "DROP",
			Reason:     "rename 由代码迁移路径，LLM 裁决被忽略",
		}, true
	}
	return nil, false
}

// removeFactCoerceSpecification 判定无 Git 物理事实删除时是否矫正为 update
type removeFactCoerceSpecification struct{}

func (s *removeFactCoerceSpecification) Evaluate(ch *UpdatePlanChapter, _ *UpdateCandidateChapter, candidateSet UpdateCandidateSet) (*CoercedAction, bool) {
	if ch.Action == "remove" && !isGitTrueRemove(ch.Path, candidateSet) {
		return &CoercedAction{
			Path:       ch.Path,
			FromAction: "remove",
			ToAction:   "update",
			Reason:     "remove 无 Git 事实支撑（源文件未全部删除），矫正为 update",
		}, true
	}
	return nil, false
}

var defaultCoercionSpecifications = []PlanActionSpecification{
	&renameDropSpecification{},
	&removeFactCoerceSpecification{},
}

// CoercePlanDraft 基于物理事实规约链纠偏非受信 LLM 计划草稿：
// 1. Rename 规约：具有 rename 事实或 action="rename" 判定为 DROP（代码迁移通道处理）。
// 2. Remove 规约：无 Git 物理事实删除（源文件未全部删除）矫正为 update。
func CoercePlanDraft(plan UpdatePlan, candidateSet UpdateCandidateSet) CoercePlanResult {
	coerced := make([]CoercedAction, 0)
	chapters := make([]UpdatePlanChapter, 0, len(plan.Chapters))

	candByPath := make(map[string]*UpdateCandidateChapter, len(candidateSet.Chapters))
	for i := range candidateSet.Chapters {
		candByPath[candidateSet.Chapters[i].Path] = &candidateSet.Chapters[i]
	}

	for _, ch := range plan.Chapters {
		cand := candByPath[ch.Path]
		dropped := false

		for _, spec := range defaultCoercionSpecifications {
			if action, matched := spec.Evaluate(&ch, cand, candidateSet); matched {
				coerced = append(coerced, *action)
				if action.ToAction == "DROP" {
					dropped = true
					break
				}
				if action.ToAction == "update" {
					ch.Action = "update"
				}
			}
		}

		if !dropped {
			chapters = append(chapters, ch)
		}
	}

	return CoercePlanResult{
		Plan: UpdatePlan{
			Chapters: chapters,
			Summary:  plan.Summary,
		},
		Coerced: coerced,
	}
}

// ValidatePlan checks guardrails: plan size limit, action enum, action targets within candidate set, legal add targets.
func ValidatePlan(plan UpdatePlan, candidateSet UpdateCandidateSet) error {
	if len(plan.Chapters) > MaxPlanItems {
		return &PlanValidationError{
			Message: fmt.Sprintf("更新计划章节数 %d 超过上限 %d，建议走强制全量重新导入", len(plan.Chapters), MaxPlanItems),
		}
	}

	allowedPaths := make(map[string]struct{}, len(candidateSet.Chapters))
	for _, c := range candidateSet.Chapters {
		allowedPaths[c.Path] = struct{}{}
	}

	allowedAddPaths := make(map[string]struct{})
	for _, f := range candidateSet.UnmatchedFiles {
		if f.Change == "added" {
			allowedAddPaths[f.Path] = struct{}{}
		}
	}
	for _, c := range candidateSet.StructuralAdds {
		allowedAddPaths[c.Path] = struct{}{}
	}

	for _, ch := range plan.Chapters {
		switch ch.Action {
		case "update", "keep", "remove":
			if _, inAllowed := allowedPaths[ch.Path]; !inAllowed {
				return &PlanValidationError{
					Message: fmt.Sprintf("%s 目标 %s 不在候选集内（越权）", ch.Action, ch.Path),
				}
			}
		case "add":
			_, inAllowed := allowedPaths[ch.Path]
			_, inAddAllowed := allowedAddPaths[ch.Path]
			if !inAllowed && !inAddAllowed {
				return &PlanValidationError{
					Message: fmt.Sprintf("add 目标 %s 不在候选集内（越权）", ch.Path),
				}
			}
		default:
			return &PlanValidationError{
				Message: fmt.Sprintf("非法章节动作 %s，仅支持 update/keep/remove/add", ch.Action),
			}
		}
	}

	return nil
}

// cloneNavNode deeply clones a single navigation node.
func cloneNavNode(n *NavNode) *NavNode {
	if n == nil {
		return nil
	}
	cp := *n
	if len(n.Children) > 0 {
		cp.Children = make([]*NavNode, len(n.Children))
		for i, c := range n.Children {
			cp.Children[i] = cloneNavNode(c)
		}
	}
	return &cp
}

// cloneNavTree deeply clones a navigation tree slice.
func cloneNavTree(nodes []*NavNode) []*NavNode {
	if nodes == nil {
		return nil
	}
	out := make([]*NavNode, len(nodes))
	for i, n := range nodes {
		out[i] = cloneNavNode(n)
	}
	return out
}

// removeByPath recursively removes nodes matching path.
func removeByPath(nodes []*NavNode, path string) []*NavNode {
	result := make([]*NavNode, 0, len(nodes))
	for _, node := range nodes {
		if node == nil || node.Path == path {
			continue
		}
		if len(node.Children) > 0 {
			node.Children = removeByPath(node.Children, path)
		}
		result = append(result, node)
	}
	return result
}

// renameByPath recursively updates path, url, and name for nodes matching from path.
func renameByPath(nodes []*NavNode, from, to, toUrl string) {
	for _, node := range nodes {
		if node == nil {
			continue
		}
		if node.Path == from {
			node.Path = to
			node.Url = toUrl
			node.Name = navNodeBaseName(to)
		}
		if len(node.Children) > 0 {
			renameByPath(node.Children, from, to, toUrl)
		}
	}
}

// insertAfter inserts node after anchorPath. Returns updated slice and true if found.
func insertAfter(nodes []*NavNode, anchorPath string, node *NavNode) ([]*NavNode, bool) {
	for i, current := range nodes {
		if current == nil {
			continue
		}
		if current.Path == anchorPath {
			res := make([]*NavNode, 0, len(nodes)+1)
			res = append(res, nodes[:i+1]...)
			res = append(res, node)
			res = append(res, nodes[i+1:]...)
			return res, true
		}
		if len(current.Children) > 0 {
			newChildren, ok := insertAfter(current.Children, anchorPath, node)
			if ok {
				current.Children = newChildren
				return nodes, true
			}
		}
	}
	return nodes, false
}

// PatchNavTree applies in-place structural changes (remove, rename, add) without reordering undisturbed nodes.
func PatchNavTree(navTree []*NavNode, patch NavTreePatch) []*NavNode {
	tree := cloneNavTree(navTree)

	for _, path := range patch.Remove {
		tree = removeByPath(tree, path)
	}

	for _, r := range patch.Rename {
		renameByPath(tree, r.From, r.To, r.ToUrl)
	}

	for _, item := range patch.Add {
		if item.PositionPath != nil && *item.PositionPath != "" {
			newTree, inserted := insertAfter(tree, *item.PositionPath, item.Node)
			if inserted {
				tree = newTree
			} else {
				tree = append(tree, item.Node)
			}
		} else {
			tree = append(tree, item.Node)
		}
	}

	return tree
}

// ApplyUpdatePlan coordinates draft coercion, validation, and direct storage transaction execution.
func ApplyUpdatePlan(ctx context.Context, cfg Config, store ApplierStore, req UpdateApplyRequest) (*ApplyUpdatePlanTxResult, error) {
	if store == nil {
		return nil, fmt.Errorf("update store is required")
	}

	// 1. Draft coercion (deterministic code takeover: drop renames, coerce ungrounded removes)
	coercedRes := CoercePlanDraft(req.Plan, req.CandidateSet)
	plan := coercedRes.Plan

	// 2. Guardrail validation on coerced plan
	if err := ValidatePlan(plan, req.CandidateSet); err != nil {
		return nil, err
	}

	// 3. Prepare parameters
	txParams := ApplyUpdatePlanTxParams{
		RepositoryID:   req.RepositoryID,
		UserID:         req.UserID,
		DocOwnerID:     req.DocOwnerID,
		FromSha:        req.FromSha,
		ToSha:          req.ToSha,
		Plan:           plan,
		CandidateSet:   req.CandidateSet,
		RunID:          req.RunID,
		CurrentNavTree: req.CurrentNavTree,
		CoercedCount:   len(coercedRes.Coerced),
	}

	// 4. Atomic transaction in database
	result, err := store.ApplyUpdatePlanTx(ctx, txParams)
	if err != nil {
		return nil, err
	}

	return result, nil
}
