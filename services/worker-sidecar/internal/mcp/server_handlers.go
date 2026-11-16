package mcp

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
)

// standardCapabilities 三类端点共用的能力宣告（无订阅/无 listChanged 推送）。
func standardCapabilities() ServerCapabilities {
	return ServerCapabilities{
		Tools:     ToolsCapability{ListChanged: false},
		Resources: ResourcesCapability{Subscribe: false, ListChanged: false},
		Prompts:   PromptsCapability{ListChanged: false},
	}
}

// handleServerDiscover MCP 2026-07-28 server/discover（服务端 MUST）：
// 宣告 modern 修订版与能力面。静态应答，零 DB 依赖；对 legacy 请求同样可答
// （发现面不区分时代，客户端可将其用作向后兼容探测）。
func (s *server) handleServerDiscover(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	res := DiscoverResult{
		SupportedVersions: []string{modernProtocolVersion},
		Capabilities:      standardCapabilities(),
	}
	res.setModernEnvelope(era, true)
	writeJSONRPCResponse(w, id, res)
}

// handleNativeInitialize legacy 时代 initialize 握手：回显客户端请求版本
// （若受支持），否则宣告最新受支持的 legacy 版本（对齐 Node SDK 协商行为）。
func (s *server) handleNativeInitialize(w http.ResponseWriter, body []byte, id json.RawMessage) {
	writeJSONRPCResponse(w, id, InitializeResult{
		ProtocolVersion: negotiateLegacyVersion(body),
		Capabilities:    standardCapabilities(),
		ServerInfo: ServerInfo{
			Name:    "opengits-mcp-sidecar",
			Version: "1.0.0",
		},
	})
}

func (s *server) handleNativeToolsList(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	writePrecomputedList(w, id, era, nativeToolsListCache)
}

func (s *server) handleHubInitialize(w http.ResponseWriter, body []byte, id json.RawMessage) {
	writeJSONRPCResponse(w, id, InitializeResult{
		ProtocolVersion: negotiateLegacyVersion(body),
		Capabilities:    standardCapabilities(),
		ServerInfo: ServerInfo{
			Name:    "opengits-user-hub",
			Version: "1.0.0",
		},
	})
}

func (s *server) handleHubToolsList(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	writePrecomputedList(w, id, era, hubToolsListCache)
}

func (s *server) handleHubResourcesList(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	res := ResourcesListResult{
		Resources: NativeHubResourcesList,
	}
	res.setModernEnvelope(era, true)
	writeJSONRPCResponse(w, id, res)
}

func (s *server) handleNativePromptsList(w http.ResponseWriter, id json.RawMessage, era eraInfo) {
	res := PromptsListResult{
		Prompts: NativePromptsList,
	}
	res.setModernEnvelope(era, true)
	writeJSONRPCResponse(w, id, res)
}

func (s *server) handleNativePromptsGet(w http.ResponseWriter, params json.RawMessage, id json.RawMessage, era eraInfo) {
	var req struct {
		Name      string         `json:"name"`
		Arguments map[string]any `json:"arguments"`
	}
	_ = json.Unmarshal(params, &req)
	name := strings.TrimSpace(req.Name)
	args := make(map[string]string)
	for k, v := range req.Arguments {
		if v != nil {
			args[k] = fmt.Sprint(v)
		}
	}

	repoSuffix := ""
	if repo, ok := args["repository"]; ok && strings.TrimSpace(repo) != "" {
		repoSuffix = fmt.Sprintf("，repository=\"%s\"", strings.TrimSpace(repo))
	}

	var res GetPromptResult
	switch name {
	case "deep_dive", "explain-architecture":
		topic := "该项目整体"
		if t, ok := args["topic"]; ok && strings.TrimSpace(t) != "" {
			topic = strings.TrimSpace(t)
		}
		deep := args["detail"] != "brief"
		summaryPart := "（简短模式）：3-5 条要点概括核心架构"
		if deep {
			summaryPart = "：ASCII 分层架构图、模块职责表、依赖关系、关键设计决策与演进方向"
		}
		text := fmt.Sprintf(`请按以下工作流讲解「%s」的架构：
1. 调用 search 检索 "%s" 相关章节（mode='architecture', detail='locator'）%s
2. 若 search 输出含「核心概念/图位置/依赖提示」，对该概念调用 explore_concept(action='details') 获取原理/SOP/作者思考；如需递进背景调用 explore_concept(action='path')
3. 对得分最高的 2-3 个命中调用 read_document(section=Address) 读取完整章节（Address 取自第 1 步输出）
4. 综合输出%s`, topic, topic, repoSuffix, summaryPart)

		res = GetPromptResult{
			Description: "Deep dive into architecture and core implementation",
			Messages: []PromptMessage{
				{Role: "user", Content: PromptContent{Type: "text", Text: text}},
			},
		}

	case "code_review", "scaffold-project":
		goal := "全栈项目"
		if g, ok := args["goal"]; ok && strings.TrimSpace(g) != "" {
			goal = strings.TrimSpace(g)
		}
		text := fmt.Sprintf(`请按以下工作流规划「%s」的项目搭建：
1. 选教程：调用 list_resources(query="%s") 筛选最契合的书架教程；单仓模式直接用 search(mode='architecture', query="%s") 检索技术栈初始化章节（detail='locator'）%s
2. 对选定教程调用 explore_concept(action='course_map') 看整体结构，再用 check_breaking_changes 审计破坏性变更与迁移风险%s
3. 对命中的关键章节调用 read_document(section=Address) 精读（Address 取自第 1 步输出）
4. 输出项目搭建计划：技术选型确认、初始化步骤清单（每步附溯源 Address）、风险等级（BLOCKER/MAJOR/MINOR）`, goal, goal, goal, repoSuffix, repoSuffix)

		res = GetPromptResult{
			Description: "Scaffold project or review implementation",
			Messages: []PromptMessage{
				{Role: "user", Content: PromptContent{Type: "text", Text: text}},
			},
		}

	case "breaking_changes", "audit-breaking-changes":
		target := "升级与迁移"
		if t, ok := args["target"]; ok && strings.TrimSpace(t) != "" {
			target = strings.TrimSpace(t)
		}
		text := fmt.Sprintf(`请按以下工作流审计「%s」的破坏性变更与迁移风险：
1. 调用 check_breaking_changes（query="%s"，detail='locator'）%s
2. 对命中的关键章节调用 read_document(section=Address) 精读
3. 输出迁移清单：受影响 API、破坏点、迁移步骤、风险等级（BLOCKER/MAJOR/MINOR）`, target, target, repoSuffix)

		res = GetPromptResult{
			Description: "Audit breaking changes & migration risks",
			Messages: []PromptMessage{
				{Role: "user", Content: PromptContent{Type: "text", Text: text}},
			},
		}

	case "explore_concept", "learn-path":
		concept := "核心概念"
		if c, ok := args["concept"]; ok && strings.TrimSpace(c) != "" {
			concept = strings.TrimSpace(c)
		}
		text := fmt.Sprintf(`请按以下工作流带我递进掌握「%s」：
1. 调用 explore_concept（concept="%s", action='path'）%s 获取前置知识链
2. 按链上顺序（先前置后目标）逐个调用 explore_concept(action='details') 深钻原理/SOP，必要时 read_document(section=Address) 精读溯源章节
3. 输出学习清单：每一步的概念、核心原理一句话、溯源 Address，以及最后的综合小结`, concept, concept, repoSuffix)

		res = GetPromptResult{
			Description: "Master concept progressively",
			Messages: []PromptMessage{
				{Role: "user", Content: PromptContent{Type: "text", Text: text}},
			},
		}

	default:
		writeJSONRPCError(w, http.StatusOK, -32602, "Prompt not found: "+name, id)
		return
	}

	res.setModernEnvelope(era, true)
	writeJSONRPCResponse(w, id, res)
}

func (s *server) handleRepoDiscovery(w http.ResponseWriter, r *http.Request, owner, repo string) {
	setMCPCors(w)
	repoRow := s.cachedDefaultBranchRepo(r.Context(), owner, repo)
	if repoRow == nil {
		writeRawJSON(w, http.StatusNotFound, `{"error":"Repository not found"}`)
		return
	}
	if repoRow.McpStatus == "PAUSED" {
		writeRawJSON(w, http.StatusServiceUnavailable, `{"error":"MCP service for this repository is currently paused by administrator"}`)
		return
	}

	token := extractBearerToken(r)
	var userID string
	if token != "" {
		rec, err := s.cachedLookupToken(r.Context(), sha256Hex(token))
		if err != nil || rec == nil {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: invalid or revoked API token"}`)
			return
		}
		userID = rec.UserID
		s.fireAndForget(rec, r)
	}

	if !repoRow.IsPublic {
		if userID == "" {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: authentication required"}`)
			return
		}
		if rs, ok := s.store.(ReadStore); ok {
			allowed, _ := rs.HasSavedRepoAccess(r.Context(), repoRow.ID, userID)
			if !allowed {
				writeRawJSON(w, http.StatusNotFound, `{"error":"Repository not found"}`)
				return
			}
		}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]any{
		"name":        fmt.Sprintf("opengits-%s-%s", owner, repo),
		"version":     "1.0.0",
		"description": fmt.Sprintf("MCP Server and Knowledge Hub for %s/%s", owner, repo),
		"status":      "READY",
		"endpoints": map[string]string{
			"rpc":     fmt.Sprintf("/api/mcp/%s/%s", owner, repo),
			"llmsTxt": fmt.Sprintf("/api/llms-txt/%s/%s", owner, repo),
		},
		"capabilities": map[string]any{
			"tools": NativeAllToolNames,
			"resources": []string{
				fmt.Sprintf("docs://%s/%s/overview", owner, repo),
				fmt.Sprintf("docs://%s/%s/doc/{path}", owner, repo),
				fmt.Sprintf("concepts://%s/%s", owner, repo),
				fmt.Sprintf("graph://%s/%s", owner, repo),
			},
		},
	}
	_ = json.NewEncoder(w).Encode(resp)
}

func (s *server) handleHubDiscovery(w http.ResponseWriter, r *http.Request) {
	setMCPCors(w)
	token := extractBearerToken(r)
	if token == "" {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: authentication required"}`)
		return
	}
	rec, err := s.cachedLookupToken(r.Context(), sha256Hex(token))
	if err != nil || rec == nil {
		w.Header().Set("WWW-Authenticate", "Bearer")
		writeRawJSON(w, http.StatusUnauthorized, `{"error":"Unauthorized: invalid or revoked API token"}`)
		return
	}
	s.fireAndForget(rec, r)

	var manifests []map[string]any
	if s.reader != nil {
		manifests = s.reader.buildHubManifests(r.Context(), rec.UserID)
	}
	if manifests == nil {
		manifests = []map[string]any{}
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	resp := map[string]any{
		"name":           "opengits-user-hub",
		"version":        "1.0.0",
		"description":    fmt.Sprintf("Unified OpenGits Hub MCP. Contains %d tutorials with full Capability Manifests plus 5 high-leverage engineering tools (search, read_document, explore_concept, check_breaking_changes, list_resources) searchable per-tutorial or across the whole Hub.", len(manifests)),
		"tutorialsCount": len(manifests),
		"manifests":      manifests,
		"rpc":            "/api/mcp/hub",
		"tools": []string{
			"list_resources",
			"search",
			"read_document",
			"explore_concept",
			"check_breaking_changes",
		},
	}
	_ = json.NewEncoder(w).Encode(resp)
}
