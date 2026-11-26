package mcp

import (
	"encoding/json"
	"net/http/httptest"
	"testing"
)

func benchMeta(t testing.TB, modern bool) map[string]json.RawMessage {
	if !modern {
		return nil
	}
	return map[string]json.RawMessage{
		metaKeyProtocolVersion:    json.RawMessage(`"2026-07-28"`),
		metaKeyClientCapabilities: json.RawMessage(`{}`),
	}
}

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

func BenchmarkWriteCallToolResult(b *testing.B) {
	long := make([]byte, 8<<10)
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

func BenchmarkServerDiscover(b *testing.B) {
	s := &server{}
	id := json.RawMessage(`1`)
	b.ReportAllocs()
	for i := 0; i < b.N; i++ {
		w := httptest.NewRecorder()
		s.handleServerDiscover(w, id, eraInfo{Modern: true, ServerName: "opengits-mcp-sidecar"})
	}
}
