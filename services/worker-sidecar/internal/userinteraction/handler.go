package userinteraction

type Handler struct {
	store    Store
	onResume func()
}

func NewHandler(store Store) *Handler {
	return &Handler{store: store}
}

func (h *Handler) SetOnResume(fn func()) {
	h.onResume = fn
}
