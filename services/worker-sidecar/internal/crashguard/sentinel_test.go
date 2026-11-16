package crashguard

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCrashSentinel_SafeModeTriggerAndRecovery(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "sentinel-test-*")
	require.NoError(t, err)
	defer os.RemoveAll(tmpDir)

	sentinel := NewCrashSentinel(tmpDir)
	baseTime := time.Date(2026, 10, 20, 10, 0, 0, 0, time.UTC)

	// 1. 第一次正常启动
	safe1, backoff1 := sentinel.InspectAndRecord(baseTime)
	assert.False(t, safe1)
	assert.Equal(t, time.Duration(0), backoff1)

	// 2. 20 秒后发生第 1 次异常重启（CrashCount = 1）
	t2 := baseTime.Add(20 * time.Second)
	safe2, backoff2 := sentinel.InspectAndRecord(t2)
	assert.False(t, safe2)
	assert.Equal(t, time.Duration(0), backoff2)

	// 3. 15 秒后发生第 2 次异常重启（CrashCount = 2）
	t3 := t2.Add(15 * time.Second)
	safe3, backoff3 := sentinel.InspectAndRecord(t3)
	assert.False(t, safe3)
	assert.Equal(t, time.Duration(0), backoff3)

	// 4. 10 秒后发生第 3 次异常重启（CrashCount = 3 -> 触发 Safe Mode）
	t4 := t3.Add(10 * time.Second)
	safe4, backoff4 := sentinel.InspectAndRecord(t4)
	assert.True(t, safe4, "should enter Safe Mode after 3 rapid crashes")
	assert.Equal(t, 10*time.Second, backoff4)

	// 5. 在 5 分钟 Safe Mode 窗口内再次启动，依然保持 Safe Mode
	t5 := t4.Add(30 * time.Second)
	safe5, backoff5 := sentinel.InspectAndRecord(t5)
	assert.True(t, safe5, "should remain in Safe Mode during safeModeDuration")
	assert.Equal(t, 10*time.Second, backoff5)

	// 6. 稳定运行 10 分钟后（超过 safeModeDuration 与 recoveryWindow）启动，自动自愈退出 Safe Mode
	t6 := t5.Add(10 * time.Minute)
	safe6, backoff6 := sentinel.InspectAndRecord(t6)
	assert.False(t, safe6, "should automatically recover and exit Safe Mode")
	assert.Equal(t, time.Duration(0), backoff6)

	// 验证持久化文件已写入
	assert.FileExists(t, filepath.Join(tmpDir, sentinelFileName))
}

func TestCrashSentinel_Reset(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "sentinel-reset-*")
	require.NoError(t, err)
	defer os.RemoveAll(tmpDir)

	sentinel := NewCrashSentinel(tmpDir)
	sentinel.InspectAndRecord(time.Now())
	assert.FileExists(t, filepath.Join(tmpDir, sentinelFileName))

	err = sentinel.Reset()
	require.NoError(t, err)
	assert.NoFileExists(t, filepath.Join(tmpDir, sentinelFileName))
}
