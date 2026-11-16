package transcription

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────
// TranscriptionJob 状态机一致性守卫（静态对拍，无 DB 依赖）：
// 1. 全仓 UPDATE "TranscriptionJob" 迁移必须命中 states.go 表且带 status 守卫；
// 2. 写者边界：UPDATE 仅允许 internal/transcription；
// 3. TS 枚举同步。
// Node 侧 complete/fail 的 id-only 写（无 status 守卫）是登记在案的
// 同族竞态残留，见 states.go 头注。
// ─────────────────────────────────────────────────────────────

var (
	tjSetStatusRe   = regexp.MustCompile(`SET\s+"?status"?\s*=\s*'([A-Z]+)'`)
	tjWhereStatusRe = regexp.MustCompile(`(?:WHERE|AND)\s+(?:\w+\.)?"?status"?\s*=\s*'([A-Z]+)'`)
)

func tjGoSources(t *testing.T) map[string]string {
	t.Helper()
	var base string
	for _, r := range []string{".", "..", filepath.Join("..", "..")} {
		if _, err := os.Stat(filepath.Join(r, "go.mod")); err == nil {
			base = r
			break
		}
	}
	if base == "" {
		t.Fatal("cannot locate worker-sidecar module root")
	}
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
	sources := tjGoSources(t)
	checked := 0
	for rel, src := range sources {
		if strings.HasSuffix(rel, "states_test.go") {
			continue
		}
		for _, chunk := range strings.Split(src, `UPDATE "TranscriptionJob"`) {
			if len(chunk) == len(src) {
				continue
			}
			// 语句边界截断：chunk 延伸到下一条语句会把别人的 SET status 误算进来
			if semi := strings.Index(chunk, ";"); semi >= 0 {
				chunk = chunk[:semi]
			}
			if bt := strings.IndexByte(chunk, '`'); bt >= 0 {
				chunk = chunk[:bt]
			}
			setMatch := tjSetStatusRe.FindStringSubmatch(chunk)
			if setMatch == nil {
				continue // 非状态迁移（如仅 checkpoint 列）
			}
			target := TranscriptionJobStatus(setMatch[1])
			guards := tjWhereStatusRe.FindAllStringSubmatch(chunk, -1)
			if len(guards) == 0 {
				t.Errorf("%s: UPDATE \"TranscriptionJob\" → %s 无 status 守卫（必须 CAS，防 reap/重认领竞态覆盖）", rel, target)
				continue
			}
			for _, g := range guards {
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
		if strings.Contains(src, `UPDATE "TranscriptionJob"`) &&
			!strings.HasPrefix(rel, filepath.Join("internal", "transcription")) {
			t.Errorf("%s: TranscriptionJob 的 UPDATE 越出 internal/transcription 边界", rel)
		}
	}
}

// TestTranscriptionTSStatusEnumSync 已随 Node 消费循环退役删除（2026-10 收口）：
// 状态枚举的 TS 镜像（TRANSCRIPTION_JOB_STATUS）是消费循环遗留物，Go 现为
// TranscriptionJob 状态的唯一写者——跨语言枚举同步契约不复存在（见 states.go SSOT 表）。

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
