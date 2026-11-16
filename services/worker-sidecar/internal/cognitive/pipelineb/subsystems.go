package pipelineb

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

// ─────────────────────────────────────────────────────────────
// 统一子系统发现 SSOT (契约 C1，冻结)
//
// 本文件是全管线唯一的子系统划分定义点：
//   - BuildMacroTopology 目录分区 (本包) 消费；
//   - WP1 分层抽样配额 / WP2 RenderMultiScaleMap / WP4 evaluateSubsystemCoverage
//     后续会话依赖本契约，签名与字段一字不差。
//
// 识别规则（优先级从高到低）：
//   a) Monorepo 清单目录：一级/二级目录含 package.json / go.mod /
//      Cargo.toml / pyproject.toml（路径后缀形态匹配，禁止正则扫内容）；
//   b) 自然包目录：packages/<name>、crates/<name>、apps/<name>、
//      services/<name>、cmd/<name>；
//   c) 回退：单包仓库按「跳过根包装后的活跃一级源码目录」划分
//      （复刻 skipRootWrapper 下钻语义 + isAuxiliaryDirName 过滤）；
//   d) 截断沿用现值：候选 >8 时按 EstLOC 降序取前 7 主干，其余标记
//      IsAuxiliary（信息保留，供配额跳过/覆盖豁免/长尾聚拢 common_utils）。
// ─────────────────────────────────────────────────────────────

// SubsystemSource 子系统发现的物理事实输入（文件粒度）。
type SubsystemSource struct {
	Path  string // 相对仓库根的 POSIX 路径
	Bytes int64  // blob 字节数，可为 0
	LOC   int    // 估算行数，可为 0
}

// SubsystemSpec 识别出的子系统规格（契约 C1 输出）。
type SubsystemSpec struct {
	ID, Name, Prefix string
	FileCount        int
	EstLOC           int
	IsAuxiliary      bool
}

// 截断沿用 macro_topology 现行节点硬截流守护同值（>8 截前 7）。
const (
	maxDirectSubsystems = 8
	primarySubsystemCap = 7
)

// monorepoManifestBasenames 包管理器清单基名（路径后缀形态匹配，小写比对；
// 禁止正则扫内容——文件存在性即物理事实）。
var monorepoManifestBasenames = map[string]struct{}{
	"package.json":   {},
	"go.mod":         {},
	"cargo.toml":     {},
	"pyproject.toml": {},
}

// naturalPackageAnchors 顶层自然包目录锚点。
var naturalPackageAnchors = map[string]struct{}{
	"packages": {},
	"crates":   {},
	"apps":     {},
	"services": {},
	"cmd":      {},
}

// DiscoverSubsystems 统一子系统发现：Monorepo 清单/自然包目录优先，
// 单包仓库回退为跳过根包装后的活跃一级源码目录。
// 确定性保证：候选顺序沿 sources 首现序收集，排序用 SliceStable，
// 不依赖 map 迭代序（同 LOC 竞争截断名额时结果可复现）。
func DiscoverSubsystems(sources []SubsystemSource, patterns cognitive.Patterns) []SubsystemSpec {
	clean := sanitizeDiscoverySources(sources, patterns)
	if len(clean) == 0 {
		return nil
	}

	// 规则 a/b：Monorepo 包边界候选（首现序收集，天然去重）
	prefixSeen := make(map[string]bool)
	var prefixOrder []string
	addPrefix := func(prefix string) bool {
		if prefix == "" || prefixSeen[prefix] {
			return false
		}
		prefixSeen[prefix] = true
		prefixOrder = append(prefixOrder, prefix)
		return true
	}

	// a) 一级/二级目录的包管理器清单（根清单不算——单包 Go/Python 仓
	//    普遍持有根 go.mod/pyproject.toml，计入会伪造 monorepo 分区）
	for _, s := range clean {
		depth := len(s.segs) - 1
		if depth < 1 || depth > 2 || !isMonorepoManifestBasename(s.segs[depth]) {
			continue
		}
		if isAuxiliaryDirName(s.segs[depth-1]) {
			continue
		}
		addPrefix(strings.Join(s.segs[:depth], "/"))
	}
	// b) 顶层锚点自然包目录 packages/<name> 等（锚点必须位于深度 0；
	//    嵌套锚点 apps/mobile/packages/x 不展开，保持分区粒度与现行目录树同构）
	for _, s := range clean {
		if len(s.segs) < 3 || !isNaturalPackageAnchor(s.segs[0]) {
			continue
		}
		name := s.segs[1]
		if strings.Contains(name, ".") || isAuxiliaryDirName(name) {
			continue
		}
		addPrefix(s.segs[0] + "/" + name)
	}

	var specs []SubsystemSpec
	if len(prefixOrder) >= 2 {
		// Monorepo 模式：包边界为主干；未被包前缀认领的顶层目录保底补齐，
		// 保证候选数不小于现行目录分区（能力不倒退——如 cmd/server +
		// cmd/migrate + pkg + internal 仍按目录分区而非收窄为 2 个 cmd 包）。
		for _, p := range prefixOrder {
			specs = append(specs, subsystemSpecFromPrefix(p))
		}
		for _, s := range clean {
			if len(s.segs) < 2 {
				continue // 根散落文件无所属目录，不构成顶层候选
			}
			top := s.segs[0]
			if prefixSeen[top] || isAuxiliaryDirName(top) {
				continue
			}
			if longestMatchingPrefix(s.path, prefixOrder) != "" {
				continue
			}
			if addPrefix(top) {
				specs = append(specs, subsystemSpecFromPrefix(top))
			}
		}
	} else {
		// 规则 c：单包仓库回退（唯一清单/锚点目录视作根包装，不做包边界）
		specs = ruleCFallbackSpecs(clean)
	}
	return finalizeSubsystemSpecs(specs, clean)
}

// SubsystemSourcesFromTreeEntries 从 Git 树条目适配子系统发现输入。
// 仅取 blob；LOC 沿用树建图同款估算 size/32+1（空 blob 记 0）。
func SubsystemSourcesFromTreeEntries(entries []client.GitTreeEntry) []SubsystemSource {
	out := make([]SubsystemSource, 0, len(entries))
	for _, e := range entries {
		if e.Type != "blob" {
			continue
		}
		p := strings.TrimPrefix(filepath.ToSlash(e.Path), "/")
		if p == "" {
			continue
		}
		src := SubsystemSource{Path: p, Bytes: e.Size}
		if e.Size > 0 {
			src.LOC = int(e.Size)/32 + 1
		}
		out = append(out, src)
	}
	return out
}

// SubsystemSourcesFromRepoMap 从整仓 AST 目录表适配子系统发现输入
// （LOC 用已提取/估算行数；FileMap 无字节数，Bytes 记 0）。
func SubsystemSourcesFromRepoMap(m *RepoMap) []SubsystemSource {
	if m == nil {
		return nil
	}
	out := make([]SubsystemSource, 0, len(m.Files))
	for i := range m.Files {
		p := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(m.Files[i].Path)), "/")
		if p == "" {
			continue
		}
		out = append(out, SubsystemSource{Path: p, LOC: m.Files[i].LOC})
	}
	return out
}

// ─────────────────────────────────────────────────────────────
// 内部实现
// ─────────────────────────────────────────────────────────────

// discoverySource 归一化后的文件事实（段切分只做一次）。
type discoverySource struct {
	path string
	segs []string
	loc  int
}

// sanitizeDiscoverySources 归一化 + 内容卫生过滤（patterns 允许 nil）：
// 剔除 .git/node_modules 与非内容目录（与 walkContentFiles/
// FilterContentEntries 的目录黑名单同构）、二进制/归档与非内容文件。
// 包管理器清单（package.json 等）天然不在排除之列，保证规则 a 可见。
func sanitizeDiscoverySources(sources []SubsystemSource, patterns cognitive.Patterns) []discoverySource {
	clean := make([]discoverySource, 0, len(sources))
	for _, s := range sources {
		p := strings.TrimPrefix(filepath.ToSlash(strings.TrimSpace(s.Path)), "/")
		if p == "" {
			continue
		}
		segs := strings.Split(p, "/")
		excluded := false
		for _, seg := range segs[:len(segs)-1] {
			if seg == ".git" || seg == "node_modules" {
				excluded = true
				break
			}
			if patterns != nil && patterns.IsNonContentDir(seg) {
				excluded = true
				break
			}
		}
		if excluded {
			continue
		}
		if patterns != nil {
			base := segs[len(segs)-1]
			if patterns.IsBinaryOrArchiveFile(p) || patterns.IsNonContentFile(base) {
				continue
			}
		}
		clean = append(clean, discoverySource{path: p, segs: segs, loc: s.LOC})
	}
	return clean
}

// ruleCFallbackSpecs 单包回退：复刻 skipRootWrapper 的下钻语义——
// 唯一子目录段且直属文件占比 <10% 时逐层下钻（树侧单子目录链折叠
// 已在该条件中合并），终层活跃目录段即分区候选（isAuxiliaryDirName
// 过滤，首现序）。
func ruleCFallbackSpecs(clean []discoverySource) []SubsystemSpec {
	depth := 0
	for {
		directFiles := 0 // 该层直属文件数（等价 skipRootWrapper 的 n.Files）
		underFiles := 0  // 唯一子目录段下全部文件数（等价 children[0].FileCount）
		segSeen := make(map[string]bool)
		var segOrder []string
		for _, s := range clean {
			switch {
			case len(s.segs) == depth+1:
				directFiles++
			case len(s.segs) > depth+1:
				underFiles++
				seg := s.segs[depth]
				if !segSeen[seg] {
					segSeen[seg] = true
					segOrder = append(segOrder, seg)
				}
			}
		}
		if len(segOrder) == 1 && float64(directFiles)/float64(underFiles+1) < 0.1 {
			depth++
			continue
		}
		// 终层：目录段即候选；直属文件（根散落代码）由调用方按 entrypoint 处理
		base := ""
		if depth > 0 {
			for _, s := range clean {
				if len(s.segs) > depth {
					base = strings.Join(s.segs[:depth], "/")
					break
				}
			}
		}
		var specs []SubsystemSpec
		for _, seg := range segOrder {
			if isAuxiliaryDirName(seg) {
				continue
			}
			prefix := seg
			if base != "" {
				prefix = base + "/" + seg
			}
			specs = append(specs, SubsystemSpec{Name: seg, Prefix: prefix})
		}
		return specs
	}
}

// finalizeSubsystemSpecs 聚合统计 → EstLOC 降序 → 截断 → ID 分配。
func finalizeSubsystemSpecs(specs []SubsystemSpec, clean []discoverySource) []SubsystemSpec {
	if len(specs) == 0 {
		return nil
	}

	// 最长前缀归属聚合（嵌套前缀如 apps + apps/web 时取最长；
	// 未被任何前缀认领的文件不计入统计，与现行非候选目录文件不入图一致）
	for _, s := range clean {
		best := -1
		bestLen := -1
		for i := range specs {
			sp := specs[i].Prefix
			if (s.path == sp || strings.HasPrefix(s.path, sp+"/")) && len(sp) > bestLen {
				bestLen = len(sp)
				best = i
			}
		}
		if best >= 0 {
			specs[best].FileCount++
			specs[best].EstLOC += s.loc
		}
	}

	// EstLOC 降序（SliceStable 保持首现序兜底）
	sort.SliceStable(specs, func(i, j int) bool { return specs[i].EstLOC > specs[j].EstLOC })

	// 截断沿用现值：>8 时前 7 主干，其余标记 auxiliary（信息保留）
	if len(specs) > maxDirectSubsystems {
		for i := primarySubsystemCap; i < len(specs); i++ {
			specs[i].IsAuxiliary = true
		}
	}

	// ID 分配（排序后执行保证确定性；同名段碰撞回退 Prefix 基 ID）
	used := make(map[string]bool, len(specs))
	for i := range specs {
		id := sanitizeMermaidId("sub_" + specs[i].Name)
		if used[id] {
			id = sanitizeMermaidId("sub_" + specs[i].Prefix)
		}
		for used[id] {
			id = sanitizeMermaidId(id + "_x")
		}
		used[id] = true
		specs[i].ID = id
	}
	return specs
}

// subsystemSpecFromPrefix 前缀 → 规格（Name 取末段展示名）。
func subsystemSpecFromPrefix(prefix string) SubsystemSpec {
	segs := strings.Split(prefix, "/")
	return SubsystemSpec{Name: segs[len(segs)-1], Prefix: prefix}
}

// longestMatchingPrefix 返回 p 的最长匹配前缀（无匹配返回 ""）。
func longestMatchingPrefix(p string, prefixes []string) string {
	best := ""
	for _, prefix := range prefixes {
		if (p == prefix || strings.HasPrefix(p, prefix+"/")) && len(prefix) > len(best) {
			best = prefix
		}
	}
	return best
}

func isMonorepoManifestBasename(base string) bool {
	_, ok := monorepoManifestBasenames[strings.ToLower(base)]
	return ok
}

func isNaturalPackageAnchor(seg string) bool {
	_, ok := naturalPackageAnchors[strings.ToLower(seg)]
	return ok
}
