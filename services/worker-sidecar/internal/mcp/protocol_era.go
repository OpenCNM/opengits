package mcp

import (
	"encoding/json"
	"net/http"
)

const (
	modernProtocolVersion = "2026-07-28"

	// Default unrecognized initialize versions to the preferred legacy protocol revision per MCP SDK spec.
	legacyNegotiatedFallback = "2025-11-25"

	modernListTTLMs = 60_000
	// Prevent shared proxy caching of authenticated responses via private cacheScope.
	modernCacheScope = "private"

	resultTypeComplete = "complete"
)

const (
	metaKeyProtocolVersion    = "io.modelcontextprotocol/protocolVersion"
	metaKeyClientCapabilities = "io.modelcontextprotocol/clientCapabilities"
	metaKeyServerInfo         = "io.modelcontextprotocol/serverInfo"
)

var legacySupportedVersions = []string{
	"2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05", "2024-10-07",
}

func isLegacyVersionSupported(version string) bool {
	for _, v := range legacySupportedVersions {
		if v == version {
			return true
		}
	}
	return false
}

type eraInfo struct {
	Modern bool

	ServerName string
}

// Detect protocol era from params._meta first so header-stripping proxies cannot alter request semantics.
func detectEra(meta map[string]json.RawMessage) eraInfo {
	if len(meta) == 0 {
		return eraInfo{}
	}
	raw, ok := meta[metaKeyProtocolVersion]
	if !ok || len(raw) == 0 {
		return eraInfo{}
	}
	var version string
	if err := json.Unmarshal(raw, &version); err != nil || version == "" {
		return eraInfo{}
	}
	if version < modernProtocolVersion {
		return eraInfo{}
	}
	return eraInfo{Modern: true}
}

func validateModernEra(w http.ResponseWriter, id json.RawMessage, meta map[string]json.RawMessage, era eraInfo) bool {
	if !era.Modern {
		return true
	}
	if raw, ok := meta[metaKeyProtocolVersion]; ok && len(raw) > 0 {
		var version string
		if err := json.Unmarshal(raw, &version); err == nil && version != modernProtocolVersion {
			writeJSONRPCError(w, http.StatusBadRequest, -32022,
				"Unsupported protocol version: "+version+" (supported: "+modernProtocolVersion+")", id)
			return false
		}
	}
	if raw, ok := meta[metaKeyClientCapabilities]; !ok || len(raw) == 0 {
		writeJSONRPCError(w, http.StatusBadRequest, -32602,
			"Invalid params: missing required _meta key "+metaKeyClientCapabilities, id)
		return false
	}
	return true
}

func negotiateLegacyVersion(body []byte) string {
	var req struct {
		Params struct {
			ProtocolVersion string `json:"protocolVersion"`
		} `json:"params"`
	}
	_ = json.Unmarshal(body, &req)
	if isLegacyVersionSupported(req.Params.ProtocolVersion) {
		return req.Params.ProtocolVersion
	}
	return legacyNegotiatedFallback
}

// Inline zero-value omitempty fields keep legacy envelopes byte-identical.
type modernResultFields struct {
	ResultType string         `json:"resultType,omitempty"`
	TTLMs      int            `json:"ttlMs,omitempty"`
	CacheScope string         `json:"cacheScope,omitempty"`
	Meta       map[string]any `json:"_meta,omitempty"`
}

func (m *modernResultFields) setModernEnvelope(era eraInfo, cacheable bool) {
	if !era.Modern {
		return
	}
	m.ResultType = resultTypeComplete
	m.Meta = map[string]any{
		metaKeyServerInfo: ServerInfo{Name: era.ServerName, Version: "1.0.0"},
	}
	if cacheable {
		m.TTLMs = modernListTTLMs
		m.CacheScope = modernCacheScope
	}
}
