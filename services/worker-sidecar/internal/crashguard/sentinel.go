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
	// crashWindow 判定异常重启的时间窗口（若两次启动相隔小于此窗口，视作崩溃重启）
	crashWindow = 60 * time.Second
	// crashThreshold 触发 Safe Mode 避震降级的连续崩溃次数
	crashThreshold = 3
	// safeModeDuration 避震保护持续时间
	safeModeDuration = 5 * time.Minute
	// safeModeBackoff 避震保护期开机延迟退避时间
	safeModeBackoff = 10 * time.Second
	// recoveryWindow 稳定运行超过此时长重置崩溃计数器
	recoveryWindow = 3 * time.Minute
	// sentinelFileName 持久化哨兵文件名
	sentinelFileName = ".worker_crash_sentinel.json"
)

// SentinelState 持久化保存的崩溃哨兵状态
type SentinelState struct {
	LastBootTime  time.Time `json:"lastBootTime"`
	CrashCount    int       `json:"crashCount"`
	SafeModeUntil time.Time `json:"safeModeUntil"`
}

// CrashSentinel 跨进程重启崩溃风暴与死循环防御哨兵
type CrashSentinel struct {
	mu       sync.Mutex
	filePath string
}

// NewCrashSentinel 创建崩溃哨兵（数据持久化存放在 storageRoot）
func NewCrashSentinel(storageRoot string) *CrashSentinel {
	if storageRoot == "" {
		storageRoot = "/app/storage"
	}
	return &CrashSentinel{
		filePath: filepath.Join(storageRoot, sentinelFileName),
	}
}

// InspectAndRecord 在守护进程启动时调用：
// 1. 读取上一代进程的启动与崩溃历史；
// 2. 计算当前是否处于崩溃循环（Crash Loop Storm）；
// 3. 记录本次启动时间并原子刷盘；
// 4. 返回当前是否进入 Safe Mode 及应施加的启动退避延迟。
func (s *CrashSentinel) InspectAndRecord(now time.Time) (isSafeMode bool, backoff time.Duration) {
	s.mu.Lock()
	defer s.mu.Unlock()

	state := s.loadState()

	// 1. 判断是否仍在上一轮 SafeMode 窗口内
	if !state.SafeModeUntil.IsZero() && now.Before(state.SafeModeUntil) {
		isSafeMode = true
		backoff = safeModeBackoff
	}

	// 2. 检查距离上次启动间隔
	if !state.LastBootTime.IsZero() {
		elapsed := now.Sub(state.LastBootTime)
		if elapsed >= 0 && elapsed < crashWindow {
			state.CrashCount++
			log.Printf("[crash-sentinel] rapid restart detected (%v since last boot), crash count: %d", elapsed, state.CrashCount)
		} else if elapsed >= recoveryWindow {
			// 稳定运行足够久，重置崩溃计数
			state.CrashCount = 0
		}
	}

	// 3. 检查是否达到崩溃风暴阈值
	if state.CrashCount >= crashThreshold {
		isSafeMode = true
		backoff = safeModeBackoff
		state.SafeModeUntil = now.Add(safeModeDuration)
		log.Printf("[crash-sentinel] WARNING: Crash Loop Storm detected (crashes=%d)! Entering Safe Mode for %v (backoff=%v)",
			state.CrashCount, safeModeDuration, backoff)
	}

	// 4. 更新本次启动时间
	state.LastBootTime = now
	s.saveState(state)

	return isSafeMode, backoff
}

// Reset 显式重置哨兵状态（供运维工具或单测使用）
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
