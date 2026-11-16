package llmstream

import (
	"bufio"
	"errors"
	"io"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// ─────────────────────────────────────────────────────────────
// 上游 SSE 行长上限（ReadString 无界累积防御）
// ─────────────────────────────────────────────────────────────

func TestReadCappedLine(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		maxBytes  int
		wantLine  string
		wantErr   bool // 首读即返回错误（无换行到 EOF）
		checkNext bool
		nextLine  string // 越限行被丢弃后，下一行应可正常读出
	}{
		{
			name:     "short line passthrough (ReadString semantics)",
			input:    "data: {\"a\":1}\n",
			maxBytes: 1024,
			wantLine: "data: {\"a\":1}\n",
		},
		{
			name:     "line exactly at cap still passes",
			input:    strings.Repeat("x", 16) + "\n",
			maxBytes: 17, // 含 '\n' 恰好 17 字节
			wantLine: strings.Repeat("x", 16) + "\n",
		},
		{
			name:      "oversized line dropped, following line survives",
			input:     strings.Repeat("x", 100) + "\ndata: ok\n",
			maxBytes:  16,
			wantLine:  "",
			checkNext: true,
			nextLine:  "data: ok\n",
		},
		{
			name:     "EOF without newline returns accumulated partial",
			input:    "partial",
			maxBytes: 1024,
			wantLine: "partial",
			wantErr:  true,
		},
		{
			name:     "oversized stream without newline until EOF yields empty + EOF",
			input:    strings.Repeat("x", 100),
			maxBytes: 16,
			wantLine: "",
			wantErr:  true,
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			reader := bufio.NewReader(strings.NewReader(tt.input))
			line, err := readCappedLine(reader, tt.maxBytes, "test-call")
			assert.Equal(t, tt.wantLine, line)
			if tt.wantErr {
				require.Error(t, err)
				assert.True(t, errors.Is(err, io.EOF))
			} else {
				assert.NoError(t, err)
			}
			if tt.checkNext {
				next, nextErr := readCappedLine(reader, tt.maxBytes, "test-call")
				assert.Equal(t, tt.nextLine, next)
				assert.NoError(t, nextErr)
			}
		})
	}
}
