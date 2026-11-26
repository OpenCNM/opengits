package daemon

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

func TestDefaultWebInternalURL(t *testing.T) {
	tests := []struct {
		name    string
		appEnv  string
		wantURL string
	}{
		{name: "development 裸进程回落本机", appEnv: "development", wantURL: "http://127.0.0.1:3000"},
		{name: "空环境视作 development", appEnv: "", wantURL: "http://127.0.0.1:3000"},
		{name: "非 production 一律 dev 回落", appEnv: "staging", wantURL: "http://127.0.0.1:3000"},
		{name: "production 保持 docker 主机名旧默认", appEnv: "production", wantURL: "http://web:3000"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.wantURL, defaultWebInternalURL(tt.appEnv))
		})
	}
}
