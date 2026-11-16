package scheduler

import (
	"net/http"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// LeaseAcquireRequest represents input for lease acquisition.
type LeaseAcquireRequest struct {
	Key     string `json:"key"`
	TTLMs   int64  `json:"ttlMs"`
	OwnerID string `json:"ownerId,omitempty"`
}

// LeaseAcquireResponse represents result for lease acquisition.
type LeaseAcquireResponse struct {
	Acquired bool `json:"acquired"`
}

// LeaseReleaseRequest represents input for lease release.
type LeaseReleaseRequest struct {
	Key     string `json:"key"`
	OwnerID string `json:"ownerId,omitempty"`
}

// LeaseReleaseResponse represents result for lease release.
type LeaseReleaseResponse struct {
	Ok bool `json:"ok"`
}

// LeaseHandler exposes endpoints for distributed scheduler leader leases.
type LeaseHandler struct {
	store TaskStore
}

// NewLeaseHandler creates a new LeaseHandler.
func NewLeaseHandler(store TaskStore) *LeaseHandler {
	return &LeaseHandler{store: store}
}

// HandleAcquire handles POST /v1/scheduler/lease/acquire.
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
		req.TTLMs = 60_000 // default 60s
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "scheduler store is not available")
		return
	}

	ttl := time.Duration(req.TTLMs) * time.Millisecond
	acquired := AcquireLeaseWithOwner(r.Context(), h.store, req.Key, req.OwnerID, ttl)
	httpx.WriteJSON(w, http.StatusOK, LeaseAcquireResponse{Acquired: acquired})
}

// HandleRelease handles POST /v1/scheduler/lease/release.
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
