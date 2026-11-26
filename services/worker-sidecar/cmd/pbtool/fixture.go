package main

import (
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive/pipelineb"
)

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
	fixtureMaxFiles   = 150000
	fixtureMaxPathLen = 512
	fixtureMaxNameLen = 128
)

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

	// Ancestor-dir set detects conflicts like "a" vs "a/b" that lexical sort misses when "a!b" ('!' < '/') sits between them.
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
