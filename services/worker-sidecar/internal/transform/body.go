package transform

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"net/url"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// ─────────────────────────────────────────────────────────────
// Go 原生 Transform 执行体（M5 第一期）：把 transformer.ts 的确定性
// 变换层（mask + 4 趟正则 + link/image 改写 + 资产预下载）从 Node
// 事件循环承接；Sanitizer 护栏自 D组端点2 起进程内单实现（goSanitizeText，
// sanitize.golden.json 冻结，Fail-Closed——清洗失败不回流未净化内容）。
//
// 编排（对齐 transform route 的抓取→Sanitize→Transform→下载链序）：
//   归档直读原文 → 进程内 sanitize → Go mask/正则/链接改写 → 资产预下载
// 任一步失败由调用方回落 deps.Web.Transform（既有三级链，永不更糟）。
// ─────────────────────────────────────────────────────────────

// AssetStore 对象存储最小契约面（支持检查存在与写入资产）。
type AssetStore interface {
	EnsureBucket(ctx context.Context) error
	Exists(ctx context.Context, key string) (bool, error)
	Put(ctx context.Context, key string, data []byte) error
}

// GoTransformDeps 注入缝（单测 fake）。
type GoTransformDeps struct {
	Assets      AssetStore // s3 对象存储（nil=跳过资产预下载）
	ArchiveRoot string     // 本地归档根（archive sidecar 落盘处）
	GitHubToken string     // raw 回源凭据（可空）
	UserAgent   string
	RawBase     string // GITHUB_ENDPOINTS.raw
	WebBase     string // GITHUB_ENDPOINTS.web
	HTTP        *http.Client
	Patterns    any // markdown 扩展注册表（包壳判定，兼容 Patterns 接口或 *IngestPatterns）
}

// RunGoTransform 单文档 transform 全链（D组端点4：/api/internal/doc/transform
// 下沉——归档直读/raw 回源 → 进程内 sanitize → 确定性变换 → 资产预下载）。
// validFilePaths 转录链恒为 [path]（与 transform route 调用方同参），
// 签名保留以便后续全仓升级。
func RunGoTransform(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	return runGoTransform(ctx, deps, owner, repo, branch, gitSha, filePath, githubToken)
}

// runGoTransform 单文档 transform 全链（D组端点4：/api/internal/doc/transform
// 下沉——归档直读/raw 回源 → 进程内 sanitize → 确定性变换 → 资产预下载）。
// validFilePaths 转录链恒为 [path]（与 transform route 调用方同参），
// 签名保留以便后续全仓升级。
func runGoTransform(ctx context.Context, deps GoTransformDeps, owner, repo, branch string, gitSha *string, filePath, githubToken string) (string, error) {
	raw, err := fetchDocRawLocalFirst(ctx, deps, owner, repo, branch, gitSha, filePath, githubToken)
	if err != nil {
		return "", err
	}

	cleaned, err := goSanitizeText(raw)
	if err != nil {
		return "", fmt.Errorf("sanitize: %w", err)
	}

	tc := newTransformContext(owner, repo, branch, filePath, []string{filePath}, deps.RawBase, deps.WebBase)
	transformed, err := goTransformText(cleaned, tc)
	if err != nil {
		return "", err
	}

	if err := downloadReferencedAssets(ctx, deps, owner, repo, gitSha, branch, githubToken, tc.referencedAssets); err != nil {
		// 资产下载失败不毁文档（对齐 Node：单资产失败只计数）
		log.Printf("[go-transform] asset download degraded for %s/%s: %v", owner, repo, err)
	}
	return transformed, nil
}

// goTransformText 确定性变换层主体（内部实现）。
func goTransformText(content string, tc *transformContext) (string, error) {
	masked, blocks := maskCodeBlocks(content)
	s := applyYouTubeCards(masked)
	s = applyAutolinks(s)
	s = applyBareTagEscape(s)
	s = rewriteLinksImages(s, tc)
	// Node 的 post 段：stringify 后 mask→孤立 < 转义→unmask；
	// Go 无再序列化，等价地在同一 masked 文本上转义后统一 unmask
	// （fenced 块在 unmask 内做语言归一）
	s = applyIsolatedLessThanEscape(s)
	return unmaskCodeBlocks(s, blocks), nil
}

// ── 资产预下载（对齐 Transformer.downloadReferencedAssets 语义：
// 已缓存跳过 → 归档直读（0 网络）→ raw 回源兜底；单资产失败吞错计数）──

var archiveShaRe = mdpat.GitShaRe

func downloadReferencedAssets(ctx context.Context, deps GoTransformDeps, owner, repo string, gitSha *string, branch, githubToken string, referenced map[string]struct{}) error {
	if len(referenced) == 0 {
		return nil
	}
	if deps.Assets == nil {
		return nil
	}
	if err := deps.Assets.EnsureBucket(ctx); err != nil {
		return fmt.Errorf("ensure bucket: %w", err)
	}
	archiveSha := ""
	if gitSha != nil && archiveShaRe.MatchString(strings.ToLower(*gitSha)) {
		// 归一小写：归档目录恒以小写 sha 命名，原值传入则永远 miss、
		// 静默退化为网络回源
		archiveSha = strings.ToLower(*gitSha)
	}
	token := githubToken
	if token == "" {
		token = deps.GitHubToken
	}

	sem := make(chan struct{}, 6) // 并发 6（对齐 Node）
	var wg sync.WaitGroup

dispatchLoop:
	for relPath := range referenced {
		select {
		case sem <- struct{}{}:
		case <-ctx.Done():
			// labeled break：裸 break 只跳出 select，循环继续给每个剩余
			// 资产照样起 goroutine（请求随即失败刷错误日志）
			break dispatchLoop
		}
		wg.Add(1)
		go func(relPath string) {
			defer wg.Done()
			defer func() { <-sem }()
			if err := downloadOneAsset(ctx, deps, owner, repo, archiveSha, branch, token, relPath); err != nil {
				log.Printf("[go-transform] asset %s failed: %v", relPath, err)
			}
		}(relPath)
	}
	wg.Wait()
	return nil
}

func downloadOneAsset(ctx context.Context, deps GoTransformDeps, owner, repo, archiveSha, branch, token, relPath string) error {
	// 路径穿越防御（对齐 Node path.relative 检查，含 URL 编码越界拦截）
	clean := path.Clean(relPath)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "..") || strings.HasPrefix(clean, "/") || !isSafeRelativePath(relPath) {
		return fmt.Errorf("path traversal rejected: %s", relPath)
	}
	if unescaped, err := url.PathUnescape(relPath); err != nil {
		return fmt.Errorf("path traversal rejected: %s", relPath)
	} else if unescaped != relPath {
		cleanUnescaped := path.Clean(unescaped)
		if cleanUnescaped == "." || cleanUnescaped == ".." || strings.HasPrefix(cleanUnescaped, "..") || strings.HasPrefix(cleanUnescaped, "/") || !isSafeRelativePath(cleanUnescaped) {
			return fmt.Errorf("path traversal rejected: %s", relPath)
		}
	}
	key := "assets/" + owner + "/" + repo + "/" + relPath

	exists, err := deps.Assets.Exists(ctx, key)
	if err != nil {
		return err
	}
	if exists {
		return nil
	}

	// 归档直取（0 网络、不消耗 GitHub 配额）
	if archiveSha != "" {
		if raw := readLocalArchiveFile(deps.ArchiveRoot, owner, repo, archiveSha, relPath); raw != "" {
			return deps.Assets.Put(ctx, key, []byte(raw))
		}
	}

	// raw 回源（ref 优先导入冻结 sha）
	rawRef := archiveSha
	if rawRef == "" {
		rawRef = branch
	}
	url := deps.RawBase + "/" + owner + "/" + repo + "/" + rawRef + "/" + relPath
	httpClient := deps.HTTP
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 60 * time.Second}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", deps.UserAgent)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("raw fetch HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 50<<20))
	if err != nil {
		return err
	}
	return deps.Assets.Put(ctx, key, data)
}
