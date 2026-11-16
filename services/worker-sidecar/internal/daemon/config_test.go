package daemon

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestConfig_ContentDualWrite(t *testing.T) {
	tests := []struct {
		name     string
		envVal   string
		setEnv   bool
		expected bool
	}{
		{
			name:     "默认未设置环境变量时 ContentDualWrite 必须为 false (零物化默认停写)",
			setEnv:   false,
			expected: false,
		},
		{
			name:     "环境变量为空字符串时为 false",
			setEnv:   true,
			envVal:   "",
			expected: false,
		},
		{
			name:     "显式 DOCUMENT_CONTENT_DUAL_WRITE=1 时 ContentDualWrite 开启",
			setEnv:   true,
			envVal:   "1",
			expected: true,
		},
		{
			name:     "显式 DOCUMENT_CONTENT_DUAL_WRITE=0 时 ContentDualWrite 关闭",
			setEnv:   true,
			envVal:   "0",
			expected: false,
		},
		{
			name:     "显式 DOCUMENT_CONTENT_DUAL_WRITE=true 时 ContentDualWrite 关闭 (严格等于 1)",
			setEnv:   true,
			envVal:   "true",
			expected: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig, exists := os.LookupEnv("DOCUMENT_CONTENT_DUAL_WRITE")
			defer func() {
				if exists {
					_ = os.Setenv("DOCUMENT_CONTENT_DUAL_WRITE", orig)
				} else {
					_ = os.Unsetenv("DOCUMENT_CONTENT_DUAL_WRITE")
				}
			}()

			if tt.setEnv {
				_ = os.Setenv("DOCUMENT_CONTENT_DUAL_WRITE", tt.envVal)
			} else {
				_ = os.Unsetenv("DOCUMENT_CONTENT_DUAL_WRITE")
			}

			cfg := loadConfigFromEnv()
			assert.Equal(t, tt.expected, cfg.ContentDualWrite)
		})
	}
}

func TestConfig_TranscriptionExecutor(t *testing.T) {
	tests := []struct {
		name     string
		envVal   string
		setEnv   bool
		expected string
	}{
		{
			name:     "🧪 [2.12.1.4] 默认未设置环境变量时 TranscriptionExecutor 必须为 go (Zero-Node 默认收敛)",
			setEnv:   false,
			expected: "go",
		},
		{
			name:     "显式 TRANSCRIPTION_EXECUTOR=node 时回退 node 容灾通道",
			setEnv:   true,
			envVal:   "node",
			expected: "node",
		},
		{
			name:     "显式 TRANSCRIPTION_EXECUTOR=go 时维持 go",
			setEnv:   true,
			envVal:   "go",
			expected: "go",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			orig, exists := os.LookupEnv("TRANSCRIPTION_EXECUTOR")
			defer func() {
				if exists {
					_ = os.Setenv("TRANSCRIPTION_EXECUTOR", orig)
				} else {
					_ = os.Unsetenv("TRANSCRIPTION_EXECUTOR")
				}
			}()

			if tt.setEnv {
				_ = os.Setenv("TRANSCRIPTION_EXECUTOR", tt.envVal)
			} else {
				_ = os.Unsetenv("TRANSCRIPTION_EXECUTOR")
			}

			cfg := loadConfigFromEnv()
			assert.Equal(t, tt.expected, cfg.TranscriptionExecutor)
		})
	}
}
