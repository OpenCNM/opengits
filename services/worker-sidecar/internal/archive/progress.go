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

type Progress struct {
	DownloadedBytes int64   `json:"downloadedBytes"`
	TotalBytes      int64   `json:"totalBytes"`
	ExtractedBytes  int64   `json:"extractedBytes"`
	ExtractedFiles  int     `json:"extractedFiles"`
	CurrentFile     string  `json:"currentFile"`
	SpeedBps        float64 `json:"speedBps"`
	SpeedFormatted  string  `json:"speedFormatted"`
	Percent         float64 `json:"percent"`
}

type ProgressCallback func(p Progress)

type progressCtxKey struct{}

func WithProgress(ctx context.Context, cb ProgressCallback) context.Context {
	if cb == nil {
		return ctx
	}
	return context.WithValue(ctx, progressCtxKey{}, cb)
}

func ProgressFromContext(ctx context.Context) ProgressCallback {
	if ctx == nil {
		return nil
	}
	if cb, ok := ctx.Value(progressCtxKey{}).(ProgressCallback); ok {
		return cb
	}
	return nil
}

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

type ProgressTracker struct {
	mu             sync.RWMutex
	contentLength  int64
	sizeHintBytes  int64
	downloaded     int64
	extracted      int64
	extractedFiles int
	currentFile    string

	lastSampleTime  time.Time
	lastSampleBytes int64
	smoothedSpeed   float64
	alpha           float64
	sampleInterval  time.Duration

	onProgress     ProgressCallback
	lastNotifyTime time.Time
	notifyInterval time.Duration
	closed         bool
}

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

func (t *ProgressTracker) Snapshot() Progress {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshotLocked(time.Now())
}

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
