package transcription

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler 负责处理转录任务队列的 HTTP API 请求。
type Handler struct {
	store  QueueStore
	runner *TranscriptionRunner
	// jitPriorityCap JIT 插队优先级的服务端权威上限：批量导入基线为 10000 -
	// row_number*20，插队权取 2 倍基线（默认 20000）——既保证打开章节立即抢占，
	// 又使老化加成（+1/分钟）在有限时间内可追平，避免读者流量永久压制整仓导入。
	jitPriorityCap int
}

// defaultJitPriorityCap 未注入配置时的兜底上限（与 daemon TRANSCRIPTION_JIT_PRIORITY 默认一致）。
const defaultJitPriorityCap = 20000

// NewHandler 构造转录 HTTP 处理器。
func NewHandler(store QueueStore) *Handler {
	return &Handler{store: store, jitPriorityCap: defaultJitPriorityCap}
}

// SetRunner 注入转录执行器，用于在入队时即时唤醒流水线。
func (h *Handler) SetRunner(r *TranscriptionRunner) {
	h.runner = r
}

// SetJitPriorityCap 注入 JIT 插队优先级上限（服务端权威钳制，防调用方夹带任意高权）。
func (h *Handler) SetJitPriorityCap(cap int) {
	if cap > 0 {
		h.jitPriorityCap = cap
	}
}

type EnqueueRequest struct {
	DocumentID  string `json:"documentId"`
	RequestedBy string `json:"requestedBy"`
	Priority    int    `json:"priority"`
	Options     any    `json:"options,omitempty"`
}

func (h *Handler) HandleEnqueue(w http.ResponseWriter, r *http.Request) {
	var req EnqueueRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.DocumentID == "" || req.RequestedBy == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and requestedBy are required")
		return
	}
	status, err := h.store.EnqueueTranscriptionJob(r.Context(), EnqueueJobParams{
		DocumentID:  req.DocumentID,
		RequestedBy: req.RequestedBy,
		Priority:    req.Priority,
		Options:     req.Options,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to enqueue transcription job: "+err.Error())
		return
	}
	if h.runner != nil {
		h.runner.TriggerPump()
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"status": status})
}

type StagedGenerateRequest struct {
	DocumentID string `json:"documentId"`
	UserID     string `json:"userId,omitempty"`
	SourceSha  string `json:"sourceSha"`
	Model      string `json:"model,omitempty"`
}

// HandleStagedGenerate 市场暂存生成（Go 无锁变体，能力与队列路径同源；
// 长调用——市场后台任务专用，调用方须配长超时）。
func (h *Handler) HandleStagedGenerate(w http.ResponseWriter, r *http.Request) {
	var req StagedGenerateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.DocumentID == "" || req.SourceSha == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and sourceSha are required")
		return
	}
	if h.runner == nil || h.runner.bodyDeps == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "transcription executor not configured")
		return
	}
	userID := req.UserID
	if userID == "" {
		userID = "system"
	}
	res, err := RunStagedBody(r.Context(), h.runner.cfg, *h.runner.bodyDeps, req.DocumentID, userID, req.SourceSha, req.Model)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

type PrioritizeJobRequest struct {
	DocumentID  string `json:"documentId"`
	RequestedBy string `json:"requestedBy"`
	Priority    int    `json:"priority"`
}

func (h *Handler) HandlePrioritize(w http.ResponseWriter, r *http.Request) {
	var req PrioritizeJobRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}
	if req.DocumentID == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId is required")
		return
	}
	// 服务端权威钳制：缺省/非正/超上限一律取上限，调用方无法注入任意高权
	if req.Priority <= 0 || req.Priority > h.jitPriorityCap {
		req.Priority = h.jitPriorityCap
	}
	if req.RequestedBy == "" {
		req.RequestedBy = "system"
	}
	if err := h.store.PrioritizeTranscriptionJob(r.Context(), req.DocumentID, req.RequestedBy, req.Priority); err != nil {
		httpx.Error(w, http.StatusInternalServerError, "failed to prioritize transcription job: "+err.Error())
		return
	}
	if h.runner != nil {
		h.runner.TriggerPump()
	}
	httpx.WriteJSON(w, http.StatusOK, map[string]any{"ok": true})
}

type StagedRelayGenerateRequest struct {
	DocumentID string `json:"documentId"`
	UserID     string `json:"userId,omitempty"`
	SourceSha  string `json:"sourceSha"`
	Model      string `json:"model,omitempty"`
}

// HandleStagedRelayGenerate 市场接力转录暂存生成（Go 无锁变体，契约三件套
// 闭环；长调用——市场后台任务专用，调用方须配长超时）。
func (h *Handler) HandleStagedRelayGenerate(w http.ResponseWriter, r *http.Request) {
	var req StagedRelayGenerateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.DocumentID == "" || req.SourceSha == "" {
		httpx.Error(w, http.StatusBadRequest, "documentId and sourceSha are required")
		return
	}
	if h.runner == nil || h.runner.bodyDeps == nil {
		httpx.Error(w, http.StatusServiceUnavailable, "transcription executor not configured")
		return
	}
	userID := req.UserID
	if userID == "" {
		userID = "system"
	}
	res, err := RunStagedRelayBody(r.Context(), h.runner.cfg, *h.runner.bodyDeps, req.DocumentID, userID, req.SourceSha, req.Model)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}
