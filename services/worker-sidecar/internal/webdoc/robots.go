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

// ─────────────────────────────────────────────────────────────
// robots.txt 合规与礼貌限速（对齐 apps/client/src/engine/web-doc/robots.ts
// 的 politeness 语义；规则解析与匹配下沉 temoto/robotstxt——Google 规范
// 实现：最长匹配优先、平局 Allow 胜、`*` 通配与 `$` 锚定均原生支持）：
// - 仅以 `*` UA 组求值（爬虫以浏览器 UA 抓取，只受通配组约束）
// - 匹配键含 query（Google 规范：`Disallow: /*?` 这类拦参数 URL 的
//   规则必须命中——只比 path 会让站点反爬规则整类失效）
// - 5xx 失效封闭为全站禁抓（Google unreachable 语义）；传输层错误
//  （我方网络问题）仍放行
// - origin 级缓存带 TTL（成功 24h / 否定与禁抓 1h——站点中途加规矩
//   不必等进程重启才生效）
// ─────────────────────────────────────────────────────────────

// robotsRules 单 origin 的 robots 判定器（robotstxt 解析结果封装）。
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
	// robotsSF per-origin 抓取单飞——替代旧全局单锁（此前任意 origin 的
	// robots 抓取会串行化所有 origin 的等待）。TTL 按结果差异化
	//（成功 24h/失败 1h 负缓存）保留原 entry 结构，不并统一缓存组件。
	robotsSF singleflight.Group
)

// RespectRobotsEnabled WEB_CRAWLER_RESPECT_ROBOTS !== 'false'（默认 true）。
func RespectRobotsEnabled() bool {
	return os.Getenv("WEB_CRAWLER_RESPECT_ROBOTS") != "false"
}

// PolitenessDelayMs WEB_CRAWLER_POLITENESS_DELAY_MS（默认 250，≤0 禁用；
// 对齐 Node 历史默认值——TS 侧 webCrawler 配置键已退役，env 为 SSOT）。
func PolitenessDelayMs() int {
	if v := strings.TrimSpace(os.Getenv("WEB_CRAWLER_POLITENESS_DELAY_MS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return 250
}

// DefaultMaxPages WEB_CRAWLER_MAX_PAGES（默认 1000，对齐 Node
// ENGINE_CONFIG.webCrawler.defaultMaxPages）。
func DefaultMaxPages() int {
	if v := strings.TrimSpace(os.Getenv("WEB_CRAWLER_MAX_PAGES")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 1000
}

// IsUrlAllowedByRobots URL 是否受 robots.txt 许可（传输层失败/解析失败/
// 开关关闭放行；站点 5xx → 全站禁抓）。
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
		return true // 传输层失败（我方网络）：放行
	}
	// 匹配键必须含 query：robotstxt 的 TestAgent 是对给定串做最长前缀/
	// 通配匹配，拼上 ?query 后 `/*?`、`/*.php$` 等规则才能按 Google
	// 规范命中（只喂 path 时这类规则整类失效）。
	matchKey := parsed.EscapedPath()
	if parsed.RawQuery != "" {
		matchKey += "?" + parsed.RawQuery
	}
	return rules.data.TestAgent(matchKey, "*")
}

// ExtractRobotsSitemaps 从已缓存的 {origin}/robots.txt 读取 Sitemap 声明列表（零额外 HTTP）。
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

// robotsRulesForOrigin origin 级缓存（带 TTL）+ per-origin 单飞抓取。
func robotsRulesForOrigin(ctx context.Context, origin string) *robotsRules {
	if e := robotsLookup(origin); e != nil {
		return e.rules
	}
	v, _, _ := robotsSF.Do(origin, func() (any, error) {
		// 单飞双检：等待期间他者已填充
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
	delete(robotsCache, origin) // 过期重取：站点规矩中途变更可生效
	return nil
}

func robotsStore(origin string, rules *robotsRules, ttl time.Duration) {
	robotsCacheMu.Lock()
	robotsCache[origin] = &robotsCacheEntry{rules: rules, expiresAt: time.Now().Add(ttl)}
	robotsCacheMu.Unlock()
}

// fetchRobotsRules GET {origin}/robots.txt。
// 返回 (rules, ttl)：5xx → 全站禁抓（Google unreachable 规范，失效封闭，
// 短 TTL 1h 防瞬时故障误封过长）；传输层错误 → nil 放行（我方网络问题，
// 同样 1h 负缓存）；404/解析失败 → nil 放行（无规矩）。
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
		// 站点侧持续 5xx：按规范视为"全站不允许抓"（失效封闭），
		// 否则被拦站点的反爬规则形同虚设
		return disallowAllRobots(), robotsCacheTTLError
	}
	if resp.StatusCode != http.StatusOK {
		return nil, robotsCacheTTLError // 404 等：无 robots = 不限制（规范语义）
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return nil, robotsCacheTTLError
	}
	return parseRobotsForUA(string(body)), robotsCacheTTLSuccess
}

// disallowAllRobots 全站禁抓规则（5xx 失效封闭用）。
func disallowAllRobots() *robotsRules {
	return parseRobotsForUA("User-agent: *\nDisallow: /\n")
}

// parseRobotsForUA 解析 robots.txt（`*` 组求值；200 状态语义）。
// 解析失败返回 nil → 上游放行（无规矩等同）。
func parseRobotsForUA(body string) *robotsRules {
	data, err := robotstxt.FromStatusAndBytes(http.StatusOK, []byte(body))
	if err != nil {
		return nil
	}
	return &robotsRules{data: data}
}

// resetRobotsCache 测试钩子（原对齐 Node __resetRobotsCache；TS 原体已退役）。
func resetRobotsCache() {
	robotsCacheMu.Lock()
	robotsCache = map[string]*robotsCacheEntry{}
	robotsCacheMu.Unlock()
}
