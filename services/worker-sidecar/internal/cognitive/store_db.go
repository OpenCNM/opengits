package cognitive

import (
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/opengits/worker-sidecar/internal/platform/db"
)

const maxDecompressedGraphBytes = 64 << 20 // 64MB 上限，防异常压缩炸弹导致 OOM

// GraphArtifactRepo 定义语义图谱在持久化数据库中的单写者读写契约。
type GraphArtifactRepo interface {
	LoadArtifact(ctx context.Context, owner, repo, sha string) (*SemanticGraphArtifact, error)
	SaveArtifact(ctx context.Context, owner, repo, sha string, artifact *SemanticGraphArtifact) error
}

// EncodeArtifactPayload 将 SemanticGraphArtifact 编码为 gzip 压缩的 v3 分段容器字节流，并返回总符号数。
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

// DecodeArtifactPayload 解码持久化载荷（兼容 gzip 压缩的 v3 容器与未压缩的 v3/v2 容器）。
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

// PgGraphStore 基于 pgxpool 的 RepoSemanticGraph 持久化存取器。
type PgGraphStore struct {
	pool *pgxpool.Pool
}

// NewPgGraphStore 构建 PgGraphStore；pool 为 nil 时返回 nil（无 DB 模式降级）。
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
