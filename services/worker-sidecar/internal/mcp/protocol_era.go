package mcp

import (
	"encoding/json"
	"net/http"
)

// ── MCP 2026-07-28 无状态协议（双时代并存）──
//
// legacy 时代（2025 及更早）：initialize 握手 + 逐连接协商，Go 原生应答行为与
// 历史版本字节级一致；modern 时代（2026-07-28）：无握手，每请求经 params._meta
// 携带协议版本与客户端能力，所有结果必带 resultType，list 类结果附缓存提示。
// 参考实现：@modelcontextprotocol/server 2.3.x dist（wire 形状的对照基准）。

const (
	// modernProtocolVersion 引入无状态信封的首个（也是当前唯一受支持的）modern 修订版
	modernProtocolVersion = "2026-07-28"
	// legacyNegotiatedFallback initialize 携带不可识别版本时的回落值
	// （镜像 @modelcontextprotocol/core SUPPORTED_PROTOCOL_VERSIONS 偏好序首位）
	legacyNegotiatedFallback = "2025-11-25"
	// modernListTTLMs CacheableResult 新鲜度提示，与路由检查/Bundle 元数据缓存 TTL 同源
	modernListTTLMs = 60_000
	// modernCacheScope 授权响应禁止共享中间层缓存
	modernCacheScope = "private"
	// resultTypeComplete 普通结果（MRTR 的 "input_required" 本服务不涉及——全部工具同步可答）
	resultTypeComplete = "complete"
)

// 规范保留 _meta 键（前缀 io.modelcontextprotocol/ 为 MCP 保留）
const (
	metaKeyProtocolVersion    = "io.modelcontextprotocol/protocolVersion"
	metaKeyClientCapabilities = "io.modelcontextprotocol/clientCapabilities"
	metaKeyServerInfo         = "io.modelcontextprotocol/serverInfo"
)

// legacySupportedVersions 按偏好序排列，镜像 @modelcontextprotocol/core 的
// SUPPORTED_PROTOCOL_VERSIONS（legacy initialize 协商集合，与 Node SDK 宣告一致）。
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

// eraInfo 单请求协议时代。无状态协议不依赖连接级上下文，每请求独立判定。
type eraInfo struct {
	// Modern 为 true 时结果信封按 2026-07-28 增强（resultType/_meta/ttlMs/cacheScope）
	Modern bool
	// ServerName modern 信封 _meta.serverInfo 自报身份（按路由区分：单仓/Hub/Bundle）
	ServerName string
}

// detectEra 从 params._meta 的版本声明判定协议时代（body 优先，与 SDK
// classifyInboundRequest 的 body-primary 规则一致——代理剥头不得改变时代归属）：
//   - 声明 >= 2026-07-28 → modern（ISO 日期字典序即时间序）；不支持的更高版本
//     由 validateModernEra 以 -32022 拒绝
//   - 声明 < 2026-07-28 或无声明 → legacy（malformed/旧版本声明按 SDK 语义回退旧路由）
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

// validateModernEra modern 请求硬校验（规范 MUST）：
//   - 缺失必填 _meta 键（protocolVersion 声明本身 / clientCapabilities）→ 400 + -32602
//   - 声明了不受支持的更高版本 → -32022 UnsupportedProtocolVersion
//
// 返回 false 时已写出拒绝响应。
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

// negotiateLegacyVersion initialize 版本协商（对齐官方 SDK）：
// 回显客户端请求版本（若受支持），否则宣告最新受支持的 legacy 版本。
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

// modernResultFields 2026-07-28 结果信封附加字段（嵌入各 Result 结构体内联序列化；
// legacy 时代零值 + omitempty → 字节级不出现，旧客户端零漂移）。
type modernResultFields struct {
	ResultType string         `json:"resultType,omitempty"`
	TTLMs      int            `json:"ttlMs,omitempty"`
	CacheScope string         `json:"cacheScope,omitempty"`
	Meta       map[string]any `json:"_meta,omitempty"`
}

// setModernEnvelope modern 时代填充结果信封：resultType=complete + _meta.serverInfo；
// cacheable=true 时附加 CacheableResult 的 ttlMs/cacheScope（tools/list、prompts/list、
// resources/list、resources/read、prompts/get）。
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
