package pipelineb

import (
	"strings"
)

func PruneTree(root *RepoTreeNode, excludedPaths []string) {
	if root == nil || len(excludedPaths) == 0 {
		return
	}

	isExcluded := func(p string) bool {
		p = strings.Trim(p, "/ ")
		if p == "" {
			return false
		}
		for _, ex := range excludedPaths {
			ex = strings.Trim(ex, "/ ")
			if ex == "" {
				continue
			}
			if p == ex || strings.HasPrefix(p, ex+"/") {
				return true
			}
		}
		return false
	}

	var pruneNode func(n *RepoTreeNode)
	pruneNode = func(n *RepoTreeNode) {
		var keptFiles []FileMap
		for _, f := range n.Files {
			if !isExcluded(f.Path) {
				keptFiles = append(keptFiles, f)
			}
		}
		n.Files = keptFiles

		var keptChildren []*RepoTreeNode
		for _, c := range n.Children {
			if !isExcluded(c.Path) {
				pruneNode(c)
				keptChildren = append(keptChildren, c)
			}
		}
		n.Children = keptChildren
	}

	pruneNode(root)
	RollupTree(root)
}
