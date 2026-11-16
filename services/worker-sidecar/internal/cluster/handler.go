package cluster

// （HTTP 端点 /v1/clusters/recompute 已随 TS cluster-recompute-driver 退役下线，
//  2026-11 收口——更新管线的聚类重算由 internal/update 进程内直调本包。）

var defaultArchiveRoot = "storage/repos"

// SetDefaultArchiveRoot sets the default archive root path for cluster recomputation.
func SetDefaultArchiveRoot(root string) {
	if root != "" {
		defaultArchiveRoot = root
	}
}

