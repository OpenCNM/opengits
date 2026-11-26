package userinteraction

import (
	"errors"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type McpTokensListRequest struct {
	UserID string `json:"userId"`
}

type McpTokensListResponse struct {
	Ok     bool              `json:"ok"`
	Tokens []McpTokenSummary `json:"tokens"`
	Error  string            `json:"error,omitempty"`
}

func (h *Handler) HandleMcpTokensList(w http.ResponseWriter, r *http.Request) {
	var req McpTokensListRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	tokens, err := h.store.ListMcpTokens(r.Context(), req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, McpTokensListResponse{
		Ok:     true,
		Tokens: tokens,
	})
}

type McpTokenCreateRequest struct {
	UserID         string  `json:"userId"`
	Name           string  `json:"name"`
	TokenHash      string  `json:"tokenHash"`
	EncryptedToken *string `json:"encryptedToken,omitempty"`
	Prefix         string  `json:"prefix"`
}

type McpTokenCreateResponse struct {
	Ok    bool                   `json:"ok"`
	Token *McpTokenCreatedRecord `json:"token,omitempty"`
	Error string                 `json:"error,omitempty"`
	Code  string                 `json:"code,omitempty"`
}

func (h *Handler) HandleMcpTokenCreate(w http.ResponseWriter, r *http.Request) {
	var req McpTokenCreateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if strings.TrimSpace(req.Name) == "" {
		httpx.Error(w, http.StatusBadRequest, "Token name is required")
		return
	}
	if req.TokenHash == "" {
		httpx.Error(w, http.StatusBadRequest, "tokenHash is required")
		return
	}
	if req.Prefix == "" {
		httpx.Error(w, http.StatusBadRequest, "prefix is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	token, err := h.store.CreateMcpToken(r.Context(), McpTokenCreateInput{
		UserID:         req.UserID,
		Name:           req.Name,
		TokenHash:      req.TokenHash,
		EncryptedToken: req.EncryptedToken,
		Prefix:         req.Prefix,
	})
	if err != nil {
		if errors.Is(err, ErrMaxTokensExceeded) {
			httpx.WriteJSON(w, http.StatusConflict, McpTokenCreateResponse{
				Ok:    false,
				Error: "Maximum active tokens limit reached (20). Please revoke unused tokens first.",
				Code:  "MAX_TOKENS_EXCEEDED",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, McpTokenCreateResponse{
		Ok:    true,
		Token: token,
	})
}

type McpTokenRevokeRequest struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	All    bool   `json:"all"`
}

type McpTokenRevokeResponse struct {
	Ok           bool   `json:"ok"`
	Revoked      bool   `json:"revoked,omitempty"`
	RevokedCount int64  `json:"revokedCount,omitempty"`
	Error        string `json:"error,omitempty"`
	Code         string `json:"code,omitempty"`
}

func (h *Handler) HandleMcpTokenRevoke(w http.ResponseWriter, r *http.Request) {
	var req McpTokenRevokeRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if !req.All && req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "Invalid token id")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.RevokeMcpToken(r.Context(), McpTokenRevokeInput{
		ID:     req.ID,
		UserID: req.UserID,
		All:    req.All,
	})
	if err != nil {
		if errors.Is(err, ErrMcpTokenNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, McpTokenRevokeResponse{
				Ok:    false,
				Error: "Token not found or already revoked",
				Code:  "TOKEN_NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, McpTokenRevokeResponse{
		Ok:           true,
		Revoked:      true,
		RevokedCount: count,
	})
}

type McpTokenTouchRequest struct {
	ID string `json:"id"`
}

type McpTokenTouchResponse struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func (h *Handler) HandleMcpTokenTouch(w http.ResponseWriter, r *http.Request) {
	var req McpTokenTouchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}
	if req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	if err := h.store.TouchMcpTokenUsage(r.Context(), req.ID); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, McpTokenTouchResponse{Ok: true})
}
