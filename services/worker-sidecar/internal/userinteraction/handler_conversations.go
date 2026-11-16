package userinteraction

import (
	"errors"
	"net/http"
	"strings"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type ConversationsListRequest struct {
	Owner  string `json:"owner"`
	Repo   string `json:"repo"`
	UserID string `json:"userId"`
}

// ConversationsListResponse returns the list of conversations.
type ConversationsListResponse struct {
	Ok            bool                  `json:"ok"`
	Conversations []ConversationSummary `json:"conversations"`
	Error         string                `json:"error,omitempty"`
	Code          string                `json:"code,omitempty"`
}

// HandleConversationsList handles POST /v1/conversations/list.
func (h *Handler) HandleConversationsList(w http.ResponseWriter, r *http.Request) {
	var req ConversationsListRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.Owner == "" || req.Repo == "" {
		httpx.Error(w, http.StatusBadRequest, "Missing owner or repo")
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

	conversations, err := h.store.ListConversations(r.Context(), req.Owner, req.Repo, req.UserID)
	if err != nil {
		if errors.Is(err, ErrRepositoryNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, ConversationsListResponse{
				Ok:    false,
				Error: "Repository not found",
				Code:  "NOT_FOUND",
			})
			return
		}
		if errors.Is(err, ErrRepositoryForbidden) {
			httpx.WriteJSON(w, http.StatusForbidden, ConversationsListResponse{
				Ok:    false,
				Error: "Forbidden: You do not have access to this repository",
				Code:  "FORBIDDEN",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ConversationsListResponse{
		Ok:            true,
		Conversations: conversations,
	})
}

// ConversationMessagesRequest represents query for messages of a conversation.
type ConversationMessagesRequest struct {
	ConversationID string `json:"conversationId"`
	UserID         string `json:"userId"`
}

// ConversationMessagesResponse returns the list of messages.
type ConversationMessagesResponse struct {
	Ok       bool                      `json:"ok"`
	Messages []ConversationMessageItem `json:"messages"`
	Error    string                    `json:"error,omitempty"`
	Code     string                    `json:"code,omitempty"`
}

// HandleConversationMessages handles POST /v1/conversations/messages.
func (h *Handler) HandleConversationMessages(w http.ResponseWriter, r *http.Request) {
	var req ConversationMessagesRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.ConversationID == "" {
		httpx.Error(w, http.StatusBadRequest, "conversationId is required")
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

	messages, err := h.store.GetConversationMessages(r.Context(), req.ConversationID, req.UserID)
	if err != nil {
		if errors.Is(err, ErrConversationNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, ConversationMessagesResponse{
				Ok:    false,
				Error: "Conversation not found",
				Code:  "NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ConversationMessagesResponse{
		Ok:       true,
		Messages: messages,
	})
}

// UserPreferencesSetRequest represents request to update user preferences.

type ConversationCreateRequest struct {
	Owner        string `json:"owner,omitempty"`
	Repo         string `json:"repo,omitempty"`
	RepositoryID string `json:"repositoryId,omitempty"`
	UserID       string `json:"userId"`
	Title        string `json:"title,omitempty"`
}

// ConversationCreateResponse returns the created conversation record.
type ConversationCreateResponse struct {
	Ok           bool                `json:"ok"`
	Conversation *ConversationRecord `json:"conversation,omitempty"`
	Error        string              `json:"error,omitempty"`
	Code         string              `json:"code,omitempty"`
}

// HandleConversationCreate handles POST /v1/conversations/create.
func (h *Handler) HandleConversationCreate(w http.ResponseWriter, r *http.Request) {
	var req ConversationCreateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.RepositoryID == "" && (req.Owner == "" || req.Repo == "") {
		httpx.Error(w, http.StatusBadRequest, "Missing owner or repo")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	conv, err := h.store.CreateConversation(r.Context(), ConversationCreateInput{
		Owner:        req.Owner,
		Repo:         req.Repo,
		RepositoryID: req.RepositoryID,
		UserID:       req.UserID,
		Title:        req.Title,
	})
	if err != nil {
		if errors.Is(err, ErrRepositoryNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, ConversationCreateResponse{
				Ok:    false,
				Error: "Repository not found",
				Code:  "NOT_FOUND",
			})
			return
		}
		if errors.Is(err, ErrRepositoryForbidden) {
			httpx.WriteJSON(w, http.StatusForbidden, ConversationCreateResponse{
				Ok:    false,
				Error: "Forbidden: You do not have access to this repository",
				Code:  "FORBIDDEN",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ConversationCreateResponse{
		Ok:           true,
		Conversation: conv,
	})
}

// ConversationUpdateRequest represents request to update conversation title.
type ConversationUpdateRequest struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
	Title  string `json:"title"`
}

// ConversationUpdateResponse returns updated conversation record.
type ConversationUpdateResponse struct {
	Ok           bool                `json:"ok"`
	Conversation *ConversationRecord `json:"conversation,omitempty"`
	Error        string              `json:"error,omitempty"`
	Code         string              `json:"code,omitempty"`
}

// HandleConversationUpdate handles POST /v1/conversations/update.
func (h *Handler) HandleConversationUpdate(w http.ResponseWriter, r *http.Request) {
	var req ConversationUpdateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
		return
	}
	if req.ID == "" {
		httpx.Error(w, http.StatusBadRequest, "id is required")
		return
	}
	if strings.TrimSpace(req.Title) == "" {
		httpx.Error(w, http.StatusBadRequest, "Title cannot be empty")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	conv, err := h.store.UpdateConversation(r.Context(), ConversationUpdateInput{
		ID:     req.ID,
		UserID: req.UserID,
		Title:  req.Title,
	})
	if err != nil {
		if errors.Is(err, ErrConversationNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, ConversationUpdateResponse{
				Ok:    false,
				Error: "Conversation not found",
				Code:  "NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ConversationUpdateResponse{
		Ok:           true,
		Conversation: conv,
	})
}

// ConversationDeleteRequest represents request to delete a conversation.
type ConversationDeleteRequest struct {
	ID     string `json:"id"`
	UserID string `json:"userId"`
}

// ConversationDeleteResponse returns deletion status.
type ConversationDeleteResponse struct {
	Ok      bool   `json:"ok"`
	Message string `json:"message,omitempty"`
	Error   string `json:"error,omitempty"`
	Code    string `json:"code,omitempty"`
}

// HandleConversationDelete handles POST /v1/conversations/delete.
func (h *Handler) HandleConversationDelete(w http.ResponseWriter, r *http.Request) {
	var req ConversationDeleteRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusUnauthorized, "Unauthorized")
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

	err := h.store.DeleteConversation(r.Context(), ConversationDeleteInput{
		ID:     req.ID,
		UserID: req.UserID,
	})
	if err != nil {
		if errors.Is(err, ErrConversationNotFound) {
			httpx.WriteJSON(w, http.StatusNotFound, ConversationDeleteResponse{
				Ok:    false,
				Error: "Conversation not found",
				Code:  "NOT_FOUND",
			})
			return
		}
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, ConversationDeleteResponse{
		Ok:      true,
		Message: "Conversation deleted",
	})
}

// McpTokenCreateRequest represents request to create a new MCP API token.
