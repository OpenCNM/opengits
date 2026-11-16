package archive

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/opengits/worker-sidecar/internal/mdpat"
)

// Config 归档与对象存储核心配置。
type Config struct {
	InternalToken            string
	DatabaseURL              string
	ArchiveRoot              string
	AssetsRoot               string
	EntryCapBytes            int64
	ArchiveDownloadTimeoutMs int
	GitHubAPIBase            string
	GitHubToken              string
	UserAgent                string
	StorageDriver            string
	StorageRoot              string
	StoragePublicBaseURL     string
	DefaultBranch            string
	RawBase                  string
	S3Endpoint               string
	S3Bucket                 string
	S3Region                 string
	S3AccessKeyID            string
	S3SecretAccessKey        string
	MinFreeDiskMB            int
}

// ValidateStartup 校验核心配置，未配置 INTERNAL_API_TOKEN 或 DATABASE_URL 时拒绝启动。
func (c Config) ValidateStartup() error {
	if c.InternalToken == "" {
		return errors.New("INTERNAL_API_TOKEN is not set — refusing to start")
	}
	if c.DatabaseURL == "" {
		return errors.New("DATABASE_URL is not set — refusing to start")
	}
	return nil
}

var (
	pathSegmentRE = mdpat.PathSegmentRe
	shaRE         = mdpat.GitShaRe
)

// IsSafeSegment 单段白名单：字符集受限且显式拒绝 "."/".." 本身。
func IsSafeSegment(seg string) bool {
	return pathSegmentRE.MatchString(seg) && seg != "." && seg != ".."
}

func isSafeSegment(seg string) bool {
	return IsSafeSegment(seg)
}

// errArchiveSkipped 语义等价 Node 侧 dir=null：归档超限跳过缓存，调用方回退网络路径。
var errArchiveSkipped = errors.New("archive skipped (over cap)")

// errZipBombDetected 解压膨胀率异常，拦截压缩炸弹。
var errZipBombDetected = errors.New("zip bomb detected: decompression expansion ratio exceeded safe limit (30x)")

// scopedMarkerFile 标记当前归档目录为子卷定向解压产物（非全量归档）。
const scopedMarkerFile = ".scoped_unpack"

// IgnoredPayloadExts 高危/超大非代码资产扩展名（模型权重/安装镜像/压缩包套娃/媒体音视频）。
// 流式解压遇到此类扩展名直接跳过（不创建文件、不写磁盘、不计入配额），保障纯源码分析。
var IgnoredPayloadExts = map[string]struct{}{
	// AI/ML 模型权重与分卷
	".safetensors": {},
	".onnx":        {},
	".weights":     {},
	".pt":          {},
	".pth":         {},
	".h5":          {},
	".ckpt":        {},
	".gguf":        {},
	".tflite":      {},
	// 操作系统镜像与安装包
	".iso":         {},
	".dmg":         {},
	".msi":         {},
	".exe":         {},
	".apk":         {},
	".ipa":         {},
	// 压缩包套娃与归档
	".tar":         {},
	".gz":          {},
	".zip":         {},
	".7z":          {},
	".rar":         {},
	".bz2":         {},
	".xz":          {},
	// 媒体视音频
	".mp4":         {},
	".avi":         {},
	".mov":         {},
	".webm":        {},
	".mkv":         {},
	".flv":         {},
	".mp3":         {},
	".wav":         {},
	".ogg":         {},
	".flac":        {},
}

type countingReader struct {
	r io.Reader
	n int64
}

func (c *countingReader) Read(p []byte) (int, error) {
	n, err := c.r.Read(p)
	c.n += int64(n)
	return n, err
}

// timeBoxedErr 下载/解压时间盒到期或被取消（触发 5 分钟负缓存而非报错）。
type timeBoxedErr struct{ cause error }

func (e timeBoxedErr) Error() string { return "time-boxed: " + e.cause.Error() }

type allowedFilesContextKey struct{}

// WithAllowedFiles 将大纲定向解压的白名单文件集合注入 Context。
func WithAllowedFiles(ctx context.Context, files map[string]bool) context.Context {
	if len(files) == 0 {
		return ctx
	}
	return context.WithValue(ctx, allowedFilesContextKey{}, files)
}

// AllowedFilesFromContext 从 Context 提取大纲定向解压的白名单文件集合。
func AllowedFilesFromContext(ctx context.Context) map[string]bool {
	if f, ok := ctx.Value(allowedFilesContextKey{}).(map[string]bool); ok {
		return f
	}
	return nil
}

// invalidSegmentsErr 路径段非法（owner/repo/sha 白名单不过）——HTTP 层映射 400。
type invalidSegmentsErr struct{ msg string }

func (e invalidSegmentsErr) Error() string { return e.msg }

func IsInvalidSegments(err error) bool {
	var segErr invalidSegmentsErr
	return errors.As(err, &segErr)
}

func isInvalidSegments(err error) bool {
	return IsInvalidSegments(err)
}

func AssertSafeArchiveSegments(owner, repo, sha string) error {
	if !IsSafeSegment(owner) || !IsSafeSegment(repo) {
		return invalidSegmentsErr{msg: fmt.Sprintf("invalid owner/repo segment: %s/%s", owner, repo)}
	}
	if !shaRE.MatchString(sha) {
		return invalidSegmentsErr{msg: fmt.Sprintf("invalid sha segment: %s", sha)}
	}
	return nil
}

func assertSafeArchiveSegments(owner, repo, sha string) error {
	return AssertSafeArchiveSegments(owner, repo, sha)
}

// ArchiveMeta 与 tarball-meta.ts 的 ArchiveMeta 字段一一对应（JSON 兼容，
// Node/admin 的 readTarballCacheStats 直读同一文件）。
type ArchiveMeta struct {
	Owner     string `json:"owner"`
	Repo      string `json:"repo"`
	Sha       string `json:"sha"`
	Size      int64  `json:"size"`
	Hits      int64  `json:"hits"`
	LastHitAt int64  `json:"lastHitAt"`
	CreatedAt int64  `json:"createdAt"`
	Compacted bool   `json:"compacted,omitempty"`
}

type MetaStore map[string]ArchiveMeta

// metaStoreRegistry 同路径管理器注册表：EnsureService 与 SweepArchiveCache
// 各自 NewMetaStore 时返回同一实例，消除跨实例整文件 last-writer-wins
// 丢失更新（sweep 删除的条目被另一实例的陈旧快照复活）。
var (
	metaStoreRegistryMu sync.Mutex
	metaStoreRegistry   = map[string]*MetaStoreManager{}
)

// MetaStoreManager 进程内串行化的读-改-写。首次访问后元数据常驻内存，
// Update 只改内存 + 置脏，30s 防抖合并刷盘（tmp + rename 原子替换）——
// 此前每次缓存命中都整文件读盘+写盘，且锁内文件 I/O 串行化全部命中。
// 磁盘文件仍是唯一事实源（Node/admin 直读），滞后窗口 ≤30s。
type MetaStoreManager struct {
	mu      sync.Mutex
	path    string
	store   MetaStore
	dirty   bool
	flushTk *time.Timer
}

type metaStore = MetaStoreManager

// metaFlushDebounce 脏数据合并刷盘窗口。
const metaFlushDebounce = 30 * time.Second

func NewMetaStore(storageRoot string) *MetaStoreManager {
	if storageRoot == "" {
		storageRoot = "storage/repos"
	}
	path := filepath.Join(storageRoot, "metadata.json")
	metaStoreRegistryMu.Lock()
	defer metaStoreRegistryMu.Unlock()
	if m, ok := metaStoreRegistry[path]; ok {
		return m
	}
	m := &MetaStoreManager{path: path}
	metaStoreRegistry[path] = m
	return m
}

func newMetaStore(storageRoot string) *metaStore {
	return NewMetaStore(storageRoot)
}

// Load 返回内存态的独立快照副本（调用方可能在无锁状态下迭代）。
func (m *MetaStoreManager) Load() (MetaStore, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	store, err := m.loadLocked()
	if err != nil {
		return nil, err
	}
	cp := make(MetaStore, len(store))
	for k, v := range store {
		cp[k] = v
	}
	return cp, nil
}

// loadLocked 首次访问从磁盘装载，此后常驻内存（调用方须持锁）。
func (m *MetaStoreManager) loadLocked() (MetaStore, error) {
	if m.store != nil {
		return m.store, nil
	}
	raw, err := os.ReadFile(m.path)
	if err != nil {
		if os.IsNotExist(err) {
			m.store = MetaStore{}
			return m.store, nil
		}
		return nil, err
	}
	var meta MetaStore
	if err := json.Unmarshal(raw, &meta); err != nil {
		meta = MetaStore{}
	}
	if meta == nil {
		meta = MetaStore{}
	}
	m.store = meta
	return m.store, nil
}

func (m *MetaStoreManager) load() (MetaStore, error) {
	return m.Load()
}

// Update 读-改-写内存态；fn 返回 true 时置脏并调度防抖刷盘。
// 注意 fn 收到的是常驻内存 map 本体（与旧版每次 Load 新 map 不同），
// fn 内不得长期持有该 map 引用。
func (m *MetaStoreManager) Update(fn func(meta MetaStore) bool) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	meta, err := m.loadLocked()
	if err != nil {
		return err
	}
	if !fn(meta) {
		return nil
	}
	m.dirty = true
	if m.flushTk == nil {
		m.flushTk = time.AfterFunc(metaFlushDebounce, func() { _ = m.Flush() })
	}
	return nil
}

func (m *MetaStoreManager) update(fn func(meta MetaStore) bool) error {
	return m.Update(fn)
}

// Flush 立即落盘脏元数据（sweep/磁盘预检前与进程退出时调用）。
func (m *MetaStoreManager) Flush() error {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.flushLocked()
}

func (m *MetaStoreManager) flushLocked() error {
	if !m.dirty {
		return nil
	}
	if m.flushTk != nil {
		m.flushTk.Stop()
		m.flushTk = nil
	}
	raw, err := json.MarshalIndent(m.store, "", "  ")
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(m.path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(m.path), "metadata.json.tmp-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err := tmp.Write(raw); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmpName, m.path); err != nil {
		return err
	}
	m.dirty = false
	return nil
}

// EnsureService 归档下载解压域服务：Singleflight + 负缓存时间盒 + 原子替换 + 三级体积熔断。
type EnsureService struct {
	cfg                Config
	meta               *MetaStoreManager
	http               *http.Client
	mu                 sync.Mutex
	calls              map[string]*archiveCall
	timedOut           map[string]time.Time // 负缓存：兼记时间盒超时与超限跳过（超配额/ZipBomb）的仓库 key，避免重复空等与重试带宽浪费
	timedOutCaps       map[string]int64     // 记录超限跳过时的 cap 上限；更宽配额允许穿透重试
	lastTimedOutSweep  time.Time
	startupOnce        sync.Once
	activeKeysProvider func(ctx context.Context) map[string]bool
}

type ArchiveEnsureService = EnsureService

type archiveCall struct {
	done      chan struct{}
	dir       string
	fromCache bool
	err       error
	mu        sync.Mutex
	callbacks []ProgressCallback
}

func (c *archiveCall) addCallback(cb ProgressCallback) {
	if cb == nil {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.callbacks = append(c.callbacks, cb)
}

func (c *archiveCall) broadcast(p Progress) {
	c.mu.Lock()
	if len(c.callbacks) == 0 {
		c.mu.Unlock()
		return
	}
	cbs := make([]ProgressCallback, len(c.callbacks))
	copy(cbs, c.callbacks)
	c.mu.Unlock()
	for _, cb := range cbs {
		if cb == nil {
			continue
		}
		func() {
			defer func() {
				_ = recover()
			}()
			cb(p)
		}()
	}
}

const (
	archiveTimeoutMemo    = 5 * time.Minute
	maxTimedOutEntries    = 2048
	timedOutSweepInterval = 1 * time.Minute
)

// zipBombSentinelCap zip-bomb 跳过的负缓存 sentinel：任何有效配额宽度
// （effectiveCap <= MaxInt64 恒成立）都小于它，即全配额封锁——膨胀率违规
// 与配额无关，更宽配额的重试只会在同一个炸弹上再烧一遍下载带宽。
const zipBombSentinelCap = int64(math.MaxInt64)

func NewEnsureService(cfg Config) *EnsureService {
	root := cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
		cfg.ArchiveRoot = root
	}
	if cfg.EntryCapBytes <= 0 {
		cfg.EntryCapBytes = 50 * 1024 * 1024
	}
	if cfg.ArchiveDownloadTimeoutMs <= 0 {
		cfg.ArchiveDownloadTimeoutMs = 60000
	}
	if cfg.MinFreeDiskMB <= 0 {
		cfg.MinFreeDiskMB = ReadMinFreeDiskMB()
	}
	if cfg.GitHubAPIBase == "" {
		cfg.GitHubAPIBase = "https://api.github.com"
	}
	if cfg.UserAgent == "" {
		cfg.UserAgent = "worker-sidecar"
	}
	return &EnsureService{
		cfg:      cfg,
		meta:     NewMetaStore(root),
		calls:    make(map[string]*archiveCall),
		timedOut: make(map[string]time.Time),
		http: &http.Client{
			Transport: &http.Transport{
				MaxIdleConns:       10,
				IdleConnTimeout:    90 * time.Second,
				DisableCompression: true,
			},
		},
	}
}

// SetActiveKeysProvider 注入活跃键获取回调（供磁盘预检触发主动清扫时保护活跃归档）。
// FlushMeta 刷盘脏元数据（进程优雅退出前调用，防抖窗口内的更新落盘）。
func (s *EnsureService) FlushMeta() { _ = s.meta.Flush() }

func (s *EnsureService) SetActiveKeysProvider(fn func(ctx context.Context) map[string]bool) {	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeKeysProvider = fn
}


// Ensure 确保归档存在：缓存命中直接返回；未命中则下载 tarball 解压（单飞）。
// 返回 dir 空串表示超限跳过或超时；timeBoxedErr 触发 5 分钟负缓存。
func (s *EnsureService) Ensure(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string) (string, bool, error) {
	return s.EnsureWithCap(ctx, owner, repo, sha, sizeHintBytes, token, 0)
}

// EnsureWithProgress 带有实时进度监听回调的 EnsureWithCap 入口。
func (s *EnsureService) EnsureWithProgress(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string, maxCapBytes int64, onProgress ProgressCallback, prefixScope ...string) (string, bool, error) {
	if onProgress != nil {
		ctx = WithProgress(ctx, onProgress)
	}
	return s.EnsureWithCap(ctx, owner, repo, sha, sizeHintBytes, token, maxCapBytes, prefixScope...)
}

// EnsureWithCap 带有动态配额上限的 Ensure（支持根据信誉梯队动态调整解压配额，以及子卷 prefixScope 定向解压）。
func (s *EnsureService) EnsureWithCap(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string, maxCapBytes int64, prefixScope ...string) (string, bool, error) {
	s.startupOnce.Do(func() {
		s.cleanupOrphanTmpDirs()
		s.normalizeLegacyCaseDirs()
	})

	if err := AssertSafeArchiveSegments(owner, repo, sha); err != nil {
		return "", false, err
	}

	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	effectiveCap := maxCapBytes
	if effectiveCap <= 0 {
		effectiveCap = s.cfg.EntryCapBytes
	}

	cb := ProgressFromContext(ctx)
	allowedFiles := AllowedFilesFromContext(ctx)
	key := archiveKeyWithAllowed(owner, repo, sha, scope, allowedFiles)

	// 负缓存：时间盒超时与超限跳过（超配额/ZipBomb）后短期记住「归档不可用」，避免重复空等与重试带宽浪费
	s.mu.Lock()
	now := time.Now()
	if now.Sub(s.lastTimedOutSweep) >= timedOutSweepInterval {
		s.sweepTimedOutLocked(now)
	}
	if ts, ok := s.timedOut[key]; ok {
		if now.Sub(ts) < archiveTimeoutMemo {
			skippedCap := s.timedOutCaps[key]
			if skippedCap == 0 || effectiveCap <= skippedCap {
				s.mu.Unlock()
				return "", false, nil
			}
		} else {
			delete(s.timedOut, key)
			delete(s.timedOutCaps, key)
		}
	}
	fullKey := archiveKey(owner, repo, sha)
	if scope != "" || len(allowedFiles) > 0 {
		if pendingFull, ok := s.calls[fullKey]; ok {
			if cb != nil {
				pendingFull.addCallback(cb)
			}
			s.mu.Unlock()
			select {
			case <-pendingFull.done:
				return pendingFull.dir, pendingFull.fromCache, pendingFull.err
			case <-ctx.Done():
				return "", false, ctx.Err()
			}
		}
	}
	if pending, ok := s.calls[key]; ok {
		if cb != nil {
			pending.addCallback(cb)
		}
		s.mu.Unlock()
		select {
		case <-pending.done:
			return pending.dir, pending.fromCache, pending.err
		case <-ctx.Done():
			return "", false, ctx.Err()
		}
	}
	c := &archiveCall{done: make(chan struct{})}
	if cb != nil {
		c.addCallback(cb)
	}
	s.calls[key] = c
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.calls, key)
		s.mu.Unlock()
		close(c.done)
	}()

	dir, fromCache, err := s.ensureSlow(ctx, owner, repo, sha, sizeHintBytes, token, maxCapBytes, scope, c.broadcast)
	if err == nil {
		if dir == "" {
			// 超限跳过路径（sizeHint > cap 或 errArchiveSkipped）：
			// 写入 timedOut 负缓存，避免超配额仓每次重试反复全量下载解压烧带宽/GitHub 配额
			s.mu.Lock()
			s.recordTimedOutLocked(key, time.Now(), effectiveCap)
			s.mu.Unlock()
			c.dir, c.fromCache, c.err = "", false, nil
			return "", false, nil
		}
		s.mu.Lock()
		delete(s.timedOut, key)
		delete(s.timedOutCaps, key)
		s.mu.Unlock()
	} else if errors.Is(err, errZipBombDetected) {
		// zip-bomb：膨胀率违规与配额宽度无关——任何更宽配额的重试都注定再解压一次
		// 炸弹纯烧带宽。sentinel cap 使负缓存对全部配额宽度封锁（仅 memo 过期解封）。
		s.mu.Lock()
		s.recordTimedOutLocked(key, time.Now(), zipBombSentinelCap)
		s.mu.Unlock()
		c.dir, c.fromCache, c.err = "", false, nil
		return "", false, nil
	} else {
		var tb timeBoxedErr
		if errors.As(err, &tb) {
			if errors.Is(tb.cause, context.DeadlineExceeded) {
				s.mu.Lock()
				s.recordTimedOutLocked(key, time.Now(), 0)
				s.mu.Unlock()
				c.dir, c.fromCache, c.err = "", false, nil
				return "", false, nil
			}
			c.dir, c.fromCache, c.err = "", false, tb.cause
			return "", false, tb.cause
		}
	}
	c.dir, c.fromCache, c.err = dir, fromCache, err
	return dir, fromCache, err
}

// sweepTimedOutLocked 清扫超时的负缓存记录（调用方须持 s.mu 锁）。
func (s *EnsureService) sweepTimedOutLocked(now time.Time) int {
	s.lastTimedOutSweep = now
	purged := 0
	for k, ts := range s.timedOut {
		if now.Sub(ts) >= archiveTimeoutMemo {
			delete(s.timedOut, k)
			delete(s.timedOutCaps, k)
			purged++
		}
	}
	return purged
}

// recordTimedOutLocked 记录负缓存键，并执行容量限制与过期淘汰（调用方须持 s.mu 锁）。
// capLimit 语义：>0 = 超限跳过（记录当时的配额上限，仅更宽配额可穿透重试）；
// = zipBombSentinelCap = zip-bomb（任何配额宽度都封锁，膨胀率违规与 cap 无关）；
// =0 = 时间盒超时（无上限语义，memo 窗口内任意配额均拦截）。
func (s *EnsureService) recordTimedOutLocked(key string, now time.Time, capLimit int64) {
	limit := capLimit
	if s.timedOut == nil {
		s.timedOut = make(map[string]time.Time)
	}
	if s.timedOutCaps == nil {
		s.timedOutCaps = make(map[string]int64)
	}
	// 定期或容量达到上限时主动清扫过期条目
	if len(s.timedOut) >= maxTimedOutEntries || now.Sub(s.lastTimedOutSweep) >= timedOutSweepInterval {
		s.sweepTimedOutLocked(now)
	}
	// 清理后若仍达到容量上限，按 FIFO 逐个淘汰时间最旧的负缓存条目
	for len(s.timedOut) >= maxTimedOutEntries {
		var oldestKey string
		var oldestTime time.Time
		first := true
		for k, ts := range s.timedOut {
			if first || ts.Before(oldestTime) {
				oldestKey = k
				oldestTime = ts
				first = false
			}
		}
		if oldestKey == "" {
			break
		}
		delete(s.timedOut, oldestKey)
		delete(s.timedOutCaps, oldestKey)
	}
	s.timedOut[key] = now
	if limit > 0 {
		s.timedOutCaps[key] = limit
	} else {
		delete(s.timedOutCaps, key)
	}
}

func (s *EnsureService) ArchiveDirFor(owner, repo, sha string) (string, error) {
	if err := AssertSafeArchiveSegments(owner, repo, sha); err != nil {
		return "", err
	}
	root := s.cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
	}
	return ArchiveDirFor(root, owner, repo, sha), nil
}

func (s *EnsureService) archiveDirFor(owner, repo, sha string) (string, error) {
	return s.ArchiveDirFor(owner, repo, sha)
}

func (s *EnsureService) ensureSlow(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string, maxCapBytes int64, scope string, onProgress ProgressCallback) (string, bool, error) {
	finalDir, err := s.ArchiveDirFor(owner, repo, sha)
	if err != nil {
		return "", false, err
	}

	allowedFiles := AllowedFilesFromContext(ctx)
	if st, err := os.Stat(finalDir); err == nil && st.IsDir() {
		if isArchiveCovered(finalDir, scope, allowedFiles) {
			// 缓存命中：hits+1；元数据缺失（崩溃残留）则补登
			now := time.Now().UnixMilli()
			_ = s.meta.Update(func(meta MetaStore) bool {
				if entry, ok := meta[archiveKey(owner, repo, sha)]; ok {
					entry.Hits++
					entry.LastHitAt = now
					meta[archiveKey(owner, repo, sha)] = entry
					return true
				}
				size, err := computeArchiveDirSize(finalDir)
				if err != nil {
					return false
				}
				meta[archiveKey(owner, repo, sha)] = ArchiveMeta{
					Owner: owner, Repo: repo, Sha: sha,
					Size: size, Hits: 1, LastHitAt: now, CreatedAt: now,
				}
				return true
			})
			log.Printf("[archive-ensure] cache hit: %s/%s@%s (scope=%q)", owner, repo, sha, scope)
			if onProgress != nil {
				onProgress(Progress{
					Percent:        100.0,
					SpeedFormatted: "cached",
					CurrentFile:    "cached",
				})
			}
			return finalDir, true, nil
		}
	}

	// 探测收卷态单文件（finalDir + ".tar.gz"）
	compactPath := CompactArchivePathFor(s.cfg.ArchiveRoot, owner, repo, sha)
	if cst, cerr := os.Stat(compactPath); cerr == nil && !cst.IsDir() {
		log.Printf("[archive-ensure] found compact archive, decompacting: %s/%s@%s", owner, repo, sha)
		if decompDir, err := DecompactArchive(ctx, s.cfg.ArchiveRoot, owner, repo, sha); err == nil {
			finalDir = decompDir
			if isArchiveCovered(finalDir, scope, allowedFiles) {
				now := time.Now().UnixMilli()
				_ = s.meta.Update(func(meta MetaStore) bool {
					if entry, ok := meta[archiveKey(owner, repo, sha)]; ok {
						entry.Hits++
						entry.LastHitAt = now
						entry.Compacted = false
						meta[archiveKey(owner, repo, sha)] = entry
						return true
					}
					size, err := computeArchiveDirSize(finalDir)
					if err != nil {
						return false
					}
					meta[archiveKey(owner, repo, sha)] = ArchiveMeta{
						Owner: owner, Repo: repo, Sha: sha,
						Size: size, Hits: 1, LastHitAt: now, CreatedAt: now,
						Compacted: false,
					}
					return true
				})
				log.Printf("[archive-ensure] cache hit (decompacted): %s/%s@%s", owner, repo, sha)
				if onProgress != nil {
					onProgress(Progress{
						Percent:        100.0,
						SpeedFormatted: "cached",
						CurrentFile:    "cached",
					})
				}
				return finalDir, true, nil
			}
			log.Printf("[archive-ensure] decompacted archive does not cover requested scope %q or allowed files: %s/%s@%s", scope, owner, repo, sha)
		} else {
			if errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) || ctx.Err() != nil {
				return "", false, err
			}
			log.Printf("[archive-ensure] decompact failed for %s/%s@%s: %v, removing corrupt archive and falling back to download", owner, repo, sha, err)
			_ = os.Remove(compactPath)
		}
	}

	// 1. 宿主机磁盘可用空间预检熔断：低于安全阈值先强触发清扫，若仍不足则 Fail-Closed 绝不撑爆物理盘
	minFreeMB := int64(s.cfg.MinFreeDiskMB)
	var activeKeys map[string]bool
	s.mu.Lock()
	keyFn := s.activeKeysProvider
	s.mu.Unlock()
	if keyFn != nil {
		activeKeys = keyFn(ctx)
	}
	if _, err := EnsureDiskSpaceForArchive(ctx, s.cfg.ArchiveRoot, minFreeMB, activeKeys); err != nil {
		log.Printf("[archive-ensure] aborted download for %s/%s@%s: %v", owner, repo, sha, err)
		return "", false, err
	}

	effectiveCap := maxCapBytes
	if effectiveCap <= 0 {
		effectiveCap = s.cfg.EntryCapBytes
	}

	// 2. 下载前体积预检（显式 hint）：注定超 cap 的仓库不发起下载（白名单定向解压模式不预先阻断）
	if len(allowedFiles) == 0 && sizeHintBytes > 0 && sizeHintBytes > effectiveCap {
		return "", false, nil
	}

	dir, err := s.downloadAndExtract(ctx, owner, repo, sha, token, effectiveCap, scope, sizeHintBytes, onProgress)
	if errors.Is(err, errArchiveSkipped) {
		return "", false, nil
	}
	// zip-bomb 以 error 形态上抛：EnsureWithCap 据此记 sentinel cap（全配额封锁），
	// 与超限跳过（按配额宽度可穿透重试）分流。
	return dir, false, err
}

func (s *EnsureService) downloadAndExtract(ctx context.Context, owner, repo, sha, token string, effectiveCap int64, scope string, sizeHintBytes int64, onProgress ProgressCallback) (string, error) {
	if _, hasDeadline := ctx.Deadline(); !hasDeadline {
		timeout := time.Duration(s.cfg.ArchiveDownloadTimeoutMs) * time.Millisecond
		if timeout <= 0 {
			timeout = 60 * time.Second
		}
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	finalDir, err := s.ArchiveDirFor(owner, repo, sha)
	if err != nil {
		return "", err
	}
	tmpDir := fmt.Sprintf("%s.tmp-%d-%s", finalDir, time.Now().UnixMilli(), randomArchiveSuffix())
	if err := os.MkdirAll(tmpDir, 0o755); err != nil {
		return "", err
	}

	err = s.downloadExtractInto(ctx, owner, repo, sha, token, tmpDir, effectiveCap, sizeHintBytes, onProgress, scope)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}

	allowedFiles := AllowedFilesFromContext(ctx)
	isScoped := scope != "" || len(allowedFiles) > 0
	if isScoped {
		markerContent := scope
		if len(allowedFiles) > 0 {
			if markerContent != "" {
				markerContent += "\n"
			}
			markerContent += "outline:" + hashAllowedFiles(allowedFiles)
		}
		_ = os.WriteFile(filepath.Join(tmpDir, scopedMarkerFile), []byte(markerContent+"\n"), 0o644)
	}

	size, err := computeArchiveDirSize(tmpDir)
	if err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}
	if size > effectiveCap {
		_ = os.RemoveAll(tmpDir)
		return "", errArchiveSkipped
	}

	if err := os.MkdirAll(filepath.Dir(finalDir), 0o755); err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}
	if err := mergeOrRenameInto(tmpDir, finalDir, isScoped); err != nil {
		_ = os.RemoveAll(tmpDir)
		return "", err
	}

	now := time.Now().UnixMilli()
	_ = s.meta.Update(func(meta MetaStore) bool {
		meta[archiveKey(owner, repo, sha)] = ArchiveMeta{
			Owner: owner, Repo: repo, Sha: sha,
			Size: size, Hits: 0, LastHitAt: now, CreatedAt: now,
		}
		return true
	})
	log.Printf("[archive-ensure] extracted archive for %s/%s@%s (scope=%q, %d bytes, cap=%d)", owner, repo, sha, scope, size, effectiveCap)
	return finalDir, nil
}

// downloadExtractInto 下载 GitHub tarball 并流式解压到 destDir：
// - strip 1 去掉 "{owner}-{repo}-{sha}" 根目录
// - 条目逐段白名单校验（拒绝 "."/".."、反斜杠、盘符等一切越界形态）
// - Content-Length 预检 + 解压累计体积封顶（双保险）
// - 定向子卷前缀过滤（prefixScope）：仅放行目标子卷路径下的文件，以及根构建清单与根 README
func (s *EnsureService) downloadExtractInto(ctx context.Context, owner, repo, sha, token, destDir string, effectiveCap int64, sizeHintBytes int64, onProgress ProgressCallback, prefixScope ...string) error {
	var scope string
	if len(prefixScope) > 0 {
		scope = strings.Trim(filepath.ToSlash(prefixScope[0]), "/ ")
	}

	url := fmt.Sprintf("%s/repos/%s/%s/tarball/%s", s.cfg.GitHubAPIBase, pathEscape(owner), pathEscape(repo), pathEscape(sha))
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", s.cfg.UserAgent)
	effectiveToken := token
	if effectiveToken == "" {
		effectiveToken = s.cfg.GitHubToken
	}
	if effectiveToken != "" {
		req.Header.Set("Authorization", "Bearer "+effectiveToken)
	}

	resp, err := s.http.Do(req)
	if err != nil || resp.StatusCode != http.StatusOK {
		// 如果是官方 GitHub 且未认证导致 429/403/失败，尝试走免鉴权 codeload 直连下载
		if (s.cfg.GitHubAPIBase == "https://api.github.com" || s.cfg.GitHubAPIBase == "") && effectiveToken == "" {
			if resp != nil {
				resp.Body.Close()
			}
			codeloadURL := fmt.Sprintf("https://codeload.github.com/%s/%s/tar.gz/%s", pathEscape(owner), pathEscape(repo), pathEscape(sha))
			clReq, clErr := http.NewRequestWithContext(ctx, http.MethodGet, codeloadURL, nil)
			if clErr == nil {
				clReq.Header.Set("User-Agent", s.cfg.UserAgent)
				clResp, doErr := s.http.Do(clReq)
				if doErr == nil && clResp.StatusCode == http.StatusOK {
					resp = clResp
					err = nil
				} else if clResp != nil {
					clResp.Body.Close()
				}
			}
		}
	}
	if err != nil {
		if ctx.Err() != nil {
			return timeBoxedErr{cause: ctx.Err()}
		}
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("github tarball %s/%s@%s: HTTP %d", owner, repo, sha, resp.StatusCode)
	}

	allowedFiles := AllowedFilesFromContext(ctx)

	// 2. Content-Length 预检：归档明显超限时直接放弃（白名单定向解压模式不预先阻断）
	if cl := resp.ContentLength; cl > 0 && cl > effectiveCap {
		if len(allowedFiles) == 0 {
			return errArchiveSkipped
		}
	}

	tracker := NewProgressTracker(resp.ContentLength, sizeHintBytes, onProgress)
	pr := newProgressReader(resp.Body, tracker)
	gzr, err := gzip.NewReader(pr)
	if err != nil {
		return fmt.Errorf("gzip: %w", err)
	}
	defer gzr.Close()

	var extracted int64
	tr := tar.NewReader(gzr)
	cleanDestDir := filepath.Clean(destDir)

	for {
		header, err := tr.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			if ctx.Err() != nil {
				return timeBoxedErr{cause: ctx.Err()}
			}
			return fmt.Errorf("tar: %w", err)
		}
		if header.Typeflag != tar.TypeReg && header.Typeflag != tar.TypeDir {
			continue
		}

		// 拦截高危非代码扩展名（模型权重、光盘镜像、压缩包套娃、视音频），流式直接跳过不落盘
		if header.Typeflag == tar.TypeReg {
			ext := strings.ToLower(filepath.Ext(header.Name))
			if _, isIgnored := IgnoredPayloadExts[ext]; isIgnored {
				continue
			}
		}

		// tar 路径用 `/` 分隔；strip 1 去掉根目录
		cleanName := strings.TrimPrefix(strings.TrimSuffix(header.Name, "/"), "/")
		parts := strings.Split(cleanName, "/")
		if len(parts) < 2 {
			continue
		}
		rel := parts[1:]

		// 条目白名单：每段必须通过字符集白名单且不是 "."/".."；
		// 白名单天然拒绝 `\`、`:`、`/`，无需黑名单（也放行 a..b.md 这类合法名）
		if !safeTarSegments(rel) {
			continue
		}

		relPath := strings.Join(rel, "/")

		// 定向子卷前缀过滤（Scoped Unpack）与大纲白名单定向解压（Selective Unpack）：
		if len(allowedFiles) > 0 {
			if header.Typeflag == tar.TypeDir {
				if !isAllowedDir(relPath, allowedFiles) {
					continue
				}
			} else {
				if !isPathInAllowedFiles(relPath, allowedFiles) && !isGlobalManifest(relPath) {
					continue // 关键：在 tar 数据流中直接跳过，零磁盘写、零 inode 占用、零配额消耗！
				}
			}
		} else if scope != "" {
			if header.Typeflag == tar.TypeDir {
				if !isSubvolumeOrParent(relPath, scope) {
					continue
				}
			} else {
				isTargetSubvolume := strings.HasPrefix(relPath+"/", scope+"/")
				isGlobal := isGlobalManifest(relPath)
				if !isTargetSubvolume && !isGlobal {
					continue // 关键：在 tar 数据流中直接跳过，零磁盘写、零 inode 占用！
				}
			}
		}

		target := filepath.Join(cleanDestDir, filepath.FromSlash(relPath))

		// 兜底：目标必须严格处于 destDir 之下（防御 Join 的平台特例）
		relToDest, err := filepath.Rel(cleanDestDir, filepath.Clean(target))
		if err != nil || relToDest == "." || filepath.IsAbs(relToDest) || strings.HasPrefix(relToDest, "..") {
			continue
		}

		remainingCap := effectiveCap - extracted
		if remainingCap <= 0 {
			return errArchiveSkipped
		}
		if header.Size > 0 && header.Size > remainingCap {
			return errArchiveSkipped
		}

		tracker.SetCurrentFile(relPath)

		if header.Typeflag == tar.TypeDir {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
		if err != nil {
			return err
		}
		// 3. io.LimitReader 封顶单 entry 到剩余额度 + 1：流式解压超限立即中止并清理 tmp
		n, err := io.Copy(f, io.LimitReader(tr, remainingCap+1))
		closeErr := f.Close()
		if err != nil {
			if ctx.Err() != nil {
				return timeBoxedErr{cause: ctx.Err()}
			}
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		extracted += n
		tracker.AddExtracted(n)
		tracker.IncrementFiles()
		if extracted > effectiveCap {
			return errArchiveSkipped
		}

		// Zip Bomb 防御：解压数据超过 5MB 后，若解压体积与读取的压缩体积比持续大于 30 倍，判定为压缩炸弹
		if extracted > 5*1024*1024 && pr.TotalRead() > 0 {
			expansionRatio := float64(extracted) / float64(pr.TotalRead())
			if expansionRatio > 30.0 {
				return errZipBombDetected
			}
		}
	}

	tracker.Finish()
	return nil
}

// ComputeArchiveDirSize 计算指定目录所有常规文件的字节总和。
func ComputeArchiveDirSize(dir string) (int64, error) {
	return computeArchiveDirSize(dir)
}

func computeArchiveDirSize(dir string) (int64, error) {
	var total int64
	err := filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		return nil
	})
	return total, err
}

// cleanupOrphanTmpDirs 启动清扫：删除归档树下遗留的 `.tmp-*` 孤儿目录及临时元数据文件。
func (s *EnsureService) cleanupOrphanTmpDirs() {
	root := s.cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
	}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil // fail-soft
		}
		if d.IsDir() && p != root && (strings.Contains(d.Name(), ".tmp-") || strings.HasSuffix(d.Name(), ".tmp")) {
			if err := os.RemoveAll(p); err == nil {
				fmt.Fprintf(os.Stderr, "[worker-sidecar] startup cleanup removed orphan tmp dir %s\n", p)
			}
			return filepath.SkipDir
		}
		if !d.IsDir() && (strings.HasPrefix(d.Name(), "metadata.json.tmp-") || strings.HasSuffix(d.Name(), ".tmp") || strings.Contains(d.Name(), ".tmp-")) {
			if err := os.Remove(p); err == nil {
				fmt.Fprintf(os.Stderr, "[worker-sidecar] startup cleanup removed orphan tmp file %s\n", p)
			}
		}
		return nil
	})
}

// ArchiveDirFor formats the archive directory path ({owner}/{repo}/{sha}).
func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, strings.ToLower(owner), strings.ToLower(repo), sha)
}

// normalizeLegacyCaseDirs 启动清扫：归档键/目录统一小写口径（archiveKey 与
// ArchiveDirFor 已归一）后，历史混合大小写落盘目录永远无法被命中——原地重命名
// 为小写（目标不存在时），目标已存在则删除混合大小写副本（小写份是归一后新下载
// 的有效副本）；顺带把 meta 键归一到 archiveKey 口径，杜绝孤儿键累计。
// 与 cleanupOrphanTmpDirs 同在 startupOnce 内执行：此刻无任何在途归档，重命名安全。
func (s *EnsureService) normalizeLegacyCaseDirs() {
	root := s.cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
	}
	renamed, removed := 0, 0

	ownerEntries, err := os.ReadDir(root)
	if err != nil {
		return // 归档根不存在：空仓冷启动，无事可做
	}
	for _, oe := range ownerEntries {
		if !oe.IsDir() {
			continue
		}
		ownerDir := filepath.Join(root, oe.Name())
		lowerOwner := strings.ToLower(oe.Name())
		repoEntries, err := os.ReadDir(ownerDir)
		if err != nil {
			continue
		}
		for _, re := range repoEntries {
			if !re.IsDir() {
				continue
			}
			src := filepath.Join(ownerDir, re.Name())
			lowerRepo := strings.ToLower(re.Name())
			dst := filepath.Join(root, lowerOwner, lowerRepo)
			if src == dst {
				continue
			}
			srcStat, srcErr := os.Stat(src)
			if srcErr != nil {
				continue
			}
			dstStat, dstErr := os.Stat(dst)
			if dstErr == nil {
				if os.SameFile(srcStat, dstStat) {
					// 大小写不敏感文件系统（macOS APFS 默认/共享卷）：dst 与 src 本就是
					// 同一物理目录——小写路径天然可命中，重命名/删除都属破坏性误操作
					continue
				}
				// 真实的小写目标已存在（归一后新下载的有效副本）：混合大小写份成孤儿，直接回收
				if err := os.RemoveAll(src); err == nil {
					removed++
				}
				continue
			}
			if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
				continue
			}
			if err := os.Rename(src, dst); err == nil {
				renamed++
			}
		}
		// owner 目录下已无子目录时回收空壳（空目录在大小写敏感/不敏感 FS 上删除均安全：
		// 不敏感 FS 上它与小写路径同一物理目录，但既已无内容，移除即无害清理）
		if leftover, err := os.ReadDir(ownerDir); err == nil && len(leftover) == 0 && oe.Name() != lowerOwner {
			_ = os.Remove(ownerDir)
		}
	}

	// meta 键归一：旧键（原始大小写拼接）重写到 archiveKey 口径
	_ = s.meta.Update(func(meta MetaStore) bool {
		changed := false
		for key, entry := range meta {
			normalized := archiveKey(entry.Owner, entry.Repo, entry.Sha)
			if normalized == key {
				continue
			}
			if _, exists := meta[normalized]; exists {
				delete(meta, key) // 归一键已有在册条目：旧键弃用（磁盘目录已同步回收/重命名）
			} else {
				meta[normalized] = entry
				delete(meta, key)
			}
			changed = true
		}
		return changed
	})

	if renamed > 0 || removed > 0 {
		fmt.Fprintf(os.Stderr, "[worker-sidecar] startup case normalization: renamed %d, removed %d legacy archive dir(s)\n", renamed, removed)
	}
}

func archiveKey(owner, repo, sha string) string {
	return strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + sha
}

func safeTarSegments(rel []string) bool {
	for _, seg := range rel {
		if !IsSafeSegment(seg) {
			return false
		}
	}
	return true
}

func pathEscape(s string) string {
	return strings.ReplaceAll(strings.ReplaceAll(s, "/", "%2F"), "\\", "%5C")
}

func randomArchiveSuffix() string {
	h := sha256.Sum256([]byte(fmt.Sprintf("%d-%d", time.Now().UnixNano(), os.Getpid())))
	return hex.EncodeToString(h[:])[:6]
}

func archiveKeyWithScope(owner, repo, sha, scope string) string {
	if scope == "" {
		return archiveKey(owner, repo, sha)
	}
	return strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + sha + "#" + strings.ToLower(scope)
}

func hashAllowedFiles(allowedFiles map[string]bool) string {
	if len(allowedFiles) == 0 {
		return ""
	}
	paths := make([]string, 0, len(allowedFiles))
	for p := range allowedFiles {
		clean := strings.Trim(filepath.ToSlash(p), "/ ")
		if clean != "" {
			paths = append(paths, clean)
		}
	}
	sort.Strings(paths)
	h := sha256.New()
	for _, p := range paths {
		h.Write([]byte(p))
		h.Write([]byte{0})
	}
	return hex.EncodeToString(h.Sum(nil))[:12]
}

func archiveKeyWithAllowed(owner, repo, sha, scope string, allowedFiles map[string]bool) string {
	if len(allowedFiles) == 0 {
		return archiveKeyWithScope(owner, repo, sha, scope)
	}
	hashStr := hashAllowedFiles(allowedFiles)
	if scope != "" {
		return strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + sha + "#" + strings.ToLower(scope) + ":outline-" + hashStr
	}
	return strings.ToLower(owner) + "/" + strings.ToLower(repo) + "@" + sha + "#outline-" + hashStr
}

func isAllowedDir(dirRel string, allowedFiles map[string]bool) bool {
	cleanDir := strings.Trim(filepath.ToSlash(dirRel), "/ ")
	if cleanDir == "" {
		return true
	}
	prefix := cleanDir + "/"
	for f := range allowedFiles {
		cleanF := strings.Trim(filepath.ToSlash(f), "/ ")
		if strings.HasPrefix(cleanF, prefix) {
			return true
		}
	}
	return false
}

func isPathInAllowedFiles(relPath string, allowedFiles map[string]bool) bool {
	if allowedFiles[relPath] {
		return true
	}
	clean := strings.Trim(filepath.ToSlash(relPath), "/ ")
	if allowedFiles[clean] {
		return true
	}
	for f := range allowedFiles {
		if strings.Trim(filepath.ToSlash(f), "/ ") == clean {
			return true
		}
	}
	return false
}

func isMainConfigFile(lowerBase string) bool {
	return lowerBase == "package.json" ||
		lowerBase == "package-lock.json" ||
		lowerBase == "pnpm-workspace.yaml" ||
		lowerBase == "pnpm-lock.yaml" ||
		lowerBase == "yarn.lock" ||
		lowerBase == "bun.lockb" ||
		lowerBase == "turbo.json" ||
		lowerBase == "lerna.json" ||
		lowerBase == "tsconfig.json" ||
		lowerBase == "go.mod" ||
		lowerBase == "go.sum" ||
		lowerBase == "go.work" ||
		lowerBase == "cargo.toml" ||
		lowerBase == "cargo.lock" ||
		lowerBase == "cmakelists.txt" ||
		lowerBase == "makefile" ||
		lowerBase == "gnumakefile" ||
		lowerBase == "pyproject.toml" ||
		lowerBase == "requirements.txt" ||
		lowerBase == "setup.py" ||
		lowerBase == "setup.cfg" ||
		lowerBase == "pipfile" ||
		lowerBase == "pipfile.lock" ||
		lowerBase == "pom.xml" ||
		lowerBase == "build.gradle" ||
		lowerBase == "build.gradle.kts" ||
		lowerBase == "settings.gradle" ||
		lowerBase == "settings.gradle.kts" ||
		lowerBase == "pubspec.yaml" ||
		lowerBase == "pubspec.lock" ||
		lowerBase == "gemfile" ||
		lowerBase == "gemfile.lock" ||
		lowerBase == "composer.json" ||
		lowerBase == "composer.lock" ||
		lowerBase == "mix.exs" ||
		lowerBase == "package.swift" ||
		lowerBase == "build.zig" ||
		lowerBase == "dune-project" ||
		lowerBase == "gleam.toml"
}

func isRootReadme(relPath string) bool {
	clean := filepath.ToSlash(relPath)
	if strings.Contains(clean, "/") {
		return false
	}
	lower := strings.ToLower(clean)
	return strings.HasPrefix(lower, "readme")
}

func isRootLicense(relPath string) bool {
	clean := filepath.ToSlash(relPath)
	if strings.Contains(clean, "/") {
		return false
	}
	lower := strings.ToLower(clean)
	return strings.HasPrefix(lower, "license") || strings.HasPrefix(lower, "licence")
}

func isGlobalManifest(relPath string) bool {
	clean := filepath.ToSlash(relPath)
	if strings.Contains(clean, "/") {
		return false
	}
	lower := strings.ToLower(clean)
	return isMainConfigFile(lower) || isRootReadme(clean) || isRootLicense(clean)
}

// isScopeCovered 检查 finalDir 是否已经覆盖请求的 scope。
// 规则：
// 1. 若 finalDir 不存在 .scoped_unpack 标记，说明为全量解压目录，必然覆盖任意 scope（包括空串全量）。
// 2. 若存在 .scoped_unpack 标记，说明为局部定向解压目录：
//    - 若请求 scope == ""（全量），必然未被覆盖（返回 false，触发全量解压替换）；
//    - 若请求 scope != ""，读取文件中已记录的全部 scope，若任一条目完全等于请求 scope，
//      或者为请求 scope 的祖先目录（例如已解压 recorded="src"，请求 scope="src/audio"），
//      则判定为已覆盖命中；反之（例如已解压 recorded="src/audio"，请求 scope="src"）绝不虚假命中。
func isScopeCovered(finalDir, scope string) bool {
	markerPath := filepath.Join(finalDir, scopedMarkerFile)
	data, err := os.ReadFile(markerPath)
	if os.IsNotExist(err) {
		return true // 全量归档，覆盖一切子卷
	}
	if err != nil {
		return false
	}
	if scope == "" {
		return false // 局部归档不能充当全量归档
	}
	cleanScope := strings.Trim(filepath.ToSlash(scope), "/ ")
	if cleanScope == "" {
		return false
	}
	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
		recorded := strings.Trim(filepath.ToSlash(line), "/ ")
		if recorded == "" {
			continue
		}
		if recorded == cleanScope || strings.HasPrefix(cleanScope+"/", recorded+"/") {
			return true
		}
	}
	return false
}

// isArchiveCovered 检查 finalDir 是否已经覆盖请求的 scope 或 allowedFiles。
func isArchiveCovered(finalDir, scope string, allowedFiles map[string]bool) bool {
	markerPath := filepath.Join(finalDir, scopedMarkerFile)
	_, err := os.Stat(markerPath)
	if os.IsNotExist(err) {
		return true // 全量归档，覆盖一切子卷与白名单
	}
	if err != nil {
		return false
	}
	if len(allowedFiles) > 0 {
		// 检查白名单中所有有效文件是否均已在 finalDir 中落盘
		for p := range allowedFiles {
			cleanP := strings.Trim(filepath.ToSlash(p), "/ ")
			if cleanP == "" {
				continue
			}
			target := filepath.Join(finalDir, filepath.FromSlash(cleanP))
			if _, statErr := os.Stat(target); statErr != nil {
				return false
			}
		}
		return true
	}
	return isScopeCovered(finalDir, scope)
}

func isSubvolumeOrParent(dirRel, prefixScope string) bool {
	dirRel = strings.Trim(dirRel, "/")
	prefixScope = strings.Trim(prefixScope, "/")
	if dirRel == "" || prefixScope == "" {
		return true
	}
	if strings.HasPrefix(dirRel+"/", prefixScope+"/") {
		return true
	}
	if strings.HasPrefix(prefixScope+"/", dirRel+"/") {
		return true
	}
	return false
}

func mergeOrRenameInto(tmpDir, finalDir string, isScoped bool) error {
	if _, err := os.Stat(finalDir); os.IsNotExist(err) {
		return os.Rename(tmpDir, finalDir)
	}
	if !isScoped {
		// 全量解压替换旧有的局部解压目录
		backup := fmt.Sprintf("%s.old-%d", finalDir, time.Now().UnixMilli())
		if err := os.Rename(finalDir, backup); err == nil {
			if rErr := os.Rename(tmpDir, finalDir); rErr == nil {
				_ = os.RemoveAll(backup)
				return nil
			}
			_ = os.Rename(backup, finalDir)
		}
		if err := os.RemoveAll(finalDir); err == nil {
			return os.Rename(tmpDir, finalDir)
		}
	}
	// 局部定向解压合并入已存在的 finalDir
	// 关键防护：若 finalDir 原本是全量解压目录（无 .scoped_unpack），绝不可将局部标记打上去！
	finalHasMarker := false
	if _, err := os.Stat(filepath.Join(finalDir, scopedMarkerFile)); err == nil {
		finalHasMarker = true
	}
	err := filepath.WalkDir(tmpDir, func(path string, d os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, err := filepath.Rel(tmpDir, path)
		if err != nil || rel == "." {
			return nil
		}
		target := filepath.Join(finalDir, rel)
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}
		if rel == scopedMarkerFile {
			if finalHasMarker {
				if data, rErr := os.ReadFile(path); rErr == nil {
					newScope := strings.TrimSpace(string(data))
					if newScope != "" && !isScopeCovered(finalDir, newScope) {
						f, aErr := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
						if aErr == nil {
							_, _ = f.Write([]byte(newScope + "\n"))
							_ = f.Close()
						}
					}
				}
			}
			return nil
		}
		_ = os.Remove(target)
		return os.Rename(path, target)
	})
	_ = os.RemoveAll(tmpDir)
	return err
}
