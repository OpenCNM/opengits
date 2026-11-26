package jobs

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var (
	setStatusRe   = regexp.MustCompile(`SET\s+"?status"?\s*=\s*'([A-Z]+)'`)
	whereStatusRe = regexp.MustCompile(`(?:WHERE|AND)\s+(?:\w+\.)?"?status"?\s*=\s*'([A-Z]+)'`)
)

func goSources(t *testing.T) map[string]string {
	t.Helper()
	roots := []string{".", "..", filepath.Join("..", "..")}
	var base string
	for _, r := range roots {
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
		if err != nil || info.IsDir() {
			if info != nil && info.IsDir() && (info.Name() == "testdata" || info.Name() == "vendor") {
				return filepath.SkipDir
			}
			return err
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

func TestImportJobTransitionsInSQLConformToTable(t *testing.T) {
	sources := goSources(t)
	checked := 0
	for rel, src := range sources {
		for _, chunk := range strings.Split(src, `UPDATE "ImportJob"`) {
			if strings.HasSuffix(rel, "states_test.go") || len(chunk) == len(src) {
				if len(chunk) == len(src) {
					continue
				}
			}
			if bt := strings.IndexByte(chunk, '`'); bt >= 0 {
				chunk = chunk[:bt]
			}
			setMatch := setStatusRe.FindStringSubmatch(chunk)
			if setMatch == nil {
				continue
			}
			target := ImportJobStatus(setMatch[1])
			guards := whereStatusRe.FindAllStringSubmatch(chunk, -1)
			if len(guards) == 0 {
				t.Errorf("%s: UPDATE \"ImportJob\" → %s 无 status 守卫（必须 CAS）", rel, target)
				continue
			}
			for _, g := range guards {
				from := ImportJobStatus(g[1])
				checked++
				if !CanTransition(from, target) {
					t.Errorf("%s: 非法迁移 %s → %s（不在 states.go 迁移表）", rel, from, target)
				}
			}
		}
	}
	if checked == 0 {
		t.Fatal("对拍抽取到 0 条迁移——抽取器失效（检查正则与 SQL 形态）")
	}
	t.Logf("conformance: %d 条 SQL 迁移全部对拍", checked)
}

func TestImportJobUpdateSingleWriterBoundary(t *testing.T) {
	sources := goSources(t)
	for rel, src := range sources {
		if strings.Contains(src, `UPDATE "ImportJob"`) && !strings.HasPrefix(rel, filepath.Join("internal", "jobs")) {
			t.Errorf("%s: ImportJob 的 UPDATE 越出 internal/jobs 单写者边界（迁移表与写者契约见 states.go）", rel)
		}
	}
}

func TestTerminalSetMatchesTable(t *testing.T) {
	got := map[ImportJobStatus]bool{}
	for _, s := range TerminalStates() {
		got[s] = true
	}
	want := map[ImportJobStatus]bool{StatusCompleted: true, StatusFailed: true}
	if len(got) != len(want) {
		t.Fatalf("TerminalStates() = %v, want %v", got, want)
	}
	for s := range want {
		if !got[s] {
			t.Errorf("TerminalStates() 缺少终态 %s", s)
		}
	}
	for _, s := range []ImportJobStatus{StatusQueued, StatusRunning} {
		if IsTerminal(s) {
			t.Errorf("%s 不应为终态", s)
		}
	}
}

func TestTSStatusEnumSync(t *testing.T) {
	candidates := []string{
		filepath.Join("..", "..", "..", "..", "apps", "client", "src", "lib", "schemas", "import-job.ts"),
		filepath.Join("..", "..", "apps", "client", "src", "lib", "schemas", "import-job.ts"),
	}
	var src string
	for _, c := range candidates {
		if data, err := os.ReadFile(c); err == nil {
			src = string(data)
			break
		}
	}
	if src == "" {
		t.Skip("TS schema 源不可达（目录布局变化时更新候选路径）")
	}
	enumBlock := regexp.MustCompile(`IMPORT_JOB_STATUS\s*=\s*\{([^}]*)\}`).FindStringSubmatch(src)
	if enumBlock == nil {
		t.Fatal("import-job.ts 中未找到 IMPORT_JOB_STATUS 枚举块")
	}
	tsStates := map[string]bool{}
	for _, m := range regexp.MustCompile(`([A-Z_]+):\s*'[A-Z]+'`).FindAllStringSubmatch(enumBlock[1], -1) {
		tsStates[m[1]] = true
	}
	goStates := map[string]bool{
		string(StatusQueued): true, string(StatusRunning): true,
		string(StatusCompleted): true, string(StatusFailed): true,
	}
	if len(tsStates) != len(goStates) {
		t.Fatalf("TS 状态数 %d ≠ Go 状态数 %d（%v vs %v）", len(tsStates), len(goStates), tsStates, goStates)
	}
	for s := range goStates {
		if !tsStates[s] {
			t.Errorf("TS IMPORT_JOB_STATUS 缺少 %s（schema 三层同步破坏）", s)
		}
	}
}
