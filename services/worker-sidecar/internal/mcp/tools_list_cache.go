package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// ── tools/list 静态清单预序列化 ──
//
// 13 工具清单（含 zod→JSON Schema 投影）是纯静态字节，却在无状态模式下
// 每请求重复序列化（实测 28µs / 13.5KB 分配/次）。启动时按 端点 × 时代
// 各序列化一份，每请求只做 id 插入拼接——输出与 writeJSONRPCResponse
// （json.Encoder）字节级一致（字段序 jsonrpc→id→result、HTML 转义、尾换行），
// 由 TestPrecomputedListsByteCompatible 锁定。

type precomputedList struct {
	legacy []byte // result 对象 JSON（legacy 时代：无 modern 信封字段）
	modern []byte // result 对象 JSON（modern 时代：resultType/_meta/ttlMs/cacheScope）
}

// precomputeToolsList 构建清单结构体并预序列化两种时代的形态。
// modern 形态的信封 serverInfo 使用传入的 serverName（三端点各自固化）。
func precomputeToolsList(serverName string, build func() ToolsListResult) precomputedList {
	base := build()
	legacyBytes, err := json.Marshal(base)
	if err != nil {
		panic("mcp: precompute tools/list legacy: " + err.Error())
	}
	modern := build()
	modern.setModernEnvelope(eraInfo{Modern: true, ServerName: serverName}, true)
	modernBytes, err := json.Marshal(modern)
	if err != nil {
		panic("mcp: precompute tools/list modern: " + err.Error())
	}
	return precomputedList{legacy: legacyBytes, modern: modernBytes}
}

var (
	nativeToolsListCache = precomputeToolsList("opengits-mcp-sidecar", func() ToolsListResult {
		return ToolsListResult{Tools: NativeToolsList}
	})
	hubToolsListCache = precomputeToolsList("opengits-user-hub", func() ToolsListResult {
		return ToolsListResult{Tools: NativeHubToolsList}
	})
	bundleToolsListCache = precomputeToolsList("opengits-mcp-bundle", func() ToolsListResult {
		return ToolsListResult{Tools: NativeBundleToolsList}
	})
)

// writePrecomputedList 输出预序列化清单（与 writeJSONRPCResponse 字节级一致）。
func writePrecomputedList(w http.ResponseWriter, id json.RawMessage, era eraInfo, pre precomputedList) {
	setMCPCors(w)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	payload := pre.legacy
	if era.Modern {
		payload = pre.modern
	}
	idVal := json.RawMessage("null")
	if len(id) > 0 && string(id) != "" {
		idVal = id
	}
	_, _ = fmt.Fprintf(w, "{\"jsonrpc\":\"2.0\",\"id\":%s,\"result\":%s}\n", idVal, payload)
}
