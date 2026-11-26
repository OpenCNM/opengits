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

func IsSafeSegment(seg string) bool {
	return pathSegmentRE.MatchString(seg) && seg != "." && seg != ".."
}

func isSafeSegment(seg string) bool {
	return IsSafeSegment(seg)
}

var errArchiveSkipped = errors.New("archive skipped (over cap)")

var errZipBombDetected = errors.New("zip bomb detected: decompression expansion ratio exceeded safe limit (30x)")

const ScopedMarkerFile = ".scoped_unpack"

const scopedMarkerFile = ScopedMarkerFile

var IgnoredPayloadExts = map[string]struct{}{
	".safetensors": {},
	".onnx":        {},
	".weights":     {},
	".pt":          {},
	".pth":         {},
	".h5":          {},
	".ckpt":        {},
	".gguf":        {},
	".tflite":      {},
	".iso":         {},
	".dmg":         {},
	".msi":         {},
	".exe":         {},
	".apk":         {},
	".ipa":         {},
	".tar":         {},
	".gz":          {},
	".zip":         {},
	".7z":          {},
	".rar":         {},
	".bz2":         {},
	".xz":          {},
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

type timeBoxedErr struct{ cause error }

func (e timeBoxedErr) Error() string { return "time-boxed: " + e.cause.Error() }

type allowedFilesContextKey struct{}

func WithAllowedFiles(ctx context.Context, files map[string]bool) context.Context {
	if len(files) == 0 {
		return ctx
	}
	return context.WithValue(ctx, allowedFilesContextKey{}, files)
}

func AllowedFilesFromContext(ctx context.Context) map[string]bool {
	if f, ok := ctx.Value(allowedFilesContextKey{}).(map[string]bool); ok {
		return f
	}
	return nil
}

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

// Share one MetaStoreManager per root path so concurrent ensure/sweep calls never clobber metadata.
var (
	metaStoreRegistryMu sync.Mutex
	metaStoreRegistry   = map[string]*MetaStoreManager{}
)

// Debounce metadata writes for 30s in memory before atomic rename so cache hits avoid lock-held disk I/O.
type MetaStoreManager struct {
	mu      sync.Mutex
	path    string
	store   MetaStore
	dirty   bool
	flushTk *time.Timer
}

type metaStore = MetaStoreManager

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

type EnsureService struct {
	cfg                Config
	meta               *MetaStoreManager
	http               *http.Client
	mu                 sync.Mutex
	calls              map[string]*archiveCall
	timedOut           map[string]time.Time
	timedOutCaps       map[string]int64
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

// Use MaxInt64 sentinel cap for zip-bomb hits so wider quota retries remain blocked within the memo window.
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

func (s *EnsureService) FlushMeta() { _ = s.meta.Flush() }

func (s *EnsureService) SetActiveKeysProvider(fn func(ctx context.Context) map[string]bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.activeKeysProvider = fn
}

func (s *EnsureService) Ensure(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string) (string, bool, error) {
	return s.EnsureWithCap(ctx, owner, repo, sha, sizeHintBytes, token, 0)
}

func (s *EnsureService) EnsureWithProgress(ctx context.Context, owner, repo, sha string, sizeHintBytes int64, token string, maxCapBytes int64, onProgress ProgressCallback, prefixScope ...string) (string, bool, error) {
	if onProgress != nil {
		ctx = WithProgress(ctx, onProgress)
	}
	return s.EnsureWithCap(ctx, owner, repo, sha, sizeHintBytes, token, maxCapBytes, prefixScope...)
}

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

func (s *EnsureService) recordTimedOutLocked(key string, now time.Time, capLimit int64) {
	limit := capLimit
	if s.timedOut == nil {
		s.timedOut = make(map[string]time.Time)
	}
	if s.timedOutCaps == nil {
		s.timedOutCaps = make(map[string]int64)
	}
	if len(s.timedOut) >= maxTimedOutEntries || now.Sub(s.lastTimedOutSweep) >= timedOutSweepInterval {
		s.sweepTimedOutLocked(now)
	}
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

	if len(allowedFiles) == 0 && sizeHintBytes > 0 && sizeHintBytes > effectiveCap {
		return "", false, nil
	}

	dir, err := s.downloadAndExtract(ctx, owner, repo, sha, token, effectiveCap, scope, sizeHintBytes, onProgress)
	if errors.Is(err, errArchiveSkipped) {
		return "", false, nil
	}
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

		if header.Typeflag == tar.TypeReg {
			ext := strings.ToLower(filepath.Ext(header.Name))
			if _, isIgnored := IgnoredPayloadExts[ext]; isIgnored {
				continue
			}
		}

		cleanName := strings.TrimPrefix(strings.TrimSuffix(header.Name, "/"), "/")
		parts := strings.Split(cleanName, "/")
		if len(parts) < 2 {
			continue
		}
		rel := parts[1:]

		if !safeTarSegments(rel) {
			continue
		}

		relPath := strings.Join(rel, "/")

		if len(allowedFiles) > 0 {
			if header.Typeflag == tar.TypeDir {
				if !isAllowedDir(relPath, allowedFiles) {
					continue
				}
			} else {
				if !isPathInAllowedFiles(relPath, allowedFiles) && !isGlobalManifest(relPath) {
					continue
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
					continue
				}
			}
		}

		target := filepath.Join(cleanDestDir, filepath.FromSlash(relPath))

		// Defense-in-depth: verify filepath.Rel stays inside cleanDestDir before opening target.
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
		// Cap tar entry copy at remainingCap+1 via io.LimitReader to abort oversized streams before OOM.
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

		// Require >5MB extracted before 30x zip-bomb ratio check to avoid false positives on small compressed text.
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

func (s *EnsureService) cleanupOrphanTmpDirs() {
	root := s.cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
	}
	_ = filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
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

func ArchiveDirFor(root, owner, repo, sha string) string {
	return filepath.Join(root, strings.ToLower(owner), strings.ToLower(repo), sha)
}

func IsScopedArchiveDir(dir string) bool {
	if strings.TrimSpace(dir) == "" {
		return false
	}
	_, err := os.Stat(filepath.Join(dir, ScopedMarkerFile))
	return err == nil
}

func IsScopedArchive(archiveRoot, owner, repo, sha string) bool {
	if owner == "" || repo == "" || sha == "" {
		return false
	}
	root := archiveRoot
	if root == "" {
		root = "storage/repos"
	}
	return IsScopedArchiveDir(ArchiveDirFor(root, owner, repo, sha)) ||
		IsScopedArchiveDir(filepath.Join(root, owner, repo, sha))
}

func (s *EnsureService) normalizeLegacyCaseDirs() {
	root := s.cfg.ArchiveRoot
	if root == "" {
		root = "storage/repos"
	}
	renamed, removed := 0, 0

	ownerEntries, err := os.ReadDir(root)
	if err != nil {
		return
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
					// Skip case normalization on case-insensitive filesystems (e.g. APFS) where src and dst alias the same directory.
					continue
				}
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
		if leftover, err := os.ReadDir(ownerDir); err == nil && len(leftover) == 0 && oe.Name() != lowerOwner {
			_ = os.Remove(ownerDir)
		}
	}

	_ = s.meta.Update(func(meta MetaStore) bool {
		changed := false
		for key, entry := range meta {
			normalized := archiveKey(entry.Owner, entry.Repo, entry.Sha)
			if normalized == key {
				continue
			}
			if _, exists := meta[normalized]; exists {
				delete(meta, key)
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

func isScopeCovered(finalDir, scope string) bool {
	markerPath := filepath.Join(finalDir, scopedMarkerFile)
	data, err := os.ReadFile(markerPath)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		return false
	}
	if scope == "" {
		return false
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

func isArchiveCovered(finalDir, scope string, allowedFiles map[string]bool) bool {
	markerPath := filepath.Join(finalDir, scopedMarkerFile)
	_, err := os.Stat(markerPath)
	if os.IsNotExist(err) {
		return true
	}
	if err != nil {
		return false
	}
	if len(allowedFiles) > 0 {
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
	// Never add .scoped_unpack marker when merging into an existing full archive directory.
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
