package cluster

import (
	"os"
	"path/filepath"
)

func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, owner, repo, sha)
}

func WalkArchiveTree(archiveRoot, owner, repo, sha string, skipDirFn func(relPath string) bool, fn func(GitNode) error) bool {
	finalDir := ArchiveDirFor(archiveRoot, owner, repo, sha)
	info, err := os.Stat(finalDir)
	if err != nil || !info.IsDir() {
		return false
	}

	type frame struct {
		dir string
		rel string
	}
	stack := []frame{{dir: finalDir, rel: ""}}
	for len(stack) > 0 {
		f := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		entries, err := os.ReadDir(f.dir)
		if err != nil {
			continue
		}
		for _, entry := range entries {
			if f.rel == "" && entry.Name() == ".scoped_unpack" {
				// Skip scoped-extract internal marker so it never enters GitNode file counts.
				continue
			}
			relPath := entry.Name()
			if f.rel != "" {
				relPath = f.rel + "/" + entry.Name()
			}
			full := filepath.Join(f.dir, entry.Name())
			if entry.IsDir() {
				if skipDirFn != nil && skipDirFn(relPath) {
					continue
				}
				node := GitNode{Path: relPath, Type: "tree"}
				if err := fn(node); err != nil {
					return true
				}
				stack = append(stack, frame{dir: full, rel: relPath})
			} else if entry.Type() == 0 || entry.Type().IsRegular() {
				st, err := os.Stat(full)
				if err != nil {
					continue
				}
				node := GitNode{Path: relPath, Type: "blob", Size: st.Size()}
				if err := fn(node); err != nil {
					return true
				}
			}
		}
	}
	return true
}
