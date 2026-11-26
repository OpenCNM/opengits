package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
)

// Pre-serialize static tools/list payloads per endpoint and era to avoid per-request JSON schema marshaling.

type precomputedList struct {
	legacy []byte
	modern []byte
}

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
