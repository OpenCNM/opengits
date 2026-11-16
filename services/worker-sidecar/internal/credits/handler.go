package credits

import (
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

// Handler exposes JSON HTTP endpoints for credit economics and billing operations.
type Handler struct {
	store Store
}

// NewHandler creates a new credits Handler.
func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

// HandleLedger handles POST /v1/credits/ledger.
func (h *Handler) HandleLedger(w http.ResponseWriter, r *http.Request) {
	var req CreditsLedgerInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId is required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "credits store is not available")
		return
	}

	res, err := h.store.GetCreditsLedger(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

// HandleShelfFeeCharge handles POST /v1/credits/shelf-fee/charge.
func (h *Handler) HandleShelfFeeCharge(w http.ResponseWriter, r *http.Request) {
	var req ShelfFeeChargeInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and repositoryId are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "credits store is not available")
		return
	}

	res, err := h.store.ChargeShelfFeeAndSave(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

// HandleImportRewardGrant handles POST /v1/credits/import-reward/grant.
func (h *Handler) HandleImportRewardGrant(w http.ResponseWriter, r *http.Request) {
	var req ImportRewardGrantInput
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.UserID == "" || req.RepositoryID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId and repositoryId are required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "credits store is not available")
		return
	}

	res, err := h.store.GrantImportReward(r.Context(), req)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}
	httpx.WriteJSON(w, http.StatusOK, res)
}

