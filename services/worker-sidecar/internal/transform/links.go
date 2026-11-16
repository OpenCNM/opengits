package transform

import (
	"path"
	"strings"
)

// ─────────────────────────────────────────────────────────────
// inline link/image 目标改写（原移植自 transformer.ts unified AST 趟；TS 原体已退役，本包为唯一实现）。
//
// 实现说明（偏离 Node 的点，语义对齐）：
//   - Node 用 remark AST 定位后重写再 remark-stringify 归一输出；
//     Go 侧在 masked 文本（代码块已被 token 保护——mask 存在的意义）上用
//     括号平衡扫描器就地改写目标串，其余字节原样保留。
//   - remark 的 'link' visitor 只覆盖 inline 链接（linkReference/definition
//     节点不被访问）——扫描器同样只处理 `](dest)` 形态，语义一致。
//   - dest 含嵌套括号（如 Wikipedia 尾括号）按平衡计数读取，
//     与 remark 解析器的行为对齐（朴素 `[^)]` 正则做不到）。
// ─────────────────────────────────────────────────────────────

var supportedImageExtensions = map[string]struct{}{
	".png": {}, ".jpg": {}, ".jpeg": {}, ".gif": {}, ".svg": {}, ".webp": {},
}

// transformContext 单次 process 的上下文（等价 Transformer 实例字段）。
type transformContext struct {
	owner       string
	repo        string
	branch      string
	rawBase     string // GITHUB_ENDPOINTS.raw
	webBase     string // GITHUB_ENDPOINTS.web
	currentDir  string // posix dirname(currentFilePath)
	validPaths  map[string]struct{}
	assetPrefix string // /api/assets/{owner}/{repo}

	referencedAssets map[string]struct{}
}

func newTransformContext(owner, repo, branch, currentFilePath string, validFilePaths []string, rawBase, webBase string) *transformContext {
	currentFilePath = strings.ReplaceAll(currentFilePath, "\\", "/")
	dir := path.Dir(currentFilePath) // posix 语义（'.' 当无目录）
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

// rewriteLinksImages 就地改写 masked 文本中的 inline image/link 目标。
// 栈式扫描：`[` 入栈、`]` 出栈且后随 `(` 时读取平衡括号内目标改写——
// link label 内嵌套 image（[![alt](img)](url)）内外层都能被处理
// （对齐 remark visit 的递归语义）。
func rewriteLinksImages(masked string, tc *transformContext) string {
	var b strings.Builder
	n := len(masked)
	var labelStack []int // 未闭合 `[` 的下标
	i := 0
	for i < n {
		switch masked[i] {
		case '\\':
			// 转义字符原样输出并跳过下一字符
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
			// `[` 前是 `!` → image（未被转义：前一字符不是反斜杠）
			isImage := open > 0 && masked[open-1] == '!' && (open < 2 || masked[open-2] != '\\')
			if i+1 < n && masked[i+1] == '(' {
				if destEnd, ok := scanBalanced(masked, i+1, '(', ')'); ok {
					inner := masked[i+2 : destEnd] // 括号内（url + 可选 title）
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
			// 普通文本按 run 批段写入：直到下一个感兴趣的字符
			// （\ [ ]，与 switch 分支集合一致）
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

// scanBalanced 从 open 位置起做括号平衡扫描，返回匹配闭括号下标（含）。
func scanBalanced(s string, open int, oc, cc byte) (int, bool) {
	depth := 0
	for i := open; i < len(s); i++ {
		switch s[i] {
		case '\\': // 转义字符跳过
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

// splitDestTitle 拆 `(url "title")` 括号内串：url 到首个空白为止。
func splitDestTitle(inner string) destSpan {
	for j := 0; j < len(inner); j++ {
		if inner[j] == ' ' || inner[j] == '\t' {
			return destSpan{url: inner[:j], title: inner[j:]}
		}
	}
	return destSpan{url: inner}
}

// rewriteDest 单目标改写规则（对应已退役 transformer.ts 的 visit image/link 语义）。
func (tc *transformContext) rewriteDest(rawURL string, isImage bool) (string, bool) {
	if isImage {
		return tc.rewriteImageDest(rawURL)
	}
	return tc.rewriteLinkDest(rawURL)
}

func (tc *transformContext) rewriteImageDest(rawURL string) (string, bool) {
	// 绝对协议判定必须带 "://"：裸 "http" 会把相对文件 http.md/https.md
	// 误判为绝对 URL 而跳过改写，产出死链。
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
		return rawURL, false // 自嵌套守卫（Phase 4 T7）
	}
	ext := strings.ToLower(path.Ext(resolved))
	if _, isImg := supportedImageExtensions[ext]; isImg {
		tc.referencedAssets[resolved] = struct{}{}
		return tc.assetPrefix + "/" + resolved, true
	}
	return tc.rawBase + "/" + tc.owner + "/" + tc.repo + "/" + tc.branch + "/" + resolved, true
}

func (tc *transformContext) rewriteLinkDest(rawURL string) (string, bool) {
	// 同 rewriteImageDest：绝对协议判定必须带 "://"，防 http.md 相对文件误判。
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

// resolveRepoPath 相对/绝对仓库路径归一（等价 path.posix.normalize/join +
// startsWith('..') 越界拒绝）。
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

// hasApiAssetsSegment 归一化后路径含 api/assets 段 → 自嵌套守卫命中。
func hasApiAssetsSegment(p string) bool {
	segs := strings.Split(p, "/")
	for i := 0; i+1 < len(segs); i++ {
		if segs[i] == "api" && segs[i+1] == "assets" {
			return true
		}
	}
	return false
}
