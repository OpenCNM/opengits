package userinteraction

import (
	"errors"
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type UserModelProvidersListRequest struct {
	UserID string `json:"userId"`
}

// UserModelProvidersListResponse represents response with user model providers.
type UserModelProvidersListResponse struct {
	Ok        bool                    `json:"ok"`
	Providers []UserModelProviderView `json:"providers"`
	Error     string                  `json:"error,omitempty"`
}

// HandleUserModelProvidersList handles POST /v1/user/model-providers/list.
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

// UserModelProviderUpsertRequest represents request to upsert a model provider.
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

// UserModelProviderUpsertResponse represents response of provider upsert.
type UserModelProviderUpsertResponse struct {
	Ok       bool                   `json:"ok"`
	Provider *UserModelProviderView `json:"provider,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Code     string                 `json:"code,omitempty"`
}

// HandleUserModelProviderUpsert handles POST /v1/user/model-providers/upsert.
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

// UserModelProviderPatchRequest represents request to patch a model provider.
type UserModelProviderPatchRequest struct {
	UserID        string  `json:"userId"`
	ProviderKey   string  `json:"providerKey"`
	SelectedModel *string `json:"selectedModel,omitempty"`
	MakeActive    *bool   `json:"makeActive,omitempty"`
}

// UserModelProviderPatchResponse represents response of provider patch.
type UserModelProviderPatchResponse struct {
	Ok       bool                   `json:"ok"`
	Provider *UserModelProviderView `json:"provider,omitempty"`
	Error    string                 `json:"error,omitempty"`
	Code     string                 `json:"code,omitempty"`
}

// HandleUserModelProviderPatch handles POST /v1/user/model-providers/patch.
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

// UserModelProviderDeleteRequest represents request to delete a model provider.
type UserModelProviderDeleteRequest struct {
	UserID      string `json:"userId"`
	ProviderKey string `json:"providerKey"`
}

// UserModelProviderDeleteResponse represents response of provider deletion.
type UserModelProviderDeleteResponse struct {
	Ok      bool   `json:"ok"`
	Deleted bool   `json:"deleted,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

// HandleUserModelProviderDelete handles POST /v1/user/model-providers/delete.
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

// UserModelProviderGetCipherRequest represents request to get provider cipher key.
type UserModelProviderGetCipherRequest struct {
	UserID      string `json:"userId"`
	ProviderKey string `json:"providerKey"`
}

// UserModelProviderGetCipherResponse represents response containing cipher key.
type UserModelProviderGetCipherResponse struct {
	Ok     bool   `json:"ok"`
	APIKey string `json:"apiKey,omitempty"`
	Error  string `json:"error,omitempty"`
	Code   string `json:"code,omitempty"`
}

// HandleUserModelProviderGetCipher handles POST /v1/user/model-providers/get-cipher.
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
