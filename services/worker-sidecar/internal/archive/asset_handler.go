package archive

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
	"github.com/opengits/worker-sidecar/internal/transform"
)

func init() {
	// 针对极简容器镜像（如 Scratch/Alpine 无系统 mime.types），硬化注册通用前端资产 MIME
	_ = mime.AddExtensionType(".svg", "image/svg+xml")
	_ = mime.AddExtensionType(".webp", "image/webp")
	_ = mime.AddExtensionType(".avif", "image/avif")
	_ = mime.AddExtensionType(".ico", "image/x-icon")
	_ = mime.AddExtensionType(".mp4", "video/mp4")
	_ = mime.AddExtensionType(".webm", "video/webm")
	_ = mime.AddExtensionType(".mp3", "audio/mpeg")
	_ = mime.AddExtensionType(".wav", "audio/wav")
	_ = mime.AddExtensionType(".woff", "font/woff")
	_ = mime.AddExtensionType(".woff2", "font/woff2")
	_ = mime.AddExtensionType(".ttf", "font/ttf")
}

var errAssetNotFound = errors.New("asset not found upstream")

// HandleAssetServe 处理 GET /v1/assets/serve 静态资产流式直出请求。
// 原生享受 http.ServeFile 的内核零拷贝、HTTP 206 Range 分块、HTTP 304 If-Modified-Since 协商缓存。
func (h *Handler) HandleAssetServe(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		httpx.Error(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}

	owner := r.URL.Query().Get("owner")
	repo := r.URL.Query().Get("repo")
	pathParam := r.URL.Query().Get("path")
	sha := r.URL.Query().Get("sha")
	branch := r.URL.Query().Get("branch")

	// 1. 安全段与路径白名单防御（BOLA 边界在 Node，Go 端守住本地文件系统穿越与非法输入）
	if !IsSafeSegment(owner) || !IsSafeSegment(repo) {
		httpx.Error(w, http.StatusBadRequest, "invalid owner or repo segment")
		return
	}

	if pathParam == "" || strings.HasPrefix(pathParam, "/") || strings.HasPrefix(pathParam, "\\") || strings.Contains(pathParam, "\\") {
		httpx.Error(w, http.StatusBadRequest, "invalid asset path: must be a relative path without backslashes")
		return
	}

	if !transform.IsSafeRelativePath(pathParam) {
		httpx.Error(w, http.StatusBadRequest, "invalid asset path")
		return
	}

	cleanPath := path.Clean(pathParam)
	if cleanPath == "." || cleanPath == ".." || strings.HasPrefix(cleanPath, "..") || strings.HasPrefix(cleanPath, "/") {
		httpx.Error(w, http.StatusBadRequest, "path traversal detected")
		return
	}

	// 拦截自嵌套历史污染前缀（如 api/assets/...）
	if cleanPath == "api/assets" || strings.HasPrefix(cleanPath, "api/assets/") {
		httpx.Error(w, http.StatusBadRequest, "invalid asset self-nesting path")
		return
	}

	assetsRoot := h.cfg.AssetsRoot
	if assetsRoot == "" {
		assetsRoot = "storage/assets"
	}
	localAssetPath := filepath.Join(assetsRoot, owner, repo, filepath.FromSlash(cleanPath))
	relAssets, err := filepath.Rel(assetsRoot, localAssetPath)
	if err != nil || strings.HasPrefix(relAssets, "..") || relAssets == "." {
		httpx.Error(w, http.StatusBadRequest, "invalid asset path traversal")
		return
	}

	// 2. 本地磁盘命中（Fast Path）
	if st, err := os.Stat(localAssetPath); err == nil && !st.IsDir() {
		serveAssetFile(w, r, localAssetPath)
		return
	}

	key := fmt.Sprintf("%s/%s/%s", owner, repo, cleanPath)
	assetsKey := fmt.Sprintf("assets/%s/%s/%s", owner, repo, cleanPath)

	// 3. S3 对象存储（CDN 302 重定向直出）
	if h.cfg.StorageDriver == "s3" && h.assets != nil && h.cfg.StoragePublicBaseURL != "" {
		targetKey := key
		exists, err := h.assets.Exists(r.Context(), key)
		if err != nil || !exists {
			if existsAssets, errAssets := h.assets.Exists(r.Context(), assetsKey); errAssets == nil && existsAssets {
				exists = true
				targetKey = assetsKey
			}
		}
		if exists {
			targetURL := fmt.Sprintf("%s/%s", strings.TrimRight(h.cfg.StoragePublicBaseURL, "/"), targetKey)
			w.Header().Set("Location", targetURL)
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
			w.WriteHeader(http.StatusFound)
			return
		}
	}

	// 4. 回源与缓存解析（使用 singleflight 合并高并发对同一未命中资源的重复拉取）
	ref := sha
	if ref == "" || !shaRE.MatchString(ref) {
		ref = branch
	}
	if ref == "" || !transform.IsSafeBranch(ref) {
		ref = h.cfg.DefaultBranch
	}
	if ref == "" {
		ref = "main"
	}

	sfKey := fmt.Sprintf("%s/%s/%s/%s", owner, repo, ref, cleanPath)
	_, sfErr, _ := h.assetSF.Do(sfKey, func() (any, error) {
		// 并发双检：前序协程可能已将文件写入本地
		if st, err := os.Stat(localAssetPath); err == nil && !st.IsDir() {
			return nil, nil
		}

		// S3 本地直出拉取（无 CDN 域名模式）
		if h.tryFetchFromS3(key, assetsKey, localAssetPath) {
			return nil, nil
		}

		// 本地归档提取（Archive Dir 命中）
		if h.tryServeFromArchive(owner, repo, sha, cleanPath, localAssetPath, key) {
			return nil, nil
		}

		// 远端 GitHub Raw 兜底回源
		rawBase := h.cfg.RawBase
		if rawBase == "" {
			rawBase = "https://raw.githubusercontent.com"
		}
		u, err := url.Parse(rawBase)
		if err != nil {
			return nil, fmt.Errorf("invalid rawBase url: %w", err)
		}
		u.Path = path.Join(u.Path, owner, repo, ref, cleanPath)
		rawURL := u.String()

		fetchCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()

		fetchReq, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, rawURL, nil)
		if err != nil {
			return nil, fmt.Errorf("failed to create upstream raw request: %w", err)
		}
		userAgent := h.cfg.UserAgent
		if userAgent == "" {
			userAgent = "OpenGits-Engine/1.0"
		}
		fetchReq.Header.Set("User-Agent", userAgent)
		if h.cfg.GitHubToken != "" {
			fetchReq.Header.Set("Authorization", "Bearer "+h.cfg.GitHubToken)
		}

		client := h.assetClient
		if client == nil {
			client = &http.Client{Timeout: 30 * time.Second}
		}

		resp, err := client.Do(fetchReq)
		if err != nil {
			return nil, fmt.Errorf("failed to fetch remote raw asset: %w", err)
		}
		defer resp.Body.Close()

		if resp.StatusCode == http.StatusNotFound {
			return nil, errAssetNotFound
		}
		if resp.StatusCode != http.StatusOK {
			return nil, fmt.Errorf("upstream returned status %d", resp.StatusCode)
		}

		// 流式写入本地磁盘，绝不全量缓冲至堆内存
		if err := atomicWriteStreamAssetFile(localAssetPath, io.LimitReader(resp.Body, 50<<20)); err != nil {
			return nil, fmt.Errorf("failed to cache asset locally: %w", err)
		}

		if h.cfg.StorageDriver == "s3" && h.assets != nil {
			if data, err := os.ReadFile(localAssetPath); err == nil {
				putCtx, putCancel := context.WithTimeout(context.Background(), 30*time.Second)
				defer putCancel()
				_ = h.assets.Put(putCtx, key, data)
			}
		}

		return nil, nil
	})

	if errors.Is(sfErr, errAssetNotFound) {
		httpx.Error(w, http.StatusNotFound, "asset not found upstream")
		return
	}
	if sfErr != nil {
		httpx.Error(w, http.StatusBadGateway, fmt.Sprintf("failed to fetch asset: %v", sfErr))
		return
	}

	serveAssetFile(w, r, localAssetPath)
}

// serveAssetFile 统一响应资产文件（注入 Cache-Control 与 nosniff，交由 http.ServeFile 原生流式直出）。
func serveAssetFile(w http.ResponseWriter, r *http.Request, filePath string) {
	st, err := os.Stat(filePath)
	if err != nil || st.IsDir() {
		httpx.Error(w, http.StatusNotFound, "asset not found")
		return
	}
	w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeFile(w, r, filePath)
}

// copyAssetFileAtomic 原子拷贝文件，防止多请求并发读取半写文件。
func copyAssetFileAtomic(src, dest string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	return atomicWriteStreamAssetFile(dest, in)
}

// atomicWriteAssetFile 原子落盘字节流（兼容内存切片落盘）。
func atomicWriteAssetFile(dest string, data []byte) error {
	return atomicWriteStreamAssetFile(dest, bytes.NewReader(data))
}

// atomicWriteStreamAssetFile 以流式方式原子落盘，通过临时文件加 rename 杜绝半写，消除大文件堆内存分配。
func atomicWriteStreamAssetFile(dest string, r io.Reader) error {
	dir := filepath.Dir(dest)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "asset-tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer func() {
		_ = tmp.Close()
		_ = os.Remove(tmpName)
	}()

	if _, err := io.Copy(tmp, r); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	return os.Rename(tmpName, dest)
}

func (h *Handler) tryFetchFromS3(key, assetsKey, localAssetPath string) bool {
	if h.cfg.StorageDriver != "s3" || h.assets == nil {
		return false
	}
	s3Ctx, s3Cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer s3Cancel()

	targetKey := key
	exists, err := h.assets.Exists(s3Ctx, key)
	if err != nil || !exists {
		existsAssets, errAssets := h.assets.Exists(s3Ctx, assetsKey)
		if errAssets != nil || !existsAssets {
			return false
		}
		targetKey = assetsKey
	}

	data, err := h.assets.Get(s3Ctx, targetKey)
	if err != nil {
		return false
	}
	return atomicWriteStreamAssetFile(localAssetPath, bytes.NewReader(data)) == nil
}

func (h *Handler) tryServeFromArchive(owner, repo, archiveSha, cleanPath, localAssetPath, key string) bool {
	if archiveSha == "" || !shaRE.MatchString(archiveSha) {
		return false
	}
	archiveRoot := h.cfg.ArchiveRoot
	if archiveRoot == "" {
		archiveRoot = "storage/repos"
	}
	archiveDir := ArchiveDirFor(archiveRoot, owner, repo, archiveSha)
	archiveFilePath := filepath.Join(archiveDir, filepath.FromSlash(cleanPath))
	relArchive, err := filepath.Rel(archiveDir, archiveFilePath)
	if err != nil || strings.HasPrefix(relArchive, "..") {
		return false
	}
	st, err := os.Stat(archiveFilePath)
	if err != nil || st.IsDir() {
		return false
	}
	if err := copyAssetFileAtomic(archiveFilePath, localAssetPath); err != nil {
		return false
	}
	h.mirrorToS3IfConfigured(key, localAssetPath)
	return true
}

func (h *Handler) mirrorToS3IfConfigured(key, localAssetPath string) {
	if h.cfg.StorageDriver != "s3" || h.assets == nil {
		return
	}
	data, err := os.ReadFile(localAssetPath)
	if err != nil {
		return
	}
	putCtx, putCancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer putCancel()
	_ = h.assets.Put(putCtx, key, data)
}
