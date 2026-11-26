package userinteraction

import (
	"encoding/json"
	"net/http"

	"github.com/opengits/worker-sidecar/internal/platform/httpx"
)

type NotificationsReadRequest struct {
	UserID string   `json:"userId"`
	IDs    []string `json:"ids"`
	All    bool     `json:"all"`
}

type NotificationsReadResponse struct {
	Ok      bool  `json:"ok"`
	Updated int64 `json:"updated"`
}

func (h *Handler) HandleNotificationsRead(w http.ResponseWriter, r *http.Request) {
	var req NotificationsReadRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId is required")
		return
	}

	if !req.All && len(req.IDs) == 0 {
		httpx.Error(w, http.StatusBadRequest, "ids or all is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	count, err := h.store.MarkNotificationsRead(r.Context(), req.UserID, req.IDs, req.All)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, NotificationsReadResponse{
		Ok:      true,
		Updated: count,
	})
}

type NotificationsListRequest struct {
	UserID   string `json:"userId"`
	Page     int    `json:"page"`
	PageSize int    `json:"pageSize"`
}

type NotificationsListResponse struct {
	Ok          bool               `json:"ok"`
	Items       []NotificationItem `json:"items"`
	Total       int64              `json:"total"`
	UnreadCount int64              `json:"unreadCount"`
}

func (h *Handler) HandleNotificationsList(w http.ResponseWriter, r *http.Request) {
	var req NotificationsListRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	res, err := h.store.ListNotifications(r.Context(), req.UserID, req.Page, req.PageSize)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, NotificationsListResponse{
		Ok:          true,
		Items:       res.Items,
		Total:       res.Total,
		UnreadCount: res.UnreadCount,
	})
}

type NotificationItemPayload struct {
	UserID  string          `json:"userId"`
	Type    string          `json:"type"`
	Title   string          `json:"title"`
	Body    *string         `json:"body,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type NotificationCreateRequest struct {
	Notifications []NotificationItemPayload `json:"notifications"`
}

type NotificationCreateResponse struct {
	Ok    bool   `json:"ok"`
	Count int    `json:"count"`
	Error string `json:"error,omitempty"`
}

func (h *Handler) HandleNotificationsCreate(w http.ResponseWriter, r *http.Request) {
	var req NotificationCreateRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitLarge) {
		return
	}
	if len(req.Notifications) == 0 {
		httpx.WriteJSON(w, http.StatusOK, NotificationCreateResponse{Ok: true, Count: 0})
		return
	}
	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	items := make([]CreateNotificationInput, 0, len(req.Notifications))
	for _, n := range req.Notifications {
		items = append(items, CreateNotificationInput{
			UserID:  n.UserID,
			Type:    n.Type,
			Title:   n.Title,
			Body:    n.Body,
			Payload: n.Payload,
		})
	}

	if err := h.store.CreateNotifications(r.Context(), items); err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, NotificationCreateResponse{
		Ok:    true,
		Count: len(items),
	})
}

type NotificationsClearRequest struct {
	UserID string `json:"userId"`
}

type NotificationsClearResponse struct {
	Ok      bool  `json:"ok"`
	Deleted int64 `json:"deleted"`
}

func (h *Handler) HandleNotificationsClear(w http.ResponseWriter, r *http.Request) {
	var req NotificationsClearRequest
	if !httpx.ReadJSON(w, r, &req, httpx.LimitSmall) {
		return
	}

	if req.UserID == "" {
		httpx.Error(w, http.StatusBadRequest, "userId is required")
		return
	}

	if h.store == nil {
		httpx.Error(w, http.StatusInternalServerError, "store is not available")
		return
	}

	deleted, err := h.store.ClearNotifications(r.Context(), req.UserID)
	if err != nil {
		httpx.Error(w, http.StatusInternalServerError, err.Error())
		return
	}

	httpx.WriteJSON(w, http.StatusOK, NotificationsClearResponse{
		Ok:      true,
		Deleted: deleted,
	})
}
