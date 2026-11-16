package webdoc

import (
	"compress/gzip"
	"context"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ─────────────────────────────────────────────────────────────
// WebDoc Sitemap 增量差分检测器 (Go 原生化)
// 对齐 apps/client/src/engine/web-doc/diff-detector.ts 契约：
// - 流式 XML 解析，支持 <urlset> 与 <sitemapindex> 两级递归
// - HTTP ETag / If-None-Match 条件嗅探，304 时微秒级零配额短路
// - 三向差分输出：pagesToAdd, pagesToUpdate, pagesToRemove
// ─────────────────────────────────────────────────────────────

type xmlURLItem struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod"`
}

type xmlSitemapItem struct {
	Loc     string `xml:"loc"`
	LastMod string `xml:"lastmod"`
}

// ParseSitemapXML 流式解析 Sitemap XML（可来自纯内存或网络流），
// 返回当前解析出的 (urls map[loc]lastmod, childSitemaps []loc, err)。
// parseSitemapTime 解析 sitemap lastmod（W3C 子集：ISO-8601 日期或日期时间），
// 失败返回零值（调用方退回字符串比较）。
func parseSitemapTime(v string) time.Time {
	for _, layout := range []string{time.RFC3339, "2006-01-02T15:04:05", "2006-01-02"} {
		if t, err := time.Parse(layout, v); err == nil {
			return t
		}
	}
	return time.Time{}
}

func ParseSitemapXML(r io.Reader) (map[string]string, []string, error) {
	decoder := xml.NewDecoder(r)
	decoder.Strict = false
	urls := make(map[string]string)
	var childSitemaps []string

	for {
		token, err := decoder.Token()
		if err != nil {
			if errors.Is(err, io.EOF) {
				break
			}
			return urls, childSitemaps, err
		}

		se, ok := token.(xml.StartElement)
		if !ok {
			continue
		}

		switch strings.ToLower(se.Name.Local) {
		case "url":
			var item xmlURLItem
			if err := decoder.DecodeElement(&item, &se); err == nil {
				loc := strings.TrimSpace(item.Loc)
				if loc != "" {
					urls[loc] = strings.TrimSpace(item.LastMod)
				}
			}
		case "sitemap":
			var item xmlSitemapItem
			if err := decoder.DecodeElement(&item, &se); err == nil {
				loc := strings.TrimSpace(item.Loc)
				if loc != "" {
					childSitemaps = append(childSitemaps, loc)
				}
			}
		}
	}

	return urls, childSitemaps, nil
}

// ComputeWebDocDiff 纯函数集合差分计算（支持黄金夹具对拍与零副作用单测）。
func ComputeWebDocDiff(currentUrls map[string]string, prevSitemap map[string]string, newEtag string, rootURL string) *WebDocDiffResult {
	if len(currentUrls) == 0 {
		return &WebDocDiffResult{
			HasChanges:        true,
			ETag:              newEtag,
			SitemapLastModMap: make(map[string]string),
			TotalPages:        0,
			PagesToAdd:        []string{rootURL},
			PagesToUpdate:     []string{},
			PagesToRemove:     []string{},
			TotalChanged:      1,
		}
	}

	pagesToAdd := make([]string, 0)
	pagesToUpdate := make([]string, 0)
	pagesToRemove := make([]string, 0)

	// 对比新增与修改（按键排序保证稳定确定性）
	currKeys := make([]string, 0, len(currentUrls))
	for k := range currentUrls {
		currKeys = append(currKeys, k)
	}
	sort.Strings(currKeys)

	// lastmod 时间预解析（每 URL 此前最多 4 次 time.Parse 尝试 ×2 调用；
	// 万页 sitemap 可感知）
	parsedCurr := make(map[string]time.Time, len(currentUrls))
	for _, url := range currKeys {
		parsedCurr[url] = parseSitemapTime(currentUrls[url])
	}
	parsedPrev := make(map[string]time.Time, len(prevSitemap))
	for url, mod := range prevSitemap {
		parsedPrev[url] = parseSitemapTime(mod)
	}

	for _, url := range currKeys {
		lastmod := currentUrls[url]
		prevMod, exists := prevSitemap[url]
		currT, prevT := parsedCurr[url], parsedPrev[url]
		switch {
		case !exists:
			pagesToAdd = append(pagesToAdd, url)
		case lastmod == "" || prevMod == "":
			// 无 lastmod 无法做增量判定：视为已更新。旧实现直接跳过——
			// 空 lastmod 的静态站（生成器常见）内容变更被永久漏同步，
			// 外层 sitemap ETag/304 短路保证抓取开销可控。
			pagesToUpdate = append(pagesToUpdate, url)
		case currT != (time.Time{}) && currT != prevT:
			// 时间语义比较：字符串比较会把 Z 与 +00:00 等合法等价格式
			// 判为"已更新"，每轮全量误报。
			pagesToUpdate = append(pagesToUpdate, url)
		case currT == (time.Time{}):
			// 双侧均非法时间字面量：退回字符串比较（确定性）
			if lastmod != prevMod {
				pagesToUpdate = append(pagesToUpdate, url)
			}
		}
	}

	// 对比删除（按键排序）
	prevKeys := make([]string, 0, len(prevSitemap))
	for k := range prevSitemap {
		prevKeys = append(prevKeys, k)
	}
	sort.Strings(prevKeys)

	for _, url := range prevKeys {
		if _, exists := currentUrls[url]; !exists {
			pagesToRemove = append(pagesToRemove, url)
		}
	}

	totalChanged := len(pagesToAdd) + len(pagesToUpdate) + len(pagesToRemove)
	return &WebDocDiffResult{
		HasChanges:        totalChanged > 0,
		ETag:              newEtag,
		TotalPages:        len(currentUrls),
		SitemapLastModMap: currentUrls,
		PagesToAdd:        pagesToAdd,
		PagesToUpdate:     pagesToUpdate,
		PagesToRemove:     pagesToRemove,
		TotalChanged:      totalChanged,
	}
}

// DetectWebDocDiff 执行网络探测与 Sitemap 差分。
func DetectWebDocDiff(ctx context.Context, rootURL string, prevEtag string, prevLastMod map[string]string, timeout time.Duration) (*WebDocDiffResult, error) {
	if timeout <= 0 {
		timeout = 8 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	parsed, err := url.Parse(rootURL)
	if err != nil || !IsPublicEndpoint(rootURL) {
		return &WebDocDiffResult{
			HasChanges:    true,
			PagesToAdd:    []string{rootURL},
			PagesToUpdate: []string{},
			PagesToRemove: []string{},
			TotalChanged:  1,
		}, nil
	}

	client := NewSafeHTTPClient(timeout, 3)
	candidates := buildSitemapCandidates(ctx, rootURL, parsed)
	tried := make(map[string]bool, len(candidates)+4)
	for _, sitemapURL := range candidates {
		tried[sitemapURL] = true
		diff, matched, ctxErr := probeSingleSitemap(ctx, client, sitemapURL, prevEtag, prevLastMod, rootURL)
		if ctxErr != nil {
			return nil, ctxErr
		}
		if matched && diff != nil {
			return diff, nil
		}
	}

	// 根入口仅当 /sitemap.xml 失败或为空时才按需延迟探测 robots.txt（常态 1 次 HTTP，零多余配额消耗）
	entryPath := parsed.Path
	if entryPath == "" || entryPath == "/" {
		for _, sm := range ExtractRobotsSitemaps(ctx, rootURL) {
			if tried[sm] {
				continue
			}
			tried[sm] = true
			diff, matched, ctxErr := probeSingleSitemap(ctx, client, sm, prevEtag, prevLastMod, rootURL)
			if ctxErr != nil {
				return nil, ctxErr
			}
			if matched && diff != nil {
				return diff, nil
			}
		}
	}

	return &WebDocDiffResult{
		HasChanges:    true,
		PagesToAdd:    []string{rootURL},
		PagesToUpdate: []string{},
		PagesToRemove: []string{},
		TotalChanged:  1,
	}, nil
}

func sitemapDirPrefix(rawPath string) string {
	idx := strings.LastIndex(rawPath, "/")
	if idx <= 0 {
		return "/"
	}
	return rawPath[:idx]
}

// buildSitemapCandidates 基于 robots.txt 声明（子路径入口前缀最长匹配）与挂载前缀构建候选 sitemap 序列；
// 根路径入口（"/"）优先直探 /sitemap.xml，保证定时巡检零额外 robots.txt HTTP 开销。
func buildSitemapCandidates(ctx context.Context, rootURL string, parsed *url.URL) []string {
	lowerPath := strings.ToLower(parsed.Path)
	if strings.HasSuffix(lowerPath, ".xml") || strings.HasSuffix(lowerPath, ".xml.gz") {
		return []string{rootURL}
	}

	origin := fmt.Sprintf("%s://%s", parsed.Scheme, parsed.Host)
	entryPath := parsed.Path
	if entryPath == "" || entryPath == "/" {
		return []string{origin + "/sitemap.xml"}
	}

	type scoredSitemap struct {
		url   string
		score int
	}
	var scored []scoredSitemap
	hasNonRootRobotsMatch := false

	for _, sm := range ExtractRobotsSitemaps(ctx, rootURL) {
		smU, err := url.Parse(sm)
		if err != nil || !strings.EqualFold(smU.Host, parsed.Host) {
			continue
		}
		dir := sitemapDirPrefix(smU.Path)
		if dir != "/" && HasPathPrefix(entryPath, dir) {
			hasNonRootRobotsMatch = true
			scored = append(scored, scoredSitemap{url: sm, score: 100 + len(dir)})
		} else if dir == "/" {
			scored = append(scored, scoredSitemap{url: sm, score: 1})
		}
	}

	sort.SliceStable(scored, func(i, j int) bool {
		return scored[i].score > scored[j].score
	})

	seen := make(map[string]bool, len(scored)+2)
	out := make([]string, 0, len(scored)+2)
	addCandidate := func(u string) {
		if u != "" && !seen[u] {
			seen[u] = true
			out = append(out, u)
		}
	}

	for _, s := range scored {
		addCandidate(s.url)
	}
	if !hasNonRootRobotsMatch {
		parts := strings.Split(strings.Trim(entryPath, "/"), "/")
		if len(parts) >= 2 && parts[0] != "" {
			addCandidate(fmt.Sprintf("%s/%s/sitemap.xml", origin, parts[0]))
		}
	}
	addCandidate(origin + "/sitemap.xml")
	return out
}

func probeSingleSitemap(
	ctx context.Context,
	client *http.Client,
	sitemapURL string,
	prevEtag string,
	prevLastMod map[string]string,
	rootURL string,
) (*WebDocDiffResult, bool, error) {
	if !IsPublicEndpoint(sitemapURL) {
		return nil, false, nil
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, sitemapURL, nil)
	if err != nil {
		return nil, false, nil
	}
	req.Header.Set("User-Agent", "OpenGits-Engine/1.0")
	req.Header.Set("Accept", "application/xml, text/xml, */*")
	if prevEtag != "" {
		req.Header.Set("If-None-Match", prevEtag)
	}

	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, false, ctx.Err()
		}
		return nil, false, nil
	}
	defer resp.Body.Close()

	if resp.StatusCode == http.StatusNotModified {
		etag := resp.Header.Get("ETag")
		if etag == "" {
			etag = prevEtag
		}
		return &WebDocDiffResult{
			HasChanges:        false,
			ETag:              etag,
			SitemapLastModMap: prevLastMod,
			TotalPages:        len(prevLastMod),
			PagesToAdd:        []string{},
			PagesToUpdate:     []string{},
			PagesToRemove:     []string{},
			TotalChanged:      0,
		}, true, nil
	}

	if resp.StatusCode >= 400 {
		return nil, false, nil
	}
	contentType := strings.ToLower(resp.Header.Get("Content-Type"))
	if strings.Contains(contentType, "text/html") {
		return nil, false, nil
	}

	newEtag := resp.Header.Get("ETag")

	var reader io.Reader = io.LimitReader(resp.Body, 32<<20) // 32MB 传输上限
	if strings.EqualFold(resp.Header.Get("Content-Encoding"), "gzip") || strings.HasSuffix(strings.ToLower(sitemapURL), ".gz") {
		gz, err := gzip.NewReader(reader)
		if err != nil {
			return nil, false, nil
		}
		defer gz.Close()
		reader = io.LimitReader(gz, 32<<20) // 解压后同样限制最大 32MB，防御 Gzip Bomb
	}

	currentUrls, childSitemaps, err := ParseSitemapXML(reader)
	if err != nil && len(currentUrls) == 0 && len(childSitemaps) == 0 {
		return nil, false, nil
	}
	if len(currentUrls) == 0 && len(childSitemaps) == 0 {
		return nil, false, nil
	}

	// 如果包含两级 sitemap index 递归（去重并受限最多 10 个子 Sitemap，总页数上限 50000）
	if len(childSitemaps) > 0 {
		sitemapBase, _ := url.Parse(sitemapURL)
		visited := map[string]bool{sitemapURL: true}
		subCount := 0
		for _, childLoc := range childSitemaps {
			if subCount >= 10 || len(currentUrls) >= 50000 {
				break
			}
			// 支持相对子 sitemap URL 补全
			if sitemapBase != nil {
				if cu, err := url.Parse(childLoc); err == nil {
					childLoc = sitemapBase.ResolveReference(cu).String()
				}
			}
			if visited[childLoc] || !IsPublicEndpoint(childLoc) {
				continue
			}
			visited[childLoc] = true
			subCount++

			subReq, err := http.NewRequestWithContext(ctx, http.MethodGet, childLoc, nil)
			if err != nil {
				continue
			}
			subReq.Header.Set("User-Agent", "OpenGits-Engine/1.0")

			subResp, err := client.Do(subReq)
			if err != nil || subResp.StatusCode != http.StatusOK {
				if subResp != nil {
					subResp.Body.Close()
				}
				continue
			}

			var subReader io.Reader = io.LimitReader(subResp.Body, 16<<20)
			var gz *gzip.Reader
			if strings.EqualFold(subResp.Header.Get("Content-Encoding"), "gzip") || strings.HasSuffix(strings.ToLower(childLoc), ".gz") {
				var err error
				gz, err = gzip.NewReader(subReader)
				if err != nil {
					subResp.Body.Close()
					continue
				}
				subReader = io.LimitReader(gz, 16<<20) // 解压后同样限制最大 16MB
			}

			subUrls, _, _ := ParseSitemapXML(subReader)
			if gz != nil {
				_ = gz.Close()
			}
			subResp.Body.Close()
			for k, v := range subUrls {
				currentUrls[k] = v
			}
		}
	}

	return ComputeWebDocDiff(currentUrls, prevLastMod, newEtag, rootURL), true, nil
}

// ─────────────────────────────────────────────────────────────
// SSRF 防护公用判定（与 apps/client/src/lib/url-inspector.ts 保持一致）
// ─────────────────────────────────────────────────────────────

var forbiddenSSRFPorts = map[string]bool{
	"21": true, "22": true, "23": true, "25": true, "53": true, "69": true,
	"110": true, "111": true, "135": true, "137": true, "138": true, "139": true,
	"143": true, "389": true, "445": true, "636": true, "1433": true, "1521": true,
	"2049": true, "2375": true, "2376": true, "3306": true, "3389": true, "5432": true,
	"5984": true, "6379": true, "9042": true, "11211": true, "27017": true, "27018": true,
	"28017": true,
}

func isPrivateOrLoopbackIP(ip net.IP) bool {
	if ip == nil {
		return false
	}
	// 允许代理 TUN (Surge 等) 分配的 IPv6 Fake-IP 前缀 (fdfe:dcba:9876::/48)
	if len(ip) == 16 && ip[0] == 0xfd && ip[1] == 0xfe && ip[2] == 0xdc && ip[3] == 0xba && ip[4] == 0x98 && ip[5] == 0x76 {
		return false
	}
	if ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		if v4[0] == 127 { // 127.0.0.0/8
			return true
		}
		if v4[0] == 10 { // 10.0.0.0/8
			return true
		}
		if v4[0] == 172 && v4[1] >= 16 && v4[1] <= 31 { // 172.16.0.0/12
			return true
		}
		if v4[0] == 192 && v4[1] == 168 { // 192.168.0.0/16
			return true
		}
		if v4[0] == 169 && v4[1] == 254 { // 169.254.0.0/16 (Link Local / Metadata)
			return true
		}
		if v4[0] == 100 && (v4[1]&0xc0) == 64 { // 100.64.0.0/10 (CGNAT)
			return true
		}
		if v4[0] == 0 { // 0.0.0.0/8
			return true
		}
		if v4[0] >= 224 { // 224.0.0.0/4 (Multicast) & 240.0.0.0/4 (Reserved / Broadcast)
			return true
		}
		if v4[0] == 192 && v4[1] == 0 && (v4[2] == 0 || v4[2] == 2) { // 192.0.0.0/24 (IETF), 192.0.2.0/24 (TEST-NET-1)
			return true
		}
		if v4[0] == 192 && v4[1] == 88 && v4[2] == 99 { // 192.88.99.0/24 (6to4 Relay)
			return true
		}
		if v4[0] == 198 && v4[1] == 51 && v4[2] == 100 { // 198.51.100.0/24 (TEST-NET-2)
			return true
		}
		if v4[0] == 203 && v4[1] == 0 && v4[2] == 113 { // 203.0.113.0/24 (TEST-NET-3)
			return true
		}
	} else {
		if len(ip) == 16 && (ip[0]&0xfe) == 0xfc { // fc00::/7 (Unique Local)
			return true
		}
		if len(ip) == 16 && ip[0] == 0xfe && (ip[1]&0xc0) == 0x80 { // fe80::/10 (Link Local)
			return true
		}
	}
	return false
}

// AllowTestLoopback 允许单测使用 127.0.0.1 / 回环地址。
var AllowTestLoopback bool

// IsPublicEndpoint 检查给定的 URL 是否指向公网安全终结点。
func IsPublicEndpoint(rawURL string) bool {
	if AllowTestLoopback {
		u, err := url.Parse(rawURL)
		return err == nil && (u.Scheme == "http" || u.Scheme == "https")
	}
	u, err := url.Parse(rawURL)
	if err != nil {
		return false
	}
	scheme := strings.ToLower(u.Scheme)
	if scheme != "http" && scheme != "https" {
		return false
	}
	if u.Port() != "" && forbiddenSSRFPorts[u.Port()] {
		return false
	}
	host := strings.ToLower(u.Hostname())
	if host == "" {
		return false
	}
	if host == "localhost" || host == "localhost.localdomain" || host == "ip6-localhost" || host == "ip6-loopback" {
		return false
	}
	if strings.HasSuffix(host, ".localhost") || strings.HasSuffix(host, ".local") || strings.HasSuffix(host, ".internal") || strings.HasSuffix(host, ".lan") {
		return false
	}
	if !strings.Contains(host, ".") {
		return false
	}

	// 通配符 DNS 服务前缀探测 (如 127.0.0.1.nip.io, 192-168-1-1.sslip.io)
	if strings.HasSuffix(host, ".nip.io") || strings.HasSuffix(host, ".sslip.io") {
		cleanPrefix := strings.TrimSuffix(strings.TrimSuffix(host, ".nip.io"), ".sslip.io")
		cleanPrefix = strings.ReplaceAll(cleanPrefix, "-", ".")
		if ip := net.ParseIP(cleanPrefix); ip != nil && isPrivateOrLoopbackIP(ip) {
			return false
		}
	}

	// 整数形式 IPv4 解析 (0x7f000001, 2130706433)
	if parsedInt, err := strconv.ParseUint(host, 0, 32); err == nil {
		ip := make(net.IP, 4)
		ip[0] = byte(parsedInt >> 24)
		ip[1] = byte(parsedInt >> 16)
		ip[2] = byte(parsedInt >> 8)
		ip[3] = byte(parsedInt)
		return !isPrivateOrLoopbackIP(ip)
	}

	if ip := net.ParseIP(host); ip != nil {
		return !isPrivateOrLoopbackIP(ip)
	}

	return true
}

// safeTransports 按 timeout 档位共享的带 SSRF 防御 Transport。
// 同档位抓取复用 keep-alive 连接——此前每页 NewSafeHTTPClient 新建
// Transport，同站空闲连接全部被丢弃（1000 页快道 = 1000 次 TCP+TLS
// 握手）。SSRF 校验在建连时执行：空闲复用命中的是建连时已校验并
// 锁定 IP 的连接，DNS 重绑定只威胁新建连接——共享不弱化防护语义。
var (
	safeTransportMu    sync.Mutex
	safeTransports     = map[time.Duration]*http.Transport{}
	safeTransportLimit = 8
)

func sharedSafeTransport(timeout time.Duration) *http.Transport {
	safeTransportMu.Lock()
	defer safeTransportMu.Unlock()
	if t, ok := safeTransports[timeout]; ok {
		return t
	}
	if len(safeTransports) >= safeTransportLimit {
		// 档位超限（用户自定 TimeoutMs 档过多）：回退按调用构造，防无界增长
		return newSafeTransport(timeout)
	}
	t := newSafeTransport(timeout)
	safeTransports[timeout] = t
	return t
}

func newSafeTransport(timeout time.Duration) *http.Transport {
	return &http.Transport{
		Proxy: http.ProxyFromEnvironment,
		DialContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			if AllowTestLoopback {
				return (&net.Dialer{Timeout: timeout}).DialContext(ctx, network, addr)
			}
			host, port, err := net.SplitHostPort(addr)
			if err != nil {
				return nil, err
			}
			if forbiddenSSRFPorts[port] {
				return nil, fmt.Errorf("SSRF blocked: port %s is forbidden", port)
			}
			ips, err := net.DefaultResolver.LookupIP(ctx, "ip", host)
			if err != nil {
				return nil, err
			}
			if len(ips) == 0 {
				return nil, fmt.Errorf("SSRF blocked: no IP addresses found for host %s", host)
			}
			var selectedIP net.IP
			for _, ip := range ips {
				if isPrivateOrLoopbackIP(ip) {
					return nil, fmt.Errorf("SSRF blocked: host %s resolves to private/loopback IP %s", host, ip)
				}
				if selectedIP == nil || (selectedIP.To4() == nil && ip.To4() != nil) {
					selectedIP = ip
				}
			}
			if selectedIP == nil {
				selectedIP = ips[0]
			}
			// 锁定至已校验的第一个合法公网 IP，防止解析与拨号之间的 DNS 重绑定竞争
			targetAddr := net.JoinHostPort(selectedIP.String(), port)
			return (&net.Dialer{Timeout: timeout}).DialContext(ctx, network, targetAddr)
		},
		MaxIdleConns:          16,
		MaxIdleConnsPerHost:   16,
		IdleConnTimeout:       90 * time.Second,
		ResponseHeaderTimeout: timeout,
	}
}

// NewSafeHTTPClient 构造带安全连接与 DNS Rebinding 防御的 HTTP 客户端。
// 在连接时通过 DialContext 解析域名并对每个 IP 校验是否为私网/回环，
// 并将连接直接锁定至已校验的合法公网 IP，彻底杜绝 DNS 重绑定攻击。
// Transport 按超时档位共享（见 sharedSafeTransport）；超时与重定向策略
// 保持在 Client 层逐调用生效。
func NewSafeHTTPClient(timeout time.Duration, maxRedirects int) *http.Client {
	client := &http.Client{
		Timeout:   timeout,
		Transport: sharedSafeTransport(timeout),
	}
	if maxRedirects >= 0 {
		client.CheckRedirect = func(req *http.Request, via []*http.Request) error {
			if len(via) >= maxRedirects {
				return fmt.Errorf("stopped after %d redirects", maxRedirects)
			}
			if !IsPublicEndpoint(req.URL.String()) {
				return errors.New("redirect to private or forbidden address blocked")
			}
			return nil
		}
	}
	return client
}
