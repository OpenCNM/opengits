package transform

import (
	"path"
	"strings"
)

var supportedImageExtensions = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".svg": {}, ".webp": {},
}

type transformContext struct {
	owner       string
	repo        string
	branch      string
	rawBase     string
	webBase     string
	currentDir  string
	validPaths  map[string]struct{}
	assetPrefix string

	referencedAssets map[string]struct{}
}

func newTransformContext(owner, repo, branch, currentFilePath string, validFilePaths []string, rawBase, webBase string) *transformContext {
	currentFilePath = strings.ReplaceAll(currentFilePath, "\\", "/")
	dir := path.Dir(currentFilePath)
	vp := make(map[string]struct{}, len(validFilePaths))
	for _, p := range validFilePaths {
		vp[strings.ReplaceAll(p, "\\", "/")] = struct{}{}
	}
	return &transformContext{
		owner: owner, repo: repo, branch: branch,
		rawBase:    strings.TrimSuffix(rawBase, "/"),
		webBase:    strings.TrimSuffix(webBase, "/"),
		currentDir: dir, validPaths: vp,
		assetPrefix:      "/api/assets/" + owner + "/" + repo,
		referencedAssets: map[string]struct{}{},
	}
}

// Stack-based balanced scanner handles nested image-in-link syntax while skipping masked code blocks.
func rewriteLinksImages(masked string, tc *transformContext) string {
	var b strings.Builder
	n := len(masked)
	var labelStack []int
	i := 0
	for i < n {
		switch masked[i] {
		case '\\':
			if i+1 < n {
				b.WriteString(masked[i : i+2])
				i += 2
			} else {
				b.WriteByte(masked[i])
				i++
			}
		case '[':
			labelStack = append(labelStack, i)
			b.WriteByte(masked[i])
			i++
		case ']':
			if len(labelStack) == 0 {
				b.WriteByte(masked[i])
				i++
				continue
			}
			open := labelStack[len(labelStack)-1]
			labelStack = labelStack[:len(labelStack)-1]
			isImage := open > 0 && masked[open-1] == '!' && (open < 2 || masked[open-2] != '\\')
			if i+1 < n && masked[i+1] == '(' {
				if destEnd, ok := scanBalanced(masked, i+1, '(', ')'); ok {
					inner := masked[i+2 : destEnd]
					oldURL := splitDestTitle(inner).url
					newURL, changed := tc.rewriteDest(oldURL, isImage)
					if !changed {
						newURL = oldURL
					}
					b.WriteString("](")
					b.WriteString(newURL)
					b.WriteString(inner[len(oldURL):])
					b.WriteByte(')')
					i = destEnd + 1
					continue
				}
			}
			b.WriteByte(masked[i])
			i++
		default:
			j := i + 1
			for j < n && masked[j] != '\\' && masked[j] != '[' && masked[j] != ']' {
				j++
			}
			b.WriteString(masked[i:j])
			i = j
		}
	}
	return b.String()
}

func scanBalanced(s string, open int, oc, cc byte) (int, bool) {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '\\':
			i++
		case oc:
			depth++
		case cc:
			depth--
			if depth == 0 {
				return i, true
			}
		}
	}
	return 0, false
}

type destSpan struct{ url, title string }

func splitDestTitle(inner string) destSpan {
	for j := 0; j < len(inner); j++ {
		if inner[j] == ' ' || inner[j] == '\t' {
			return destSpan{url: inner[:j], title: inner[j:]}
		}
	}
	return destSpan{url: inner}
}

func (tc *transformContext) rewriteDest(rawURL string, isImage bool) (string, bool) {
	if isImage {
		return tc.rewriteImageDest(rawURL)
	}
	return tc.rewriteLinkDest(rawURL)
}

func (tc *transformContext) rewriteImageDest(rawURL string) (string, bool) {
	// Requires "://" on http/https so relative files like http.md are not treated as absolute URLs.
	if rawURL == "" || strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") ||
		strings.HasPrefix(rawURL, "//") || strings.HasPrefix(rawURL, "data:") ||
		strings.HasPrefix(rawURL, "/api/assets/") {
		return rawURL, false
	}
	cleanURL := strings.Split(strings.Split(rawURL, "?")[0], "#")[0]

	resolved, ok := resolveRepoPath(tc.currentDir, cleanURL)
	if !ok {
		return rawURL, false
	}
	if hasApiAssetsSegment(resolved) {
		return rawURL, false
	}
	ext := strings.ToLower(path.Ext(resolved))
	if _, isImg := supportedImageExtensions[ext]; isImg {
		tc.referencedAssets[resolved] = struct{}{}
		return tc.assetPrefix + "/" + resolved, true
	}
	return tc.rawBase + "/" + tc.owner + "/" + tc.repo + "/" + tc.branch + "/" + resolved, true
}

func (tc *transformContext) rewriteLinkDest(rawURL string) (string, bool) {
	if rawURL == "" || strings.HasPrefix(rawURL, "http://") || strings.HasPrefix(rawURL, "https://") ||
		strings.HasPrefix(rawURL, "#") ||
		strings.HasPrefix(rawURL, "mailto:") || strings.HasPrefix(rawURL, "/docs/") ||
		strings.HasPrefix(rawURL, "/api/assets/") {
		return rawURL, false
	}
	parts := strings.SplitN(rawURL, "#", 2)
	urlNoAnchor := parts[0]
	anchor := ""
	if len(parts) > 1 {
		anchor = "#" + parts[1]
	}

	resolved, ok := resolveRepoPath(tc.currentDir, urlNoAnchor)
	if !ok {
		return rawURL, false
	}

	isValid := func(p string) bool { _, ok := tc.validPaths[p]; return ok }
	if !isValid(resolved) && isValid(resolved+".md") {
		resolved += ".md"
	} else if !isValid(resolved) && isValid(resolved+".mdx") {
		resolved += ".mdx"
	}

	if isValid(resolved) {
		urlPath := strings.TrimSuffix(strings.TrimSuffix(resolved, ".mdx"), ".md")
		if strings.HasSuffix(urlPath, "/README") {
			urlPath = strings.TrimSuffix(urlPath, "/README")
		}
		if urlPath == "README" {
			urlPath = ""
		}
		return "/docs/" + tc.owner + "/" + tc.repo + "/" + urlPath + anchor, true
	}
	return tc.webBase + "/" + tc.owner + "/" + tc.repo + "/blob/" + tc.branch + "/" + resolved + anchor, true
}

func resolveRepoPath(currentDir, cleanURL string) (string, bool) {
	var joined string
	if strings.HasPrefix(cleanURL, "/") {
		joined = path.Clean(strings.TrimPrefix(cleanURL, "/"))
	} else {
		joined = path.Join(currentDir, cleanURL)
	}
	if strings.HasPrefix(joined, "..") {
		return "", false
	}
	return joined, true
}

// Guards against self-nesting /api/assets rewrites on already-rewritten asset links.
func hasApiAssetsSegment(p string) bool {
	segs := strings.Split(p, "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] == "api" && segs[i+1] == "assets" {
			return true
		}
	}
	return false
}
