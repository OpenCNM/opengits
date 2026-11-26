package crashguard

import (
	"encoding/json"
	"log"
	"os"
	"path/filepath"
	"sync"
	"time"
)

const (
	crashWindow      = 60 * time.Second
	crashThreshold   = 3
	safeModeDuration = 5 * time.Minute
	safeModeBackoff  = 10 * time.Second
	recoveryWindow   = 3 * time.Minute
	sentinelFileName = ".worker_crash_sentinel.json"
)

type SentinelState struct {
	LastBootTime  time.Time `json:"lastBootTime"`
	CrashCount    int       `json:"crashCount"`
	SafeModeUntil time.Time `json:"safeModeUntil"`
}

type CrashSentinel struct {
	mu       sync.Mutex
	filePath string
}

func NewCrashSentinel(storageRoot string) *CrashSentinel {
	if storageRoot == "" {
		storageRoot = "/app/storage"
	}
	return &CrashSentinel{
		filePath: filepath.Join(storageRoot, sentinelFileName),
	}
}

func (s *CrashSentinel) InspectAndRecord(now time.Time) (isSafeMode bool, backoff time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.loadState()

	if !state.SafeModeUntil.IsZero() && now.Before(state.SafeModeUntil) {
		isSafeMode = true
		backoff = safeModeBackoff
	}

	if !state.LastBootTime.IsZero() {
		elapsed := now.Sub(state.LastBootTime)
		if elapsed >= 0 && elapsed < crashWindow {
			state.CrashCount++
			log.Printf("[crash-sentinel] rapid restart detected (%v since last boot), crash count: %d", elapsed, state.CrashCount)
		} else if elapsed >= recoveryWindow {
			state.CrashCount = 0
		}
	}

	if state.CrashCount >= crashThreshold {
		isSafeMode = true
		backoff = safeModeBackoff
		state.SafeModeUntil = now.Add(safeModeDuration)
		log.Printf("[crash-sentinel] WARNING: Crash Loop Storm detected (crashes=%d)! Entering Safe Mode for %v (backoff=%v)",
			state.CrashCount, safeModeDuration, backoff)
	}

	state.LastBootTime = now
	s.saveState(state)

	return isSafeMode, backoff
}

func (s *CrashSentinel) Reset() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return os.Remove(s.filePath)
}

func (s *CrashSentinel) loadState() SentinelState {
	data, err := os.ReadFile(s.filePath)
	if err != nil {
		return SentinelState{}
	}
	var state SentinelState
	if err := json.Unmarshal(data, &state); err != nil {
		return SentinelState{}
	}
	return state
}

func (s *CrashSentinel) saveState(state SentinelState) {
	data, err := json.Marshal(state)
	if err != nil {
		return
	}
	dir := filepath.Dir(s.filePath)
	_ = os.MkdirAll(dir, 0755)

	tmp := s.filePath + ".tmp"
	if err := os.WriteFile(tmp, data, 0644); err == nil {
		_ = os.Rename(tmp, s.filePath)
	}
}
