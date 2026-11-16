package transcription

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/opengits/worker-sidecar/internal/chapter"
	"github.com/opengits/worker-sidecar/internal/doc"
	"github.com/opengits/worker-sidecar/internal/platform/db"
)

// ─────────────────────────────────────────────────────────────
// 市场接力转录（RELAY，首译开荒）：Go staged 无锁变体（2026-10 下沉）。
//
// 契约三件套闭环：① 输入信封=网关 structured purpose relay_transcription
// （schema 校验单一事实源在 web lib/schemas/relay-contract.ts）；② 结构化
// 生成经网关 BYOK 解析（keyOrigin=user，认领者烧自己的 key，与原 Node
// generateStructured 直连语义等价）；③ 编译器与 L0-R 对源硬门为本包
// Go 镜像（relay_contract.go，与 TS 测试互为对拍）。
// 术语表=仓内正典概念（updatedAt 序去重），镜像 buildRepositoryConceptTaxonomy
// 的名字列表语义。无锁零落库，产物交市场引擎直换收敛尾。
// ─────────────────────────────────────────────────────────────

// StagedRelayResult 接力暂存产物。
type StagedRelayResult struct {
	Mdx   string `json:"mdx"`
	Model string `json:"model"`
}

// RelayTaxonomyStore 术语表能力（可选注入：单测 fake 不实现即空表继续，
// 与 Node 版"图谱不可用不阻断"同语义）。
type RelayTaxonomyStore interface {
	// ListRecentCanonicalConcepts 仓内正典概念名（updatedAt 序、按 canonicalKey
	// 去重、代表变体优先 conceptName==canonicalName，上限 take）。
	ListRecentCanonicalConcepts(ctx context.Context, repositoryId string, take int) ([]string, error)
}

// relayGlossaryLimit 术语表上限（对齐 Node buildRepositoryConceptTaxonomy 默认 50）。
const relayGlossaryLimit = 50

// relayGlossarySection 信封术语表段（逐字对齐 buildRelayEnvelopePrompt 拼装）。
func relayGlossarySection(glossary []string) string {
	if len(glossary) == 0 {
		return "全书术语表暂空：新术语请在 conceptAnchors 中登记你的译法。"
	}
	lines := make([]string, 0, len(glossary))
	for _, t := range glossary {
		lines = append(lines, "- "+t)
	}
	return "全书术语表（译法必须与此一致，未收录术语请给出统一译法并列进 conceptAnchors）：\n" + strings.Join(lines, "\n")
}

// RunStagedRelayBody 接力转录暂存生成（无锁、零文档落库）。Fail-Closed：
// 生成/解析/硬门任一失败显式报错（市场任务置 FAILED，积分隐式退还）。
func RunStagedRelayBody(ctx context.Context, cfg Config, deps BodyDeps, documentId, userId, sourceSha, modelOverride string) (*StagedRelayResult, error) {
	if deps.PrepareFunc == nil {
		return nil, errors.New("staged-relay: prepare executor not configured")
	}
	if deps.Llm == nil {
		return nil, errors.New("staged-relay: llm gateway client not configured")
	}
	if strings.TrimSpace(sourceSha) == "" {
		return nil, errors.New("staged-relay: sourceSha is required")
	}

	// 预算首帧闸（认领者 BYOK 豁免；平台路径预算不足第一帧拒绝）
	if bp, ok := deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, userId); err != nil {
			if isBudgetErr(err) {
				return nil, fmt.Errorf("staged-relay: budget exceeded for %s (defer later)", userId)
			}
			// 探测故障放行：权威闸在网关调用时
		}
	}

	// 文档行 + 模型解析链（ForceEnhance 绕过 noop/指纹门控——接力必生成）
	opts := doc.PrepareOptions{UserID: userId, ForceEnhance: true, Model: modelOverride}
	prep, err := deps.PrepareFunc(ctx, documentId, userId, opts)
	if err != nil {
		return nil, fmt.Errorf("staged-relay prepare failed: %w", err)
	}
	if prep.Outcome != "ready" {
		return nil, fmt.Errorf("staged-relay prepare unexpected outcome: %s", prep.Outcome)
	}

	// 源文：归档直读（sha 冻结 ref → branch 回退）；皆空 Fail-Closed。
	// relay 消费原文（无 sanitize/transform——契约硬门以源为基准）。
	raw := chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, sourceSha, prep.Doc.Path)
	if raw == "" && prep.Doc.Repository.Branch != "" && prep.Doc.Repository.Branch != sourceSha {
		raw = chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, prep.Doc.Repository.Branch, prep.Doc.Path)
	}
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("staged-relay: source file empty or archive missing for %s @ %s", prep.Doc.Path, sourceSha)
	}

	// 术语表（可选能力：缺失即空表继续——与 Node 版同语义）
	glossary := []string{}
	if ts, ok := deps.Store.(RelayTaxonomyStore); ok && ts != nil && prep.Doc.RepositoryID != "" {
		if names, err := ts.ListRecentCanonicalConcepts(ctx, prep.Doc.RepositoryID, relayGlossaryLimit); err == nil {
			glossary = names
		}
	}

	targetLang := "中文"
	if v := derefStrPtr(prep.Effective.TargetLanguage); v != "" && v != "none" {
		targetLang = v
	}

	vars := map[string]any{
		"targetLanguage":  targetLang,
		"path":            prep.Doc.Path,
		"glossarySection": relayGlossarySection(glossary),
		"sourceRaw":       raw,
	}
	uid := userId
	gen, okGen := deps.Llm.(interface {
		Generate(ctx context.Context, purpose string, variables map[string]any, userId *string, out any) error
	})
	if !okGen {
		return nil, errors.New("staged-relay: llm client lacks structured Generate capability")
	}
	var obj RelayTranscription
	if err := gen.Generate(ctx, "relay_transcription", vars, &uid, &obj); err != nil {
		return nil, fmt.Errorf("staged-relay generation failed: %w", err)
	}

	mdx := compileRelayMdx(obj)
	if gate := relayGate(relayGateFromEnv(), mdx, raw); !gate.Passed {
		return nil, fmt.Errorf("L0-R 对源硬门未过：%s", gate.Reason)
	}
	return &StagedRelayResult{Mdx: mdx, Model: prep.Model}, nil
}

// ListRecentCanonicalConcepts PgxStore 实现：镜像 buildRepositoryConceptTaxonomy
// 的名字列表语义（多取 4 倍行 → canonicalKey 去重，代表=conceptName==canonicalName
// 优先 → 截断 take）。
func (s *PgxStore) ListRecentCanonicalConcepts(ctx context.Context, repositoryId string, take int) ([]string, error) {
	if s == nil || s.pool == nil || repositoryId == "" || take <= 0 {
		return nil, nil
	}
	rows, err := s.queries.ListRecentCanonicalConcepts(ctx, db.ListRecentCanonicalConceptsParams{
		RepositoryId: repositoryId,
		Limit:        int32(take * 4),
	})
	if err != nil {
		return nil, err
	}
	text := func(v pgtype.Text) string {
		if v.Valid {
			return v.String
		}
		return ""
	}
	seen := map[string]bool{}
	var out []string
	for _, r := range rows {
		canonKey := text(r.CanonicalKey)
		key := canonKey
		if strings.TrimSpace(key) == "" {
			key = "raw:" + r.ConceptName
		}
		if seen[key] {
			continue
		}
		seen[key] = true
		// 代表变体：conceptName == canonicalName 的行（updatedAt 序首个）
		name := r.ConceptName
		if canon := text(r.CanonicalName); canon != "" && canon != name {
			for _, m := range rows {
				if text(m.CanonicalKey) == canonKey && m.ConceptName == canon {
					name = m.ConceptName
					break
				}
			}
		}
		out = append(out, name)
		if len(out) >= take {
			break
		}
	}
	return out, nil
}
