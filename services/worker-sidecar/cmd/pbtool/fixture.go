// ─────────────────────────────────────────────────────────────
// Phase 1.2 合成 Fixture 收敛漏斗（-gen-fixture）。
//
// 防污染门禁（LLM 是外部高熵草稿源，落盘前必须过确定性闸门）：
//
//	LLM 起草拓扑 draft.json → 路径合法性/去重/树同构校验（本文件，纯确定性）
//	→ 合法者输出 []FileMap JSON 到 stdout（重定向至
//	  internal/cognitive/pipelineb/testdata/longtail/*.json 供表驱动回归消费）。
//
// 校验规则（与真实 Git Tree 同构）：
//   - 路径非空、无首尾/连续斜杠、禁绝对路径与 ".."/"." 段、禁反斜杠、长度封顶；
//   - 路径唯一（去重）；
//   - 无文件/目录同名冲突：任一路径不得同时是另一路径的目录前缀；
//   - BuildRepoTree round-trip：叶子数与输入一致（树构建无丢叶）。
//
// ─────────────────────────────────────────────────────────────
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
)

// fixtureDraft LLM 离线起草的仓库拓扑描述（输入，不受信任）。
type fixtureDraft struct {
	Name  string        `json:"name"`
	Files []fixtureFile `json:"files"`
}

type fixtureFile struct {
	Path     string `json:"path"`
	Loc      int    `json:"loc"`
	Lang     string `json:"lang"`
	IsDoc    bool   `json:"isDoc"`
	IsTest   bool   `json:"isTest"`
	IsConfig bool   `json:"isConfig"`
}

const (
	fixtureMaxFiles   = 150000 // 内存护栏：合成仓文件数封顶（真实 GitHub Tree >100k 即截断）
	fixtureMaxPathLen = 512
	fixtureMaxNameLen = 128
)

// genFixtureFile 收敛漏斗主入口：draft → 校验 → stdout。
func genFixtureFile(draftPath string) {
	raw, err := os.ReadFile(draftPath)
	fatalIf(err)
	var draft fixtureDraft
	if err := json.Unmarshal(raw, &draft); err != nil {
		fatalf("draft JSON 解析失败: %v", err)
	}
	files, err := validateFixtureDraft(&draft)
	if err != nil {
		fatalf("draft 未通过确定性校验闸门: %v", err)
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", " ")
	enc.SetEscapeHTML(false)
	_ = enc.Encode(map[string]any{
		"name":  draft.Name,
		"files": files,
	})
	fmt.Fprintf(os.Stderr, "[gen-fixture] %s: %d 个文件全部通过校验闸门\n", draft.Name, len(files))
}

// validateFixtureDraft 确定性校验闸门：全部通过返回按路径字典序排列的
// 规范文件列表（带 JSON tag，供落盘与测试加载器共用；BuildRepoTree 的
// 输入顺序契约）；任一违规返回首个错误。
func validateFixtureDraft(draft *fixtureDraft) ([]fixtureFile, error) {
	name := strings.TrimSpace(draft.Name)
	if name == "" || len(name) > fixtureMaxNameLen || strings.ContainsAny(name, "/\\") {
		return nil, fmt.Errorf("name 非法: %q（非空、<=128 字符、不含路径分隔符）", draft.Name)
	}
	if len(draft.Files) == 0 {
		return nil, fmt.Errorf("files 为空")
	}
	if len(draft.Files) > fixtureMaxFiles {
		return nil, fmt.Errorf("files 数 %d 超过封顶 %d", len(draft.Files), fixtureMaxFiles)
	}

	seen := make(map[string]bool, len(draft.Files))
	out := make([]fixtureFile, 0, len(draft.Files))
	for _, ff := range draft.Files {
		p := strings.TrimSpace(ff.Path)
		if p == "" {
			return nil, fmt.Errorf("空路径: %q", ff.Path)
		}
		if len(p) > fixtureMaxPathLen {
			return nil, fmt.Errorf("路径超长 (>%d): %q", fixtureMaxPathLen, p)
		}
		if strings.HasPrefix(p, "/") || strings.HasSuffix(p, "/") || strings.Contains(p, "//") {
			return nil, fmt.Errorf("路径含首/尾/连续斜杠: %q", p)
		}
		if strings.Contains(p, "\\") {
			return nil, fmt.Errorf("路径含反斜杠: %q", p)
		}
		for _, seg := range strings.Split(p, "/") {
			if seg == "." || seg == ".." {
				return nil, fmt.Errorf("路径含相对段: %q", p)
			}
		}
		if seen[p] {
			return nil, fmt.Errorf("重复路径: %q", p)
		}
		seen[p] = true
		if ff.Loc < 0 {
			return nil, fmt.Errorf("loc 为负: %q (%d)", p, ff.Loc)
		}
		out = append(out, fixtureFile{Path: p, Loc: ff.Loc, Lang: ff.Lang,
			IsDoc: ff.IsDoc, IsTest: ff.IsTest, IsConfig: ff.IsConfig})
	}

	// 文件/目录同名冲突（精确判定）：任一路径同时是另一路径的祖先目录即冲突。
	// 注意不能用排序相邻前缀检查——"a"、"a!b"、"a/b" 中 "a!b" 会隔开真实
	// 冲突对（'!' 0x21 < '/' 0x2f），且 BuildRepoTree round-trip 对此不丢叶、
	// 无法兜底。祖先目录集合法：O(总路径段数)，与排序无关。
	sort.Slice(out, func(i, j int) bool { return out[i].Path < out[j].Path })
	dirSet := make(map[string]bool, len(out))
	for _, ff := range out {
		segs := strings.Split(ff.Path, "/")
		for i := 1; i < len(segs); i++ {
			dirSet[strings.Join(segs[:i], "/")] = true
		}
	}
	for _, ff := range out {
		if dirSet[ff.Path] {
			return nil, fmt.Errorf("文件/目录同名冲突: %q 既是文件又是目录前缀", ff.Path)
		}
	}

	// BuildRepoTree round-trip：树构建不丢叶、不重叶（与真实 Git Tree 同构）
	fm := make([]pipelineb.FileMap, len(out))
	for i, ff := range out {
		fm[i] = pipelineb.FileMap{Path: ff.Path, Lang: ff.Lang, LOC: ff.Loc,
			IsDoc: ff.IsDoc, IsTest: ff.IsTest, IsConfig: ff.IsConfig}
	}
	root := pipelineb.BuildRepoTree(fm, name)
	leaves := root.LeafFiles()
	if len(leaves) != len(out) {
		return nil, fmt.Errorf("round-trip 叶子数不一致: 输入 %d, 树 %d", len(out), len(leaves))
	}
	return out, nil
}
