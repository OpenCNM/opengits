package market

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// ─────────────────────────────────────────────────────────────
// ChapterUpdateJob 状态机一致性守卫（静态对拍，无 DB 依赖）：
// 1. 全仓 `UPDATE "ChapterUpdateJob"` 的 (guard→target) 必须命中 states.go 表；
// 2. 写者边界：UPDATE 仅允许出现在 internal/market 与 internal/update；
// 3. TS 枚举（CHAPTER_UPDATE_JOB_STATUS）与 Go 状态全集逐字同步。
// Node 侧 Prisma 迁移（updateMany where.status）暂无静态对拍——迁移表
// 头注即契约，TS 侧新迁移需同步登记。
// ─────────────────────────────────────────────────────────────

var (
	cujSetStatusRe   = regexp.MustCompile(`SET\s+"?status"?\s*=\s*'([A-Z]+)'`)
	cujWhereStatusRe = regexp.MustCompile(`(?:WHERE|AND)\s+(?:\w+\.)?"?status"?\s*=\s*'([A-Z]+)'`)
)

func cujGoSources(t *testing.T) map[string]string {
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

func TestChapterUpdateJobTransitionsConform(t *testing.T) {
	sources := cujGoSources(t)
	checked := 0
	for rel, src := range sources {
		if strings.HasSuffix(rel, "states_test.go") {
			continue
		}
		for _, chunk := range strings.Split(src, `UPDATE "ChapterUpdateJob"`) {
			if len(chunk) == len(src) {
				continue // 非 UPDATE 片段
			}
			// 语句边界截断（同 jobs/transcription 守卫配方）
			if bt := strings.IndexByte(chunk, '`'); bt >= 0 {
				chunk = chunk[:bt]
			}
			setMatch := cujSetStatusRe.FindStringSubmatch(chunk)
			if setMatch == nil {
				continue
			}
			target := ChapterUpdateJobStatus(setMatch[1])
			guards := cujWhereStatusRe.FindAllStringSubmatch(chunk, -1)
			if len(guards) == 0 {
				t.Errorf("%s: UPDATE \"ChapterUpdateJob\" → %s 无 status 守卫（必须 CAS）", rel, target)
				continue
			}
			for _, g := range guards {
				from := ChapterUpdateJobStatus(g[1])
				checked++
				if !CanTransition(from, target) {
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

func TestChapterUpdateJobWriterBoundary(t *testing.T) {
	sources := cujGoSources(t)
	for rel, src := range sources {
		if !strings.Contains(src, `UPDATE "ChapterUpdateJob"`) {
			continue
		}
		if strings.HasPrefix(rel, filepath.Join("internal", "market")) ||
			strings.HasPrefix(rel, filepath.Join("internal", "update")) {
			continue
		}
		t.Errorf("%s: ChapterUpdateJob 的 UPDATE 越出 internal/{market,update} 登记边界", rel)
	}
}

func TestChapterUpdateJobTSStatusEnumSync(t *testing.T) {
	candidates := []string{
		filepath.Join("..", "..", "..", "..", "apps", "client", "src", "lib", "schemas", "update-job.ts"),
		filepath.Join("..", "..", "apps", "client", "src", "lib", "schemas", "update-job.ts"),
	}
	var src string
	for _, c := range candidates {
		if data, err := os.ReadFile(c); err == nil {
			src = string(data)
			break
		}
	}
	if src == "" {
		t.Skip("TS schema 源不可达")
	}
	enumBlock := regexp.MustCompile(`CHAPTER_UPDATE_JOB_STATUS\s*=\s*\{([^}]*)\}`).FindStringSubmatch(src)
	if enumBlock == nil {
		t.Fatal("update-job.ts 中未找到 CHAPTER_UPDATE_JOB_STATUS 枚举块")
	}
	tsStates := map[string]bool{}
	for _, m := range regexp.MustCompile(`([A-Z_]+):\s*'[A-Z]+'`).FindAllStringSubmatch(enumBlock[1], -1) {
		tsStates[m[1]] = true
	}
	goStates := map[string]bool{
		string(MarketStatusPending): true, string(MarketStatusClaimed): true,
		string(MarketStatusTrial): true, string(MarketStatusSwapped): true,
		string(MarketStatusRejected): true, string(MarketStatusFailed): true,
		string(MarketStatusCancelled): true,
	}
	if len(tsStates) != len(goStates) {
		t.Fatalf("TS 状态数 %d ≠ Go 状态数 %d（%v vs %v）", len(tsStates), len(goStates), tsStates, goStates)
	}
	for s := range goStates {
		if !tsStates[s] {
			t.Errorf("TS CHAPTER_UPDATE_JOB_STATUS 缺少 %s（schema 三层同步破坏）", s)
		}
	}
}

func TestChapterUpdateJobTerminalStates(t *testing.T) {
	for _, s := range []ChapterUpdateJobStatus{MarketStatusPending, MarketStatusClaimed, MarketStatusTrial} {
		if IsTerminal(s) {
			t.Errorf("%s 不应为终态", s)
		}
	}
	for _, s := range []ChapterUpdateJobStatus{MarketStatusSwapped, MarketStatusRejected, MarketStatusFailed} {
		if !IsTerminal(s) {
			t.Errorf("%s 应为终态", s)
		}
	}
}
