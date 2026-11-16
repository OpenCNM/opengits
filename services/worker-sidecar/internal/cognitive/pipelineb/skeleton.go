package pipelineb

import (
	"strings"
)

// PruneTree 根据用户排除路径（ExcludedPaths）对仓库树进行物理剪枝。
// 剪枝后自动重算 RollupTree，确保后续下钻与防幻觉装甲完全基于用户划定的事实域。
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
		// 1. 过滤直属文件
		var keptFiles []FileMap
		for _, f := range n.Files {
			if !isExcluded(f.Path) {
				keptFiles = append(keptFiles, f)
			}
		}
		n.Files = keptFiles

		// 2. 递归过滤子目录
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
