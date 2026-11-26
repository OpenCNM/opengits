package sse

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/opengits/worker-sidecar/internal/platform/authtoken"
)

type AuthResolver struct {
	cfg       Config
	store     Store
	authCache *SessionAuthCache
	client    *http.Client
}

func NewAuthResolver(cfg Config, store Store, cache *SessionAuthCache) *AuthResolver {
	return &AuthResolver{
		cfg:       cfg,
		store:     store,
		authCache: cache,
		client: &http.Client{
			Timeout: 5 * time.Second,
		},
	}
}

type verifySessionResponse struct {
	Valid  bool    `json:"valid"`
	UserId string  `json:"userId"`
	Error  *string `json:"error,omitempty"`
}

func (a *AuthResolver) ResolveAuth(ctx context.Context, r *http.Request) (string, bool, error) {
	internalToken := r.Header.Get("x-internal-token")
	isInternalTokenValid := !authtoken.RefuseInsecureDefault(a.cfg.InternalToken, a.cfg.AppEnv) &&
		tokenEquals(internalToken, a.cfg.InternalToken)
	if isInternalTokenValid {
		uid := r.Header.Get("x-user-id")
		if uid != "" {
			return uid, true, nil
		}
		// Do not assume "internal" when internal token lacks x-user-id; continue resolving end-user Token or Cookie.
	}

	rawToken := ""
	authHeader := r.Header.Get("authorization")
	if strings.HasPrefix(strings.ToLower(authHeader), "bearer ") {
		rawToken = strings.TrimSpace(authHeader[7:])
	}
	if rawToken == "" {
		rawToken = r.URL.Query().Get("token")
	}

	if rawToken != "" {
		tokenHash := sha256Hex(rawToken)
		userId, err := a.store.GetUserIdByMcpToken(ctx, tokenHash)
		if err == nil && userId != "" {
			return userId, true, nil
		}
	}

	sessionCookie := extractSessionCookie(r)
	if sessionCookie != "" {
		cookieHash := sha256Hex(sessionCookie)
		if uid, ok := a.authCache.Get(cookieHash); ok {
			return uid, true, nil
		}

		uid, err := a.verifySessionWithWeb(ctx, sessionCookie)
		if err == nil && uid != "" {
			a.authCache.Set(cookieHash, uid, 5*time.Minute)
			return uid, true, nil
		}
	}

	if isInternalTokenValid {
		return "internal", true, nil
	}

	return "", false, nil
}

func extractSessionCookie(r *http.Request) string {
	raw := r.Header.Get("Cookie")
	if raw != "" && (strings.Contains(raw, "next-auth.session-token") || strings.Contains(raw, "__Secure-next-auth.session-token")) {
		return raw
	}
	var parts []string
	for _, c := range r.Cookies() {
		if strings.HasPrefix(c.Name, "next-auth.session-token") || strings.HasPrefix(c.Name, "__Secure-next-auth.session-token") {
			parts = append(parts, c.Name+"="+c.Value)
		}
	}
	if len(parts) > 0 {
		return strings.Join(parts, "; ")
	}
	return ""
}

func (a *AuthResolver) webBaseURL() string {
	if a.cfg.WebInternalURL != "" {
		return a.cfg.WebInternalURL
	}
	if a.cfg.LlmGatewayURL != "" {
		return a.cfg.LlmGatewayURL
	}
	return "http://web:3000"
}

func (a *AuthResolver) verifySessionWithWeb(ctx context.Context, rawCookie string) (string, error) {
	targetUrl := strings.TrimRight(a.webBaseURL(), "/") + "/api/internal/auth/verify-session"

	bodyBytes, _ := json.Marshal(map[string]string{"cookie": rawCookie})
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, targetUrl, bytes.NewReader(bodyBytes))
	if err != nil {
		return "", err
	}

	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("x-internal-token", a.cfg.InternalToken)

	resp, err := a.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("verify session request failed: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("verify session status %d", resp.StatusCode)
	}

	var result verifySessionResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", fmt.Errorf("failed to decode verify response: %w", err)
	}

	if !result.Valid || result.UserId == "" {
		return "", fmt.Errorf("session invalid")
	}

	return result.UserId, nil
}

func tokenEquals(provided, expected string) bool {
	if expected == "" || provided == "" {
		return false
	}
	ph := sha256.Sum256([]byte(provided))
	eh := sha256.Sum256([]byte(expected))
	return subtle.ConstantTimeCompare(ph[:], eh[:]) == 1
}

func sha256Hex(s string) string {
	h := sha256.Sum256([]byte(s))
	return hex.EncodeToString(h[:])
}
