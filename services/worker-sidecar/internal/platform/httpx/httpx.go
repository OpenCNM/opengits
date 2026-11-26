package httpx

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Tiered body ceilings (1MB metadata, 10MB standard, 20MB sniff) bound memory against oversized payloads.
const (
	LimitSmall  int64 = 1 << 20
	LimitMedium int64 = 10 << 20
	LimitLarge  int64 = 20 << 20
)

func ReadJSON(w http.ResponseWriter, r *http.Request, dst any, limitBytes int64) bool {
	if r == nil || r.Body == nil {
		Error(w, http.StatusBadRequest, "request body is missing")
		return false
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, limitBytes+1))
	if err != nil {
		Error(w, http.StatusBadRequest, "failed to read request body: "+err.Error())
		return false
	}
	if int64(len(body)) > limitBytes {
		Error(w, http.StatusRequestEntityTooLarge, "request body exceeds limit")
		return false
	}
	if err := json.Unmarshal(body, dst); err != nil {
		Error(w, http.StatusBadRequest, "invalid json payload: "+err.Error())
		return false
	}
	return true
}

func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func Error(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

type SegmentField struct {
	Name  string
	Value string
}

// Reject path separators and traversal segments before joining archive paths.
func AssertSafeSegment(seg string) error {
	if seg == "" || seg == "." || strings.Contains(seg, "..") || strings.Contains(seg, "/") || strings.Contains(seg, "\\") || strings.Contains(seg, "\x00") {
		return fmt.Errorf("unsafe path segment: %q", seg)
	}
	return nil
}

func AssertSegments(w http.ResponseWriter, fields ...SegmentField) bool {
	for _, f := range fields {
		if err := AssertSafeSegment(f.Value); err != nil {
			Error(w, http.StatusBadRequest, fmt.Sprintf("invalid path segment in %s: %s", f.Name, err.Error()))
			return false
		}
	}
	return true
}
