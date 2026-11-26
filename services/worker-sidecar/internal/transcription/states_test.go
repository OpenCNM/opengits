package transcription

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	tjUpdateRe      = regexp.MustCompile(`(?i)UPDATE\s+"TranscriptionJob"`)
	tjSetStatusRe   = regexp.MustCompile(`SET\s+"?status"?\s*=\s*'([A-Z]+)'`)
	tjWhereStatusRe = regexp.MustCompile(`(?:WHERE|AND)\s+(?:"?\w+"?\.)?"?status"?\s*=\s*(?:'([A-Z]+)'|(@from_status::text))`)
)

func tjModuleRoot(t *testing.T) string {
	t.Helper()
	for _, r := range []string{".", "..", filepath.Join("..", "..")} {
		if _, err := os.Stat(filepath.Join(r, "go.mod")); err == nil {
			return r
		}
	}
	t.Fatal("cannot locate worker-sidecar module root")
	return ""
}

func tjGoSources(t *testing.T) map[string]string {
	t.Helper()
	base := tjModuleRoot(t)
	out := map[string]string{}
	err := filepath.Walk(base, func(path string, info os.FileInfo, err error) error {
		if err != nil || info == nil {
			return err
		}
		if info.IsDir() {
			if info.Name() == "testdata" || info.Name() == "vendor" {
				return filepath.SkipDir
			}
			return nil
		}
		if strings.HasSuffix(path, ".go") && !strings.HasSuffix(path, "_test.go") {
			data, rerr := os.ReadFile(path)
			if rerr != nil {
				return rerr
			}
			rel, _ := filepath.Rel(base, path)
			out[rel] = string(data)
			return nil
		}
		return nil
	})
	if err != nil {
		t.Fatalf("walk sources: %v", err)
	}
	return out
}

func TestTranscriptionJobTransitionsConform(t *testing.T) {
	base := tjModuleRoot(t)
	sources := tjGoSources(t)
	sqlBytes, err := os.ReadFile(filepath.Join(base, "queries", "transcription.sql"))
	if err != nil {
		t.Fatalf("read queries/transcription.sql: %v", err)
	}
	sources[filepath.Join("queries", "transcription.sql")] = string(sqlBytes)

	checked := 0
	for rel, src := range sources {
		if strings.HasSuffix(rel, "states_test.go") || strings.HasPrefix(rel, filepath.Join("internal", "platform", "db")) {
			continue
		}
		locs := tjUpdateRe.FindAllStringIndex(src, -1)
		for idx, loc := range locs {
			end := len(src)
			if idx+1 < len(locs) {
				end = locs[idx+1][0]
			}
			chunk := src[loc[1]:end]
			if semi := strings.Index(chunk, ";"); semi >= 0 {
				chunk = chunk[:semi]
			}
			if bt := strings.IndexByte(chunk, '`'); bt >= 0 {
				chunk = chunk[:bt]
			}
			setMatch := tjSetStatusRe.FindStringSubmatch(chunk)
			if setMatch == nil {
				continue
			}
			target := TranscriptionJobStatus(setMatch[1])
			guards := tjWhereStatusRe.FindAllStringSubmatch(chunk, -1)
			if len(guards) == 0 {
				t.Errorf("%s: UPDATE \"TranscriptionJob\" → %s 无 status 守卫（必须 CAS，防 reap/重认领竞态覆盖）", rel, target)
				continue
			}
			for _, g := range guards {
				if g[2] == "@from_status::text" {
					checked++
					continue
				}
				from := TranscriptionJobStatus(g[1])
				checked++
				if !CanTranscribeTransition(from, target) {
					t.Errorf("%s: 非法迁移 %s → %s（不在 states.go 迁移表）", rel, from, target)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("对拍抽取到 0 条迁移——抽取器失效")
	}
	t.Logf("conformance: %d 条 SQL 迁移全部对拍", checked)
}

func TestTranscriptionJobWriterBoundary(t *testing.T) {
	for rel, src := range tjGoSources(t) {
		if strings.HasPrefix(rel, filepath.Join("internal", "platform", "db")) {
			continue
		}
		if tjUpdateRe.MatchString(src) &&
			!strings.HasPrefix(rel, filepath.Join("internal", "transcription")) {
			t.Errorf("%s: TranscriptionJob 的 UPDATE 越出 internal/transcription 边界", rel)
		}
	}
}

func TestTranscriptionSettledSemantics(t *testing.T) {
	if IsTranscriptionSettled(TStatusQueued) || IsTranscriptionSettled(TStatusRunning) {
		t.Error("QUEUED/RUNNING 不应为稳态")
	}
	if !IsTranscriptionSettled(TStatusDone) || !IsTranscriptionSettled(TStatusFailed) {
		t.Error("DONE/FAILED 应为稳态")
	}
	if !CanTranscribeTransition(TStatusDone, TStatusQueued) || !CanTranscribeTransition(TStatusFailed, TStatusQueued) {
		t.Error("DONE/FAILED 必须保留重开边")
	}
}
