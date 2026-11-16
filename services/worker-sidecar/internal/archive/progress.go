package archive

import (
	"context"
	"fmt"
	"io"
	"math"
	"sync"
	"sync/atomic"
	"time"
)

// Progress 归档拉取与解压实时进度状态快照。
type Progress struct {
	DownloadedBytes int64   `json:"downloadedBytes"` // 已下载压缩字节数
	TotalBytes      int64   `json:"totalBytes"`      // 归档总字节数（ContentLength 或 sizeHint，未知时为 0）
	ExtractedBytes  int64   `json:"extractedBytes"`  // 已解压字节数
	ExtractedFiles  int     `json:"extractedFiles"`  // 已解压文件总数
	CurrentFile     string  `json:"currentFile"`     // 当前正在解压的文件相对路径
	SpeedBps        float64 `json:"speedBps"`        // 平滑后的实时下载速度 (bytes/sec)
	SpeedFormatted  string  `json:"speedFormatted"`  // 格式化速度字符串，例如 "8.2 MB/s"
	Percent         float64 `json:"percent"`         // 进度百分比 (0.0 - 100.0)
}

// ProgressCallback 归档下载与解压进度监听回调。
type ProgressCallback func(p Progress)

type progressCtxKey struct{}

// WithProgress 将进度回调注入 Context。
func WithProgress(ctx context.Context, cb ProgressCallback) context.Context {
	if cb == nil {
		return ctx
	}
	return context.WithValue(ctx, progressCtxKey{}, cb)
}

// ProgressFromContext 从 Context 获取进度回调。
func ProgressFromContext(ctx context.Context) ProgressCallback {
	if ctx == nil {
		return nil
	}
	if cb, ok := ctx.Value(progressCtxKey{}).(ProgressCallback); ok {
		return cb
	}
	return nil
}

// FormatSpeed 将每秒字节数转换为人类可读的速率字符串（例如 "8.2 MB/s"）。
func FormatSpeed(bps float64) string {
	if math.IsNaN(bps) || math.IsInf(bps, 0) || bps <= 0 {
		return "0 B/s"
	}
	const (
		kb = 1024.0
		mb = 1024.0 * kb
		gb = 1024.0 * mb
	)
	switch {
	case bps >= gb:
		return fmt.Sprintf("%.1f GB/s", bps/gb)
	case bps >= mb:
		return fmt.Sprintf("%.1f MB/s", bps/mb)
	case bps >= kb:
		return fmt.Sprintf("%.1f KB/s", bps/kb)
	default:
		return fmt.Sprintf("%.0f B/s", bps)
	}
}

// ProgressTracker 归档流式进度与速度追踪器（线程安全，支持 EMA 平滑降噪）。
type ProgressTracker struct {
	mu             sync.RWMutex
	contentLength  int64
	sizeHintBytes  int64
	downloaded     int64
	extracted      int64
	extractedFiles int
	currentFile    string

	// EMA 速度计算参数
	lastSampleTime  time.Time
	lastSampleBytes int64
	smoothedSpeed   float64
	alpha           float64
	sampleInterval  time.Duration

	// 回调调度
	onProgress     ProgressCallback
	lastNotifyTime time.Time
	notifyInterval time.Duration
	closed         bool
}

// NewProgressTracker 创建进度追踪器。
func NewProgressTracker(contentLength, sizeHintBytes int64, onProgress ProgressCallback) *ProgressTracker {
	return &ProgressTracker{
		contentLength:  contentLength,
		sizeHintBytes:  sizeHintBytes,
		onProgress:     onProgress,
		alpha:          0.25,
		sampleInterval: 200 * time.Millisecond,
		notifyInterval: 250 * time.Millisecond,
	}
}

// UpdateDownloaded 更新已下载压缩字节，并触发速度平滑采样。
func (t *ProgressTracker) UpdateDownloaded(n int64) {
	if n <= 0 {
		return
	}
	t.mu.Lock()
	t.downloaded += n
	now := time.Now()
	t.updateSpeedLocked(now)
	cb, snap, shouldNotify := t.checkNotifyLocked(now, false)
	t.mu.Unlock()

	if shouldNotify && cb != nil {
		cb(snap)
	}
}

// SetCurrentFile 更新当前正在解压的文件路径。
func (t *ProgressTracker) SetCurrentFile(file string) {
	t.mu.Lock()
	t.currentFile = file
	now := time.Now()
	cb, snap, shouldNotify := t.checkNotifyLocked(now, false)
	t.mu.Unlock()

	if shouldNotify && cb != nil {
		cb(snap)
	}
}

// AddExtracted 累加解压落盘字节数。
func (t *ProgressTracker) AddExtracted(n int64) {
	if n <= 0 {
		return
	}
	t.mu.Lock()
	t.extracted += n
	now := time.Now()
	cb, snap, shouldNotify := t.checkNotifyLocked(now, false)
	t.mu.Unlock()

	if shouldNotify && cb != nil {
		cb(snap)
	}
}

// IncrementFiles 递增解压文件计数。
func (t *ProgressTracker) IncrementFiles() {
	t.mu.Lock()
	t.extractedFiles++
	now := time.Now()
	cb, snap, shouldNotify := t.checkNotifyLocked(now, false)
	t.mu.Unlock()

	if shouldNotify && cb != nil {
		cb(snap)
	}
}

// Finish 标记归档完全解压完毕，强制发射 100% 进度。
func (t *ProgressTracker) Finish() {
	t.mu.Lock()
	t.closed = true
	now := time.Now()
	t.lastNotifyTime = now
	snap := t.snapshotLocked(now)
	snap.Percent = 100.0
	cb := t.onProgress
	t.mu.Unlock()

	if cb != nil {
		cb(snap)
	}
}

// Snapshot 获取当前进度快照。
func (t *ProgressTracker) Snapshot() Progress {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked(time.Now())
}

// TotalRead 返回当前累计下载字节数。
func (t *ProgressTracker) TotalRead() int64 {
	t.mu.RLock()
	defer t.mu.RUnlock()
	return t.downloaded
}

func (t *ProgressTracker) updateSpeedLocked(now time.Time) {
	if t.lastSampleTime.IsZero() {
		t.lastSampleTime = now
		t.lastSampleBytes = t.downloaded
		return
	}
	if now.Before(t.lastSampleTime) {
		t.lastSampleTime = now
		t.lastSampleBytes = t.downloaded
		return
	}
	sampleInterval := t.sampleInterval
	if sampleInterval <= 0 {
		sampleInterval = 200 * time.Millisecond
	}
	dt := now.Sub(t.lastSampleTime)
	if dt < sampleInterval {
		return
	}
	dBytes := t.downloaded - t.lastSampleBytes
	instSpeed := float64(dBytes) / dt.Seconds()
	if math.IsNaN(instSpeed) || math.IsInf(instSpeed, 0) || instSpeed < 0 {
		instSpeed = 0
	}
	if t.smoothedSpeed <= 0 {
		t.smoothedSpeed = instSpeed
	} else {
		alpha := t.alpha
		if alpha <= 0 || alpha > 1 {
			alpha = 0.25
		}
		t.smoothedSpeed = alpha*instSpeed + (1-alpha)*t.smoothedSpeed
	}
	// 当停止读取且平滑速度衰减至 1 B/s 以下时，彻底归零避免漂移
	if instSpeed == 0 && t.smoothedSpeed < 1.0 {
		t.smoothedSpeed = 0
	}
	t.lastSampleTime = now
	t.lastSampleBytes = t.downloaded
}

func (t *ProgressTracker) totalBytesLocked() int64 {
	if t.contentLength > 0 {
		return t.contentLength
	}
	if t.sizeHintBytes > 0 {
		return t.sizeHintBytes
	}
	return 0
}

func (t *ProgressTracker) calculatePercentLocked() float64 {
	if t.closed {
		return 100.0
	}
	if t.contentLength > 0 {
		p := (float64(t.downloaded) / float64(t.contentLength)) * 100.0
		if p > 99.9 {
			return 99.9
		}
		if p < 0 {
			return 0
		}
		return p
	}
	if t.sizeHintBytes > 0 {
		p := (float64(t.extracted) / float64(t.sizeHintBytes)) * 100.0
		if p > 99.0 {
			return 99.0
		}
		if p < 0 {
			return 0
		}
		return p
	}
	// 缺失确定性体积时采用渐近字节进度（以 10MB 为参考尺）
	if t.downloaded <= 0 {
		return 0
	}
	ref := 10.0 * 1024 * 1024
	p := 95.0 * (1.0 - 1.0/(1.0+float64(t.downloaded)/ref))
	if p > 95.0 {
		return 95.0
	}
	return p
}

func (t *ProgressTracker) snapshotLocked(now time.Time) Progress {
	t.updateSpeedLocked(now)
	return Progress{
		DownloadedBytes: t.downloaded,
		TotalBytes:      t.totalBytesLocked(),
		ExtractedBytes:  t.extracted,
		ExtractedFiles:  t.extractedFiles,
		CurrentFile:     t.currentFile,
		SpeedBps:        t.smoothedSpeed,
		SpeedFormatted:  FormatSpeed(t.smoothedSpeed),
		Percent:         t.calculatePercentLocked(),
	}
}

func (t *ProgressTracker) checkNotifyLocked(now time.Time, force bool) (ProgressCallback, Progress, bool) {
	if t.closed && !force {
		return nil, Progress{}, false
	}
	notifyInterval := t.notifyInterval
	if notifyInterval <= 0 {
		notifyInterval = 250 * time.Millisecond
	}
	if !force && !t.lastNotifyTime.IsZero() && now.Sub(t.lastNotifyTime) < notifyInterval {
		return nil, Progress{}, false
	}
	t.lastNotifyTime = now
	snap := t.snapshotLocked(now)
	return t.onProgress, snap, true
}

// progressReader 包装 io.Reader 并驱动 ProgressTracker 的读取累加。
type progressReader struct {
	r       io.Reader
	tracker *ProgressTracker
	n       int64
}

func newProgressReader(r io.Reader, tracker *ProgressTracker) *progressReader {
	return &progressReader{
		r:       r,
		tracker: tracker,
	}
}

func (pr *progressReader) Read(p []byte) (int, error) {
	n, err := pr.r.Read(p)
	if n > 0 {
		atomic.AddInt64(&pr.n, int64(n))
		if pr.tracker != nil {
			pr.tracker.UpdateDownloaded(int64(n))
		}
	}
	return n, err
}

func (pr *progressReader) TotalRead() int64 {
	if pr == nil {
		return 0
	}
	return atomic.LoadInt64(&pr.n)
}
