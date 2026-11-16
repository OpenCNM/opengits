package archive

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type fakeAssetStore struct {
	mu      sync.Mutex
	objects map[string][]byte
}

func newFakeAssetStore() *fakeAssetStore {
	return &fakeAssetStore{objects: make(map[string][]byte)}
}

func (f *fakeAssetStore) EnsureBucket(ctx context.Context) error {
	return nil
}

func (f *fakeAssetStore) Put(ctx context.Context, key string, data []byte) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.objects[key] = data
	return nil
}

func (f *fakeAssetStore) Exists(ctx context.Context, key string) (bool, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	_, ok := f.objects[key]
	return ok, nil
}

func (f *fakeAssetStore) Get(ctx context.Context, key string) ([]byte, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	data, ok := f.objects[key]
	if !ok {
		return nil, os.ErrNotExist
	}
	return data, nil
}

// TestAssetServeSuite 验证资产下沉 Go 原生流式代理（2.15.8.1, 2.15.8.2）
func TestAssetServeSuite(t *testing.T) {
	tmpDir := t.TempDir()
	assetsRoot := filepath.Join(tmpDir, "assets")
	archiveRoot := filepath.Join(tmpDir, "repos")
	require.NoError(t, os.MkdirAll(assetsRoot, 0755))
	require.NoError(t, os.MkdirAll(archiveRoot, 0755))

	token := "test-internal-token-12345"
	cfg := Config{
		InternalToken: token,
		AssetsRoot:    assetsRoot,
		ArchiveRoot:   archiveRoot,
		RawBase:       "https://raw.githubusercontent.com",
		DefaultBranch: "main",
	}

	svc := NewEnsureService(cfg)
	h := NewHandler(cfg, svc, nil)
	handler := h.testRoutes(token)

	// 准备本地静态资产：storage/assets/testowner/testrepo/images/logo.png
	owner := "testowner"
	repo := "testrepo"
	localImgDir := filepath.Join(assetsRoot, owner, repo, "images")
	require.NoError(t, os.MkdirAll(localImgDir, 0755))
	localImgPath := filepath.Join(localImgDir, "logo.png")
	imgData := []byte("fake-png-binary-content-1234567890-abcdef")
	require.NoError(t, os.WriteFile(localImgPath, imgData, 0644))

	// 准备归档资源：storage/repos/testowner/testrepo/11223344556677889900aabbccddeeff11223344/assets/diagram.svg
	sha := "11223344556677889900aabbccddeeff11223344"
	archiveDir := ArchiveDirFor(archiveRoot, owner, repo, sha)
	archiveAssetDir := filepath.Join(archiveDir, "assets")
	require.NoError(t, os.MkdirAll(archiveAssetDir, 0755))
	archiveAssetPath := filepath.Join(archiveAssetDir, "diagram.svg")
	archiveSvgData := []byte("<svg><text>Archived SVG</text></svg>")
	require.NoError(t, os.WriteFile(archiveAssetPath, archiveSvgData, 0644))

	// Mock Remote Raw Server for Upstream Fallback
	remoteRawData := []byte("remote-github-raw-image-bytes")
	rawMockServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == fmt.Sprintf("/%s/%s/main/remote/picture.jpg", owner, repo) {
			w.Header().Set("Content-Type", "image/jpeg")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(remoteRawData)
			return
		}
		w.WriteHeader(http.StatusNotFound)
	}))
	defer rawMockServer.Close()
	h.cfg.RawBase = rawMockServer.URL

	// ── 🧪 2.15.8.1 · 静态资产代理下沉 Go 原生流式直出与 Zero-Buffer 管道 ──
	t.Run("2.15.8.1_LocalAssetHit_200OK", func(t *testing.T) {
		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
		assert.Equal(t, "nosniff", rec.Header().Get("X-Content-Type-Options"))
		assert.Equal(t, imgData, rec.Body.Bytes())
	})

	t.Run("2.15.8.1_TokenInQueryParam_Rejected401", func(t *testing.T) {
		// 与 daemon s.internal 同契约：查询串 ?token= 不作为内部令牌通道（避免令牌进访问日志）；
		// 浏览器资产请求一律经 Node 代理（cookie 鉴权）→ Go（x-internal-token Header）
		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png&token=%s", owner, repo, token), nil)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusUnauthorized, rec.Code)
	})

	t.Run("2.15.8.1_HeadRequest_NoBody", func(t *testing.T) {
		req := httptest.NewRequest("HEAD", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, fmt.Sprintf("%d", len(imgData)), rec.Header().Get("Content-Length"))
		assert.Empty(t, rec.Body.Bytes(), "HEAD request must not return response body")
	})

	t.Run("2.15.8.1_ArchiveExtraction_200OK", func(t *testing.T) {
		// 目标资产当前不在 assetsRoot 中
		extractedPath := filepath.Join(assetsRoot, owner, repo, "assets", "diagram.svg")
		assert.NoFileExists(t, extractedPath)

		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=assets/diagram.svg&sha=%s", owner, repo, sha), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, archiveSvgData, rec.Body.Bytes())
		// 验证 MIME 包含 image/svg+xml（硬化注册避免 nosniff 误杀）
		assert.Contains(t, rec.Header().Get("Content-Type"), "image/svg+xml")
		// 验证资产已持久化落盘至 storage/assets
		assert.FileExists(t, extractedPath)
		persistedData, err := os.ReadFile(extractedPath)
		require.NoError(t, err)
		assert.Equal(t, archiveSvgData, persistedData)
	})

	t.Run("2.15.8.1_RemoteRawFallback_200OK", func(t *testing.T) {
		remoteCachedPath := filepath.Join(assetsRoot, owner, repo, "remote", "picture.jpg")
		assert.NoFileExists(t, remoteCachedPath)

		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=remote/picture.jpg", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, remoteRawData, rec.Body.Bytes())
		// 验证已落盘缓存
		assert.FileExists(t, remoteCachedPath)
	})

	t.Run("2.15.8.1_RemoteRawFallback_404NotFound", func(t *testing.T) {
		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=remote/not-exist.png", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNotFound, rec.Code)
	})

	t.Run("2.15.8.1_S3_CDN_Redirect_302", func(t *testing.T) {
		s3Store := newFakeAssetStore()
		s3Key := "testowner/testrepo/s3image.png"
		require.NoError(t, s3Store.Put(context.Background(), s3Key, []byte("s3-data")))

		s3Cfg := Config{
			InternalToken:        token,
			AssetsRoot:           assetsRoot,
			StorageDriver:        "s3",
			StoragePublicBaseURL: "https://cdn.example.com",
		}
		s3H := NewHandler(s3Cfg, NewEnsureService(s3Cfg), s3Store)
		s3Handler := s3H.testRoutes(token)

		req := httptest.NewRequest("GET", "/v1/assets/serve?owner=testowner&repo=testrepo&path=s3image.png", nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		s3Handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusFound, rec.Code)
		assert.Equal(t, "https://cdn.example.com/testowner/testrepo/s3image.png", rec.Header().Get("Location"))
	})

	t.Run("2.15.8.1_Singleflight_ConcurrentDeduplication", func(t *testing.T) {
		var upstreamHits atomic.Int32
		concurrentData := []byte("concurrent-fetch-bytes-dedup")
		concurrentMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			upstreamHits.Add(1)
			time.Sleep(25 * time.Millisecond) // 模拟网络延迟以覆盖并发窗口
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(concurrentData)
		}))
		defer concurrentMock.Close()

		h.cfg.RawBase = concurrentMock.URL

		const numClients = 8
		var wg sync.WaitGroup
		wg.Add(numClients)

		statuses := make([]int, numClients)
		bodies := make([][]byte, numClients)

		for i := 0; i < numClients; i++ {
			go func(idx int) {
				defer wg.Done()
				r := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=concurrent/banner.png", owner, repo), nil)
				r.Header.Set("x-internal-token", token)
				w := httptest.NewRecorder()
				handler.ServeHTTP(w, r)
				statuses[idx] = w.Code
				bodies[idx] = w.Body.Bytes()
			}(i)
		}

		wg.Wait()

		for i := 0; i < numClients; i++ {
			assert.Equal(t, http.StatusOK, statuses[i])
			assert.Equal(t, concurrentData, bodies[i])
		}
		assert.Equal(t, int32(1), upstreamHits.Load(), "singleflight must deduplicate concurrent upstream fetches to exactly 1")
	})

	// ── 🧪 2.15.8.2 · 资产流式响应 Range 头部（206）与 304 协商缓存透传 ──
	t.Run("2.15.8.2_RangeRequest_206PartialContent", func(t *testing.T) {
		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		req.Header.Set("Range", "bytes=0-3")
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusPartialContent, rec.Code)
		assert.Equal(t, "bytes 0-3/"+fmt.Sprintf("%d", len(imgData)), rec.Header().Get("Content-Range"))
		assert.Equal(t, "bytes", rec.Header().Get("Accept-Ranges"))
		assert.Equal(t, imgData[0:4], rec.Body.Bytes())
	})

	t.Run("2.15.8.2_ConditionalCaching_304NotModified", func(t *testing.T) {
		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo), nil)
		req.Header.Set("x-internal-token", token)
		// If-Modified-Since 设置为当前未来时间
		req.Header.Set("If-Modified-Since", time.Now().Add(10*time.Minute).UTC().Format(http.TimeFormat))
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusNotModified, rec.Code)
		assert.Empty(t, rec.Body.String())
	})

	// ── 安全与鉴权拦截校验 ──
	testsSecurity := []struct {
		name         string
		url          string
		token        string
		expectedCode int
	}{
		{
			name:         "Unauthorized_NoToken",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo),
			token:        "",
			expectedCode: http.StatusUnauthorized,
		},
		{
			name:         "Unauthorized_WrongToken",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png", owner, repo),
			token:        "wrong-token",
			expectedCode: http.StatusUnauthorized,
		},
		{
			name:         "Security_PathTraversal_DotDot",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=../secret.txt", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_PathTraversal_DeepDotDot",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/../../secret.txt", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_AbsolutePath_Slash",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=/etc/passwd", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_WindowsBackslash",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images\\test.png", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_SelfNesting_ApiAssets",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=api/assets", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_SelfNesting_ApiAssetsDeep",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=api/assets/foo/bar.png", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_InvalidOwnerSegment",
			url:          fmt.Sprintf("/v1/assets/serve?owner=invalid%%20owner&repo=%s&path=images/logo.png", repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_EmptyPath",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_DoubleEncoded_PathTraversal",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=%%252e%%252e%%252fsecret.txt", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_SingleEncoded_PathTraversal",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=%%2e%%2e%%2fsecret.txt", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_NullByte_Injection",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=images/logo.png%%00.evil", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
		{
			name:         "Security_WindowsDrivePrefix",
			url:          fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=C:/windows/win.ini", owner, repo),
			token:        token,
			expectedCode: http.StatusBadRequest,
		},
	}

	for _, tt := range testsSecurity {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("GET", tt.url, nil)
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()
			handler.ServeHTTP(rec, req)
			assert.Equal(t, tt.expectedCode, rec.Code)
		})
	}
}

// 🧪 [9.4.2.4] S3 模式双向兼容测试：当 key 不存在时自动回退检查 assetsKey
func TestAssetServeS3DualKeyCompatibility(t *testing.T) {
	ctx := context.Background()
	token := "test-token-s3"
	owner := "testowner"
	repo := "testrepo"
	fileName := "search-index-sha123.bin"
	indexContent := []byte("packed-ogis-binary-index-bytes")

	t.Run("CDN 302 redirect finds assetsKey fallback", func(t *testing.T) {
		tempAssetsDir := t.TempDir()
		store := NewDiskAssetStore(tempAssetsDir)
		assetsKey := fmt.Sprintf("assets/%s/%s/%s", owner, repo, fileName)
		require.NoError(t, store.Put(ctx, assetsKey, indexContent))

		cfg := Config{
			InternalToken:        token,
			StorageDriver:        "s3",
			StoragePublicBaseURL: "https://cdn.example.com/storage",
			AssetsRoot:           t.TempDir(),
			ArchiveRoot:          t.TempDir(),
		}
		s3H := NewHandler(cfg, NewEnsureService(cfg), store)
		handler := s3H.testRoutes(token)

		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=%s", owner, repo, fileName), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusFound, rec.Code)
		assert.Equal(t, fmt.Sprintf("https://cdn.example.com/storage/%s", assetsKey), rec.Header().Get("Location"))
		assert.Equal(t, "public, max-age=31536000, immutable", rec.Header().Get("Cache-Control"))
	})

	t.Run("S3 direct fetch without CDN finds assetsKey fallback", func(t *testing.T) {
		tempAssetsDir := t.TempDir()
		store := NewDiskAssetStore(tempAssetsDir)
		assetsKey := fmt.Sprintf("assets/%s/%s/%s", owner, repo, fileName)
		require.NoError(t, store.Put(ctx, assetsKey, indexContent))

		cfg := Config{
			InternalToken: token,
			StorageDriver: "s3",
			AssetsRoot:    t.TempDir(),
			ArchiveRoot:   t.TempDir(),
		}
		s3H := NewHandler(cfg, NewEnsureService(cfg), store)
		handler := s3H.testRoutes(token)

		req := httptest.NewRequest("GET", fmt.Sprintf("/v1/assets/serve?owner=%s&repo=%s&path=%s", owner, repo, fileName), nil)
		req.Header.Set("x-internal-token", token)
		rec := httptest.NewRecorder()

		handler.ServeHTTP(rec, req)

		assert.Equal(t, http.StatusOK, rec.Code)
		assert.Equal(t, indexContent, rec.Body.Bytes())
	})
}
