package pipelineb

import (
	"path/filepath"
	"sort"
	"strings"

	"github.com/opengits/worker-sidecar/internal/cognitive"
	"github.com/opengits/worker-sidecar/internal/platform/client"
)

type SubsystemSource struct {
	Path  string
	Bytes int64
	LOC   int
}

type SubsystemSpec struct {
	ID, Name, Prefix string
	FileCount        int
	EstLOC           int
	IsAuxiliary      bool
}

const (
	maxDirectSubsystems = 8
	primarySubsystemCap = 7
)

var monorepoManifestBasenames = map[string]struct{}{
	"package.json":   {},
	"go.mod":         {},
	"cargo.toml":     {},
	"pyproject.toml": {},
}

var naturalPackageAnchors = map[string]struct{}{
	"packages": {},
	"crates":   {},
	"apps":     {},
	"services": {},
	"cmd":      {},
}

// Collect candidates in first-seen source order and sort via SliceStable for deterministic tie-breaking; >8 caps to top 7 + auxiliary.
func DiscoverSubsystems(sources []SubsystemSource, patterns cognitive.Patterns) []SubsystemSpec {
	clean := sanitizeDiscoverySources(sources, patterns)
	if len(clean) == 0 {
		return nil
	}

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

	// Ignore root-level manifests so single-package repos with root go.mod/pyproject.toml do not fake monorepo splits.
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
	// Restrict natural package anchors (packages/<name>, etc.) to depth 0 so nested anchors do not fragment subtrees.
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
		for _, p := range prefixOrder {
			specs = append(specs, subsystemSpecFromPrefix(p))
		}
		for _, s := range clean {
			if len(s.segs) < 2 {
				continue
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
		specs = ruleCFallbackSpecs(clean)
	}
	return finalizeSubsystemSpecs(specs, clean)
}

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

type discoverySource struct {
	path string
	segs []string
	loc  int
}

// Keep package manager manifests visible even when filtering non-content dirs so monorepo detection still sees them.
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

func ruleCFallbackSpecs(clean []discoverySource) []SubsystemSpec {
	depth := 0
	for {
		directFiles := 0
		underFiles := 0
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

func finalizeSubsystemSpecs(specs []SubsystemSpec, clean []discoverySource) []SubsystemSpec {
	if len(specs) == 0 {
		return nil
	}

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

	sort.SliceStable(specs, func(i, j int) bool { return specs[i].EstLOC > specs[j].EstLOC })

	if len(specs) > maxDirectSubsystems {
		for i := primarySubsystemCap; i < len(specs); i++ {
			specs[i].IsAuxiliary = true
		}
	}

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

func subsystemSpecFromPrefix(prefix string) SubsystemSpec {
	segs := strings.Split(prefix, "/")
	return SubsystemSpec{Name: segs[len(segs)-1], Prefix: prefix}
}

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
