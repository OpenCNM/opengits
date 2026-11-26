package cognitive

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sort"
	"strings"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opengits/worker-sidecar/internal/platform/db"
)

const maxDecompressedGraphBytes = 64 << 20 // 64MB decompression cap guards against gzip bomb OOM.

type GraphArtifactRepo interface {
	LoadArtifact(ctx context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error)
	SaveArtifact(ctx context.Context, owner, repo, sha string, artifact *SemanticGraphArtifact) error
}

type IncrementalGraphRepo interface {
	GraphArtifactRepo
	MergeFileSymbols(ctx context.Context, owner, repo, sha string, fileSymbols map[string][]SymbolEntry) (*SemanticGraphArtifact, error)
}

func MergeSymbolsIntoArtifact(base *SemanticGraphArtifact, sha string, fileSymbols map[string][]SymbolEntry) (*SemanticGraphArtifact, bool) {
	if len(fileSymbols) == 0 {
		return base, false
	}
	paths := make([]string, 0, len(fileSymbols))
	for p, syms := range fileSymbols {
		if strings.TrimSpace(p) != "" && len(syms) > 0 {
			paths = append(paths, p)
		}
	}
	if len(paths) == 0 {
		return base, false
	}
	sort.Strings(paths)

	if base == nil {
		base = &SemanticGraphArtifact{
			Version:       2,
			GitSha:        sha,
			Nodes:         []SemanticGraphArtifactNode{},
			Edges:         []SemanticGraphEdge{},
			SymbolsByFile: make(map[string][]SymbolEntry),
		}
	} else if base.SymbolsByFile == nil {
		base.SymbolsByFile = make(map[string][]SymbolEntry)
	}

	nodeSet := make(map[string]bool, len(base.Nodes))
	for _, n := range base.Nodes {
		if n.Path != "" {
			nodeSet[n.Path] = true
		}
	}

	changed := false
	for _, path := range paths {
		syms := fileSymbols[path]
		if existing, ok := base.SymbolsByFile[path]; !ok || len(existing) == 0 {
			base.SymbolsByFile[path] = syms
			changed = true
		}
		if !nodeSet[path] {
			nodeSet[path] = true
			base.Nodes = append(base.Nodes, SemanticGraphArtifactNode{
				Path:     path,
				Role:     RoleLeafUtility,
				PageRank: 0.01,
			})
			changed = true
		}
	}
	return base, changed
}

func EncodeArtifactPayload(artifact *SemanticGraphArtifact) ([]byte, int, error) {
	if artifact == nil {
		return nil, 0, errors.New("artifact is nil")
	}
	v3Bytes, err := encodeSegmentedV3(artifact)
	if err != nil {
		return nil, 0, fmt.Errorf("encode segmented v3: %w", err)
	}
	var buf bytes.Buffer
	gw := gzip.NewWriter(&buf)
	if _, err := gw.Write(v3Bytes); err != nil {
		_ = gw.Close()
		return nil, 0, fmt.Errorf("gzip write artifact: %w", err)
	}
	if err := gw.Close(); err != nil {
		return nil, 0, fmt.Errorf("gzip close artifact: %w", err)
	}
	symbolCount := 0
	for _, list := range artifact.SymbolsByFile {
		symbolCount += len(list)
	}
	if symbolCount == 0 {
		symbolCount = len(artifact.GoldenSymbols)
	}
	return buf.Bytes(), symbolCount, nil
}

func DecodeArtifactPayload(raw []byte) (*SemanticGraphArtifact, error) {
	if len(raw) == 0 {
		return nil, errors.New("empty artifact payload")
	}
	data := raw
	if len(raw) >= 2 && raw[0] == 0x1f && raw[1] == 0x8b {
		gr, err := gzip.NewReader(bytes.NewReader(raw))
		if err != nil {
			return nil, fmt.Errorf("gzip open artifact: %w", err)
		}
		defer gr.Close()
		decompressed, err := io.ReadAll(io.LimitReader(gr, maxDecompressedGraphBytes+1))
		if err != nil {
			return nil, fmt.Errorf("gzip read artifact: %w", err)
		}
		if len(decompressed) > maxDecompressedGraphBytes {
			return nil, fmt.Errorf("decompressed artifact exceeds limit (%d bytes)", maxDecompressedGraphBytes)
		}
		data = decompressed
	}
	if isSegmentedV3(data) {
		return decodeSegmentedV3(data)
	}
	return nil, errors.New("unsupported persisted semantic graph payload format")
}

type PgGraphStore struct {
	pool    *pgxpool.Pool
	mergeMu sync.Mutex
}

// Returns nil when pool is nil to allow DB-less mode degradation.
func NewPgGraphStore(pool *pgxpool.Pool) *PgGraphStore {
	if pool == nil {
		return nil
	}
	return &PgGraphStore{pool: pool}
}

func normalizeGraphKey(owner, repo, sha string) (string, string, string) {
	return strings.ToLower(strings.TrimSpace(owner)),
		strings.ToLower(strings.TrimSpace(repo)),
		strings.ToLower(strings.TrimSpace(sha))
}

func newGraphRowID() string {
	var b [12]byte
	if _, err := rand.Read(b[:]); err == nil {
		return "rsg_" + hex.EncodeToString(b[:])
	}
	return "rsg_fallback"
}

func (s *PgGraphStore) LoadArtifact(ctx context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error) {
	if s == nil || s.pool == nil {
		return nil, nil
	}
	o, r, g := normalizeGraphKey(owner, repo, sha)
	if o == "" || r == "" || g == "" {
		return nil, nil
	}
	row, err := db.New(s.pool).GetRepoSemanticGraph(ctx, db.GetRepoSemanticGraphParams{
		Owner:  o,
		Repo:   r,
		GitSha: g,
	})
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return DecodeArtifactPayload(row.Payload)
}

func (s *PgGraphStore) SaveArtifact(ctx context.Context, owner, repo, sha string, artifact *SemanticGraphArtifact) error {
	if s == nil || s.pool == nil || artifact == nil {
		return nil
	}
	o, r, g := normalizeGraphKey(owner, repo, sha)
	if o == "" || r == "" || g == "" {
		return nil
	}
	payload, symbolCount, err := EncodeArtifactPayload(artifact)
	if err != nil {
		return err
	}
	return db.New(s.pool).UpsertRepoSemanticGraph(ctx, db.UpsertRepoSemanticGraphParams{
		ID:          newGraphRowID(),
		Owner:       o,
		Repo:        r,
		GitSha:      g,
		Payload:     payload,
		SymbolCount: int32(symbolCount),
	})
}

func (s *PgGraphStore) MergeFileSymbols(ctx context.Context, owner, repo, sha string, fileSymbols map[string][]SymbolEntry) (*SemanticGraphArtifact, error) {
	if s == nil || s.pool == nil || len(fileSymbols) == 0 {
		return nil, nil
	}
	o, r, g := normalizeGraphKey(owner, repo, sha)
	if o == "" || r == "" || g == "" {
		return nil, nil
	}

	s.mergeMu.Lock()
	defer s.mergeMu.Unlock()

	existing, err := s.LoadArtifact(ctx, o, r, g)
	if err != nil {
		return nil, err
	}
	merged, changed := MergeSymbolsIntoArtifact(existing, g, fileSymbols)
	if !changed || merged == nil {
		return merged, nil
	}
	if err := s.SaveArtifact(ctx, o, r, g, merged); err != nil {
		return nil, err
	}
	return merged, nil
}

func (s *PgGraphStore) LoadCuratedPaths(ctx context.Context, owner, repo string) ([]string, error) {
	if s == nil || s.pool == nil {
		return nil, nil
	}
	raw, err := db.New(s.pool).GetRepositoryCuratedProfile(ctx, db.GetRepositoryCuratedProfileParams{
		Owner: strings.TrimSpace(owner),
		Repo:  strings.TrimSpace(repo),
	})
	if errors.Is(err, pgx.ErrNoRows) || len(raw) == 0 {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var profile struct {
		CodeClusters []struct {
			Files []string `json:"files"`
		} `json:"codeClusters"`
	}
	if err := json.Unmarshal(raw, &profile); err != nil {
		return nil, err
	}
	seen := make(map[string]bool)
	var out []string
	for _, c := range profile.CodeClusters {
		for _, f := range c.Files {
			clean := strings.TrimSpace(f)
			if clean != "" && !seen[clean] {
				seen[clean] = true
				out = append(out, clean)
			}
		}
	}
	return out, nil
}
