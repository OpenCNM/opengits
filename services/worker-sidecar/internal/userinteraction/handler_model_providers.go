package userinteraction

import (
	"errors"
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type UserModelProvidersListRequest struct {
	UserID string `json:"userId"`
}

type UserModelProvidersListResponse struct {
	Ok        bool                    `json:"ok"`
	Providers []UserModelProviderView `json:"providers"`
	Error     string                  `json:"error,omitempty"`
}

func (h *Handler) HandleUserModelProvidersList(w http.ResponseWriter, r *http.Request) {
	var req UserModelProvidersListRequest
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

	providers, err := h.store.ListUserModelProviders(r.Context(), req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserModelProvidersListResponse{
		Ok:        true,
		Providers: providers,
	})
}

type UserModelProviderUpsertRequest struct {
	UserID          string   `json:"userId"`
	ProviderKey     string   `json:"providerKey"`
	Name            string   `json:"name"`
	BaseURL         string   `json:"baseUrl"`
	EncryptedApiKey string   `json:"encryptedApiKey"`
	APIFormat       string   `json:"apiFormat"`
	Models          []string `json:"models"`
	SelectedModel   string   `json:"selectedModel"`
	IsActive        *bool    `json:"isActive"`
}

type UserModelProviderUpsertResponse struct {
	Ok       bool                   `json:"ok"`
	Provider *UserModelProviderView `json:"provider,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Code     string                 `json:"code,omitempty"`
}

func (h *Handler) HandleUserModelProviderUpsert(w http.ResponseWriter, r *http.Request) {
	var req UserModelProviderUpsertRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitMedium) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.ProviderKey == "" {
		httpx.Error(w, http.StatusBadRequest, "providerKey is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	provider, err := h.store.UpsertUserModelProvider(r.Context(), UserModelProviderUpsertInput{
		UserID:          req.UserID,
		ProviderKey:     req.ProviderKey,
		Name:            req.Name,
		BaseURL:         req.BaseURL,
		EncryptedApiKey: req.EncryptedApiKey,
		APIFormat:       req.APIFormat,
		Models:          req.Models,
		SelectedModel:   req.SelectedModel,
		IsActive:        req.IsActive,
	})
	if err != nil {
		if errors.Is(err, ErrApiKeyRequired) {
			httpx.WriteJSON(w, http.StatusBadRequest, UserModelProviderUpsertResponse{
				Ok:    false,
				Error: "新增配置必须填写 API Key",
				Code:  "API_KEY_REQUIRED",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserModelProviderUpsertResponse{
		Ok:       true,
		Provider: provider,
	})
}

type UserModelProviderPatchRequest struct {
	UserID        string  `json:"userId"`
	ProviderKey   string  `json:"providerKey"`
	SelectedModel *string `json:"selectedModel,omitempty"`
	MakeActive    *bool   `json:"makeActive,omitempty"`
}

type UserModelProviderPatchResponse struct {
	Ok       bool                   `json:"ok"`
	Provider *UserModelProviderView `json:"provider,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Code     string                 `json:"code,omitempty"`
}

func (h *Handler) HandleUserModelProviderPatch(w http.ResponseWriter, r *http.Request) {
	var req UserModelProviderPatchRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.ProviderKey == "" {
		httpx.Error(w, http.StatusBadRequest, "providerKey is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	provider, err := h.store.PatchUserModelProvider(r.Context(), UserModelProviderPatchInput{
		UserID:        req.UserID,
		ProviderKey:   req.ProviderKey,
		SelectedModel: req.SelectedModel,
		MakeActive:    req.MakeActive,
	})
	if err != nil {
		if errors.Is(err, ErrProviderNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, UserModelProviderPatchResponse{
				Ok:    false,
				Error: "Provider not found",
				Code:  "PROVIDER_NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserModelProviderPatchResponse{
		Ok:       true,
		Provider: provider,
	})
}

type UserModelProviderDeleteRequest struct {
	UserID      string `json:"userId"`
	ProviderKey string `json:"providerKey"`
}

type UserModelProviderDeleteResponse struct {
	Ok      bool   `json:"ok"`
	Deleted bool   `json:"deleted,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

func (h *Handler) HandleUserModelProviderDelete(w http.ResponseWriter, r *http.Request) {
	var req UserModelProviderDeleteRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.ProviderKey == "" {
		httpx.Error(w, http.StatusBadRequest, "providerKey is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	err := h.store.DeleteUserModelProvider(r.Context(), UserModelProviderDeleteInput{
		UserID:      req.UserID,
		ProviderKey: req.ProviderKey,
	})
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserModelProviderDeleteResponse{
		Ok:      true,
		Deleted: true,
	})
}

type UserModelProviderGetCipherRequest struct {
	UserID      string `json:"userId"`
	ProviderKey string `json:"providerKey"`
}

type UserModelProviderGetCipherResponse struct {
	Ok     bool   `json:"ok"`
	APIKey string `json:"apiKey,omitempty"`
	Error  string `json:"error,omitempty"`
	Code   string `json:"code,omitempty"`
}

func (h *Handler) HandleUserModelProviderGetCipher(w http.ResponseWriter, r *http.Request) {
	var req UserModelProviderGetCipherRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.ProviderKey == "" {
		httpx.Error(w, http.StatusBadRequest, "providerKey is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	cipher, err := h.store.GetUserModelProviderCipher(r.Context(), req.UserID, req.ProviderKey)
	if err != nil {
		if errors.Is(err, ErrProviderNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, UserModelProviderGetCipherResponse{
				Ok:    false,
				Error: "Provider not found",
				Code:  "PROVIDER_NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, UserModelProviderGetCipherResponse{
		Ok:     true,
		APIKey: cipher,
	})
}
