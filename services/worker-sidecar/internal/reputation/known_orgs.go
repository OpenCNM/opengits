package reputation

import "strings"

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

func IsKnownAuthorityOrg(owner string) bool {
	clean := strings.ToLower(strings.TrimSpace(owner))
	_, ok := KnownAuthorityOrgs[clean]
	return ok
}
