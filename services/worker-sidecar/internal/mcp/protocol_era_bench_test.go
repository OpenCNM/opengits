package mcp

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

// 🧪 MCP 2026-07-28 双时代协议层微基准：
// 量化协议升级在热路径上引入的每请求成本（era 判定 + modern 信封序列化），
// 以及 legacy 路径与升级前形态的等价性（writeCallToolResult 旧 Fprintf → struct 序列化）。

func benchMeta(t testing.TB, modern bool) map[string]json.RawMessage {
	if !modern {
		return nil
	}
	return map[string]json.RawMessage{
		metaKeyProtocolVersion:    json.RawMessage(`"2026-07-28"`),
		metaKeyClientCapabilities: json.RawMessage(`{}`),
	}
}

// BenchmarkDetectEra 时代判定：每请求一次（body 已解析进 jsonRpcBody 后为纯 map 查找）
func BenchmarkDetectEra(b *testing.B) {
	b.Run("legacy-no-meta", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			detectEra(nil)
		}
	})
	b.Run("modern-with-meta", func(b *testing.B) {
		meta := benchMeta(b, true)
		b.ReportAllocs()
		b.ResetTimer()
		for i := 0; i < b.N; i++ {
			detectEra(meta)
		}
	})
}

// BenchmarkValidateModernEra modern 请求必填键校验
func BenchmarkValidateModernEra(b *testing.B) {
	meta := benchMeta(b, true)
	w := httptest.NewRecorder()
	id := json.RawMessage(`1`)
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		validateModernEra(w, id, meta, eraInfo{Modern: true, ServerName: "bench"})
	}
}

// BenchmarkWriteCallToolResult 工具结果信封（legacy 字节级兼容 vs modern 增强）
func BenchmarkWriteCallToolResult(b *testing.B) {
	long := make([]byte, 8<<10) // 8KB 典型工具输出
	for i := range long {
		long[i] = 'x'
	}
	result := readResult{Text: string(long)}
	id := json.RawMessage(`1`)

	b.Run("legacy", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			writeCallToolResult(w, id, result, eraInfo{ServerName: "opengits-mcp-sidecar"})
		}
	})
	b.Run("modern", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			writeCallToolResult(w, id, result, eraInfo{Modern: true, ServerName: "opengits-mcp-sidecar"})
		}
	})
}

// BenchmarkToolsList tools/list 原生应答（12 工具清单序列化，legacy vs modern 信封）
func BenchmarkToolsList(b *testing.B) {
	s := &server{}
	id := json.RawMessage(`1`)

	b.Run("legacy", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			s.handleNativeToolsList(w, id, eraInfo{ServerName: "opengits-mcp-sidecar"})
		}
	})
	b.Run("modern", func(b *testing.B) {
		b.ReportAllocs()
		for i := 0; i < b.N; i++ {
			w := httptest.NewRecorder()
			s.handleNativeToolsList(w, id, eraInfo{Modern: true, ServerName: "opengits-mcp-sidecar"})
		}
	})
}

// BenchmarkServerDiscover 新增发现面（静态应答，对照 tools/list 量级）
func BenchmarkServerDiscover(b *testing.B) {
	s := &server{}
	id := json.RawMessage(`1`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		s.handleServerDiscover(w, id, eraInfo{Modern: true, ServerName: "opengits-mcp-sidecar"})
	}
}
