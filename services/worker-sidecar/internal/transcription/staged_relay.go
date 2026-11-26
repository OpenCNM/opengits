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

type StagedRelayResult struct {
	Mdx   string `json:"mdx"`
	Model string `json:"model"`
}

type RelayTaxonomyStore interface {
	ListRecentCanonicalConcepts(ctx context.Context, repositoryId string, take int) ([]string, error)
}

const relayGlossaryLimit = 50

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

	if bp, ok := deps.Store.(BudgetProbeStore); ok && bp != nil {
		if err := bp.CheckLlmBudget(ctx, userId); err != nil {
			if isBudgetErr(err) {
				return nil, fmt.Errorf("staged-relay: budget exceeded for %s (defer later)", userId)
			}
		}
	}

	opts := doc.PrepareOptions{UserID: userId, ForceEnhance: true, Model: modelOverride}
	prep, err := deps.PrepareFunc(ctx, documentId, userId, opts)
	if err != nil {
		return nil, fmt.Errorf("staged-relay prepare failed: %w", err)
	}
	if prep.Outcome != "ready" {
		return nil, fmt.Errorf("staged-relay prepare unexpected outcome: %s", prep.Outcome)
	}

	// Consumes raw source without sanitize/transform so the L0-R relay gate validates against unmodified source.
	raw := chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, sourceSha, prep.Doc.Path)
	if raw == "" && prep.Doc.Repository.Branch != "" && prep.Doc.Repository.Branch != sourceSha {
		raw = chapter.ReadLocalArchiveFile(cfg.ArchiveRoot, prep.Doc.Repository.Owner, prep.Doc.Repository.Repo, prep.Doc.Repository.Branch, prep.Doc.Path)
	}
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("staged-relay: source file empty or archive missing for %s @ %s", prep.Doc.Path, sourceSha)
	}

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
