package webdoc

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"sync"

	"golang.org/x/sync/singleflight"
	"time"

	"github.com/temoto/robotstxt"
)

type robotsRules struct {
	data *robotstxt.RobotsData
}

type robotsCacheEntry struct {
	rules     *robotsRules
	expiresAt time.Time
}

const (
	robotsCacheTTLSuccess = 24 * time.Hour
	robotsCacheTTLError   = time.Hour
)

var (
	robotsCache   = map[string]*robotsCacheEntry{}
	robotsCacheMu sync.Mutex
	// Deduplicate robots.txt fetches per origin so one slow host never blocks unrelated origins.
	robotsSF singleflight.Group
)

func RespectRobotsEnabled() bool {
	return os.Getenv("WEB_CRAWLER_RESPECT_ROBOTS") != "false"
}

func PolitenessDelayMs() int {
	if v := strings.TrimSpace(os.Getenv("WEB_CRAWLER_POLITENESS_DELAY_MS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 250
}

func DefaultMaxPages() int {
	if v := strings.TrimSpace(os.Getenv("WEB_CRAWLER_MAX_PAGES")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 1000
}

func IsUrlAllowedByRobots(ctx context.Context, rawURL string) bool {
	if !RespectRobotsEnabled() {
		return true
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return true
	}
	origin := fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	rules := robotsRulesForOrigin(ctx, origin)
	if rules == nil {
		return true
	}
	// Include raw query in matchKey so Disallow rules like /*? evaluate per Google robots spec.
	matchKey := parsed.EscapedPath()
	if parsed.RawQuery != "" {
		matchKey += "?" + parsed.RawQuery
	}
	return rules.data.TestAgent(matchKey, "*")
}

func ExtractRobotsSitemaps(ctx context.Context, rawURL string) []string {
	parsed, err := url.Parse(strings.TrimSpace(rawURL))
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return nil
	}
	origin := fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	rules := robotsRulesForOrigin(ctx, origin)
	if rules == nil || rules.data == nil || len(rules.data.Sitemaps) == 0 {
		return nil
	}
	baseOriginURL, _ := url.Parse(origin)
	seen := make(map[string]bool, len(rules.data.Sitemaps))
	out := make([]string, 0, len(rules.data.Sitemaps))
	for _, rawSm := range rules.data.Sitemaps {
		sm := strings.TrimSpace(rawSm)
		if sm == "" {
			continue
		}
		if baseOriginURL != nil {
			if u, perr := url.Parse(sm); perr == nil {
				sm = baseOriginURL.ResolveReference(u).String()
			}
		}
		if !seen[sm] {
			seen[sm] = true
			out = append(out, sm)
		}
	}
	return out
}

func robotsRulesForOrigin(ctx context.Context, origin string) *robotsRules {
	if e := robotsLookup(origin); e != nil {
		return e.rules
	}
	v, _, _ := robotsSF.Do(origin, func() (any, error) {
		if e := robotsLookup(origin); e != nil {
			return e.rules, nil
		}
		rules, ttl := fetchRobotsRules(ctx, origin)
		robotsStore(origin, rules, ttl)
		return rules, nil
	})
	if r, ok := v.(*robotsRules); ok {
		return r
	}
	return nil
}

func robotsLookup(origin string) *robotsCacheEntry {
	robotsCacheMu.Lock()
	defer robotsCacheMu.Unlock()
	e, ok := robotsCache[origin]
	if !ok {
		return nil
	}
	if time.Now().Before(e.expiresAt) {
		return e
	}
	delete(robotsCache, origin)
	return nil
}

func robotsStore(origin string, rules *robotsRules, ttl time.Duration) {
	robotsCacheMu.Lock()
	robotsCache[origin] = &robotsCacheEntry{rules: rules, expiresAt: time.Now().Add(ttl)}
	robotsCacheMu.Unlock()
}

// Fail closed (disallow all for 1h) on 5xx upstream errors; fail open on local transport errors or 404.
func fetchRobotsRules(ctx context.Context, origin string) (*robotsRules, time.Duration) {
	fetchCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()

	req, err := http.NewRequestWithContext(fetchCtx, http.MethodGet, origin+"/robots.txt", nil)
	if err != nil {
		return nil, robotsCacheTTLError
	}
	if ua := os.Getenv("WEB_CRAWLER_USER_AGENT"); ua != "" {
		req.Header.Set("User-Agent", ua)
	}
	client := NewSafeHTTPClient(5*time.Second, 1)
	resp, err := client.Do(req)
	if err != nil {
		return nil, robotsCacheTTLError
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 500 {
		return disallowAllRobots(), robotsCacheTTLError
	}
	if resp.StatusCode != http.StatusOK {
		return nil, robotsCacheTTLError
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, robotsCacheTTLError
	}
	return parseRobotsForUA(string(body)), robotsCacheTTLSuccess
}

func disallowAllRobots() *robotsRules {
	return parseRobotsForUA("User-agent: *\nDisallow: /\n")
}

func parseRobotsForUA(body string) *robotsRules {
	data, err := robotstxt.FromStatusAndBytes(http.StatusOK, []byte(body))
	if err != nil {
		return nil
	}
	return &robotsRules{data: data}
}

func resetRobotsCache() {
	robotsCacheMu.Lock()
	robotsCache = map[string]*robotsCacheEntry{}
	robotsCacheMu.Unlock()
}
