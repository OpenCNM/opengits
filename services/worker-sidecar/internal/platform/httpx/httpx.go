package httpx

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
)

// Standard body limit tiers.
const (
	LimitSmall  int64 = 1 << 20  // 1MB: metadata/segment checks (archive ensure/tree/diff)
	LimitMedium int64 = 10 << 20 // 10MB: standard computation payloads (chunk/diff/graph/sanitize)
	LimitLarge  int64 = 20 << 20 // 20MB: bulk enumeration/sniff payloads (archive sniff)
)

// ReadJSON reads and unmarshals JSON request body with a hard limitBytes ceiling.
// Returns false if reading or unmarshaling fails (appropriate 400 or 413 error written).
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

// WriteJSON sends a successful JSON response with explicit status code and Content-Type.
func WriteJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Error writes a standardized error envelope {"error": msg} with JSON Content-Type.
func Error(w http.ResponseWriter, status int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// SegmentField represents a name-value pair for path segment safety validation.
type SegmentField struct {
	Name  string
	Value string
}

// AssertSafeSegment ensures a path segment contains no path traversal characters.
func AssertSafeSegment(seg string) error {
	if seg == "" || seg == "." || strings.Contains(seg, "..") || strings.Contains(seg, "/") || strings.Contains(seg, "\\") || strings.Contains(seg, "\x00") {
		return fmt.Errorf("unsafe path segment: %q", seg)
	}
	return nil
}

// AssertSegments validates each SegmentField for path traversal safety;
// returns false and writes a 400 error on the first invalid segment.
func AssertSegments(w http.ResponseWriter, fields ...SegmentField) bool {
	for _, f := range fields {
		if err := AssertSafeSegment(f.Value); err != nil {
			Error(w, http.StatusBadRequest, fmt.Sprintf("invalid path segment in %s: %s", f.Name, err.Error()))
			return false
		}
	}
	return true
}
