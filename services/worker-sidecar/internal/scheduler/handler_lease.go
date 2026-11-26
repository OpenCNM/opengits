package scheduler

import (
	"net/http"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type LeaseAcquireRequest struct {
	Key     string `json:"key"`
	TTLMs   int64  `json:"ttlMs"`
	OwnerID string `json:"ownerId,omitempty"`
}

type LeaseAcquireResponse struct {
	Acquired bool `json:"acquired"`
}

type LeaseReleaseRequest struct {
	Key     string `json:"key"`
	OwnerID string `json:"ownerId,omitempty"`
}

type LeaseReleaseResponse struct {
	Ok bool `json:"ok"`
}

type LeaseHandler struct {
	store TaskStore
}

func NewLeaseHandler(store TaskStore) *LeaseHandler {
	return &LeaseHandler{store: store}
}

func (h *LeaseHandler) HandleAcquire(w http.ResponseWriter, r *http.Request) {
	var req LeaseAcquireRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.Key == "" {
		httpx.Error(w, http.StatusBadRequest, "key is required")
		return
	}
	if req.TTLMs <= 0 {
		req.TTLMs = 60_000
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "scheduler store is not available")
		return
	}

	ttl := time.Duration(req.TTLMs) * time.Millisecond
	acquired := AcquireLeaseWithOwner(r.Context(), h.store, req.Key, req.OwnerID, ttl)
	httpx.WriteJSON(w, http.StatusOK, LeaseAcquireResponse{Acquired: acquired})
}

func (h *LeaseHandler) HandleRelease(w http.ResponseWriter, r *http.Request) {
	var req LeaseReleaseRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.Key == "" {
		httpx.Error(w, http.StatusBadRequest, "key is required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "scheduler store is not available")
		return
	}

	ReleaseLeaseWithOwner(r.Context(), h.store, req.Key, req.OwnerID)
	httpx.WriteJSON(w, http.StatusOK, LeaseReleaseResponse{Ok: true})
}
