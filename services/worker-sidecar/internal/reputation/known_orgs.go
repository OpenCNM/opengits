package reputation

import "strings"

// KnownAuthorityOrgs 知名开源组织/大厂权威组织白名单（大小写无关）。
// 凡属于这些组织的官方公开仓库，享有经典开源项目信誉加权。
var KnownAuthorityOrgs = map[string]struct{}{
	"facebook":        {},
	"meta":            {},
	"vercel":          {},
	"golang":          {},
	"google":          {},
	"microsoft":       {},
	"apple":           {},
	"vuejs":           {},
	"angular":         {},
	"kubernetes":      {},
	"kubernetes-sigs": {},
	"tensorflow":      {},
	"pytorch":         {},
	"nodejs":          {},
	"denoland":        {},
	"rust-lang":       {},
	"apache":          {},
	"eclipse":         {},
	"spring-projects": {},
	"hashicorp":       {},
	"docker":          {},
	"moby":            {},
	"tailwindlabs":    {},
	"shadcn-ui":       {},
	"ant-design":      {},
	"alibaba":         {},
	"tencent":         {},
	"bytedance":       {},
	"redis":           {},
	"elastic":         {},
	"grafana":         {},
	"prometheus":      {},
	"envoyproxy":      {},
	"istio":           {},
	"astral-sh":       {},
	"prisma":          {},
	"supabase":        {},
	"expressjs":       {},
	"pallets":         {},
	"django":          {},
}

// IsKnownAuthorityOrg 判断 owner 是否为已知权威开源组织。
func IsKnownAuthorityOrg(owner string) bool {
	clean := strings.ToLower(strings.TrimSpace(owner))
	_, ok := KnownAuthorityOrgs[clean]
	return ok
}
