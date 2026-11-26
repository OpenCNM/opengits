package cluster

var defaultArchiveRoot = "storage/repos"

func SetDefaultArchiveRoot(root string) {
	if root != "" {
		defaultArchiveRoot = root
	}
}
