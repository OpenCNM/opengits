package daemon

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/opengits/worker-sidecar/internal/platform/authtoken"
	"github.com/opengits/worker-sidecar/internal/scheduler"
)

func jsonUnmarshalBody(r *http.Request, out any) error {
	b, err := io.ReadAll(r.Body)
	if err != nil {
		return err
	}
	return json.Unmarshal(b, out)
}

// fakeStore 单测桩：记录调用供断言（pgx 不做进程内 mock——SQL 层正确性由真实 DB 冒烟兜底）。
type fakeStore struct {
	mu sync.Mutex

	leaseRows      int64 // LeaseUpdateIfHeldOrExpired 命中行数
	leaseInsertErr error
	leaseUpdated   map[string]string // key → owner
	leaseDeleted   []string

	emergencyRO bool

	picked  map[string]int // table → pick 次数
	pickIDs map[string][]string
	deleted map[string][]string // table → 已删 id 批次
	deleteN map[string]int64

	sessionsDeleted      int64
	quotaLogsDeleted     int64
	expiredLeasesCleaned int64

	orphanIDs []string

	pubVersionsDeleted  int64
	privVersionsDeleted int64

	activeRepos map[string]bool

	upstreamRepos []scheduler.RepoRow
	touched       []string
	written       []string
}

func newFakeStore() *fakeStore {
	return &fakeStore{
		leaseUpdated: map[string]string{},
		picked:       map[string]int{},
		pickIDs:      map[string][]string{},
		deleted:      map[string][]string{},
		deleteN:      map[string]int64{},
		activeRepos:  map[string]bool{},
	}
}

func (f *fakeStore) LeaseUpdateIfHeldOrExpired(_ context.Context, key, owner string, until time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseUpdated[key] = owner
	_ = until
	return f.leaseRows, nil
}

func (f *fakeStore) LeaseInsert(_ context.Context, key, owner string, _ time.Time) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.leaseInsertErr != nil {
		return f.leaseInsertErr
	}
	f.leaseUpdated[key] = owner
	return nil
}

func (f *fakeStore) LeaseDelete(_ context.Context, key, owner string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.leaseDeleted = append(f.leaseDeleted, key+"@"+owner)
	return nil
}

func (f *fakeStore) CleanExpiredLeases(_ context.Context, _ time.Time) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.expiredLeasesCleaned, nil
}

func (f *fakeStore) EmergencyReadOnly(context.Context) (bool, error) {
	return f.emergencyRO, nil
}

func (f *fakeStore) PickIdsBefore(_ context.Context, table, _ string, _ time.Time, take int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.picked[table]++
	ids := f.pickIDs[table]
	if take < len(ids) {
		ids = ids[:take]
	}
	return ids, nil
}

func (f *fakeStore) DeleteIds(_ context.Context, table string, ids []string) (int64, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.deleted[table] = append(f.deleted[table], joinIDs(ids))
	return f.deleteN[table], nil
}

func (f *fakeStore) DeleteExpiredSessions(context.Context) (int64, error) {
	return f.sessionsDeleted, nil
}

func (f *fakeStore) DeleteQuotaLogsBefore(context.Context, time.Time) (int64, error) {
	return f.quotaLogsDeleted, nil
}

func (f *fakeStore) PickOrphanContentIds(_ context.Context, _ time.Time, _ int) ([]string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	ids := f.orphanIDs
	f.orphanIDs = nil // 下一轮返回空，避免死循环
	return ids, nil
}

func (f *fakeStore) PickColdDissectionCacheIds(_ context.Context, _ time.Time, _ int, _ int) ([]string, error) {
	return nil, nil
}

func (f *fakeStore) DeleteStalePublicVersions(context.Context, time.Time) (int64, error) {
	return f.pubVersionsDeleted, nil
}

func (f *fakeStore) DeleteExpiredPrivateVersions(context.Context, time.Time) (int64, error) {
	return f.privVersionsDeleted, nil
}

func (f *fakeStore) ActiveRepoKeys(context.Context) (map[string]bool, error) {
	return f.activeRepos, nil
}

func (f *fakeStore) ActiveArchiveKeys(context.Context) (map[string]bool, error) {
	return map[string]bool{}, nil
}

func (f *fakeStore) ReposForUpstreamCheck(context.Context, int) ([]scheduler.RepoRow, error) {
	return f.upstreamRepos, nil
}

func (f *fakeStore) TouchUpstreamChecked(_ context.Context, owner, repo, branch string, etag *string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.touched = append(f.touched, fmt.Sprintf("%s/%s@%s:%s", owner, repo, branch, derefStr(etag)))
	return nil
}

func (f *fakeStore) WriteUpstreamChanged(_ context.Context, owner, repo, branch string, hasUpdate bool, etag *string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written = append(f.written, fmt.Sprintf("%s/%s@%s:hasUpdate=%v:%s", owner, repo, branch, hasUpdate, derefStr(etag)))
	return nil
}

func (f *fakeStore) WriteUpstreamWebChecked(_ context.Context, repoID string, hasUpdate bool, etag *string, lastMod map[string]string) error {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.written = append(f.written, fmt.Sprintf("%s:hasUpdate=%v:%s", repoID, hasUpdate, derefStr(etag)))
	return nil
}

func (f *fakeStore) CountMonitorErrorSessionsSince(_ context.Context, _ []string, _ time.Time) (int64, error) {
	return 0, nil
}

func (f *fakeStore) CountMonitorEventsByKindSince(_ context.Context, _ string, _ time.Time) (int64, error) {
	return 0, nil
}

func derefStr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func joinIDs(ids []string) string {
	out := ""
	for i, id := range ids {
		if i > 0 {
			out += ","
		}
		out += id
	}
	return out
}

// ── lease ──

// 🧪 [5.7.1.1] 双实例同周期抢同一租约：快路径 UPDATE 命中与慢路径 INSERT 唯一键冲突处理
func TestAcquireLeaseLifecycle(t *testing.T) {
	tests := []struct {
		name        string
		leaseRows   int64
		insertErr   error
		wantSuccess bool
	}{
		{
			name:        "fast path renewal succeeds",
			leaseRows:   1,
			insertErr:   nil,
			wantSuccess: true,
		},
		{
			name:        "slow path insert succeeds when fast path misses",
			leaseRows:   0,
			insertErr:   nil,
			wantSuccess: true,
		},
		{
			name:        "conflict treated as not acquired when held elsewhere",
			leaseRows:   0,
			insertErr:   fmt.Errorf("unique constraint"),
			wantSuccess: false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeStore()
			f.leaseRows = tt.leaseRows
			f.leaseInsertErr = tt.insertErr
			ok := scheduler.AcquireLease(context.Background(), f, "prune-telemetry", time.Hour)
			assert.Equal(t, tt.wantSuccess, ok)
		})
	}
}

// 🧪 [5.7.1.2] 租约 TTL 推导漂移：周期双倍保证互斥时效
func TestLeaseTtlFromInterval(t *testing.T) {
	tests := []struct {
		name     string
		interval time.Duration
		wantTtl  time.Duration
	}{
		{name: "1 hour interval doubles to 2 hours", interval: time.Hour, wantTtl: 2 * time.Hour},
		{name: "15 minutes interval doubles to 30 minutes", interval: 15 * time.Minute, wantTtl: 30 * time.Minute},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := scheduler.LeaseTtlFromInterval(tt.interval)
			assert.Equal(t, tt.wantTtl, got)
		})
	}
}

// ── prune 批删循环 ──

// 🧪 [5.7.2.1] 分批删除与各段独立容错：LIMIT 5000 分批与 count<rows 终止
func TestDeleteInBatchesTerminatesOnPartialDelete(t *testing.T) {
	f := newFakeStore()
	f.pickIDs["EpisodicEvent"] = []string{"a", "b", "c"}
	f.deleteN["EpisodicEvent"] = 2 // 并发删除 1 条 → count < rows 终止

	total, err := scheduler.DeleteInBatches(context.Background(), f, "EpisodicEvent", time.Now(), 5000)
	require.NoError(t, err)
	assert.Equal(t, 2, total)
	assert.Equal(t, 1, f.picked["EpisodicEvent"], "should stop after partial delete")
}

func TestRunPruneOnceSkipsWithoutLease(t *testing.T) {
	f := newFakeStore()
	f.leaseRows = 0
	f.leaseInsertErr = fmt.Errorf("held") // 租约在他人手里

	scheduler.RunPruneOnce(context.Background(), loadConfigFromEnv().SchedulerConfig(), f)
	assert.Equal(t, 0, f.picked["EpisodicEvent"], "prune must be skipped when lease held elsewhere")
}

// ── upstream-check ──

func strp(s string) *string { return &s }

// 🧪 [5.7.3.2] 304 响应误写红点：只更新 checkedAt 与 etag，written 为空保持冻结
func TestCheckUpstreamOnceNotModifiedTouchesOnly(t *testing.T) {
	scheduler.ResetGatewayPolicyForTest() // 策略缓存跨测试隔离
	var gotEtag string
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.NotEmpty(t, r.Header.Get("If-None-Match"), "conditional probe must send If-None-Match")
		gotEtag = `W/"abc"`
		w.Header().Set("ETag", gotEtag)
		w.WriteHeader(http.StatusNotModified)
	}))
	defer ts.Close()

	f := newFakeStore()
	f.leaseRows = 1
	f.upstreamRepos = []scheduler.RepoRow{{Owner: "o", Repo: "r", Branch: "main", Etag: strp(`W/"old"`)}}
	cfg := loadConfigFromEnv()
	cfg.GitHubAPIBase = ts.URL
	scheduler.CheckUpstreamOnce(context.Background(), cfg.SchedulerConfig(), f)

	require.Len(t, f.touched, 1)
	assert.Equal(t, "o/r@main:"+gotEtag, f.touched[0])
	assert.Empty(t, f.written, "304 must not write red dot")
}

func TestCheckUpstreamOnceChangedWritesRedDot(t *testing.T) {
	scheduler.ResetGatewayPolicyForTest() // 策略缓存跨测试隔离
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"sha":"newsha"}`))
	}))
	defer ts.Close()

	f := newFakeStore()
	f.leaseRows = 1
	f.upstreamRepos = []scheduler.RepoRow{{Owner: "o", Repo: "r", Branch: "main", GitSha: strp("oldsha")}}
	cfg := loadConfigFromEnv()
	cfg.GitHubAPIBase = ts.URL
	scheduler.CheckUpstreamOnce(context.Background(), cfg.SchedulerConfig(), f)

	require.Len(t, f.written, 1)
	assert.Equal(t, "o/r@main:hasUpdate=true:", f.written[0])
}

// 🧪 [5.7.3.3] 讲法组内重复探测浪费配额：同一 (owner,repo,branch) 组内共享单次探测写回全部行
func TestCheckUpstreamOnceGroupSharesSingleProbe(t *testing.T) {
	scheduler.ResetGatewayPolicyForTest() // 策略缓存跨测试隔离
	calls := 0
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		_, _ = w.Write([]byte(`{"sha":"s1"}`))
	}))
	defer ts.Close()

	f := newFakeStore()
	f.leaseRows = 1
	// 同 (owner,repo,branch) 的两条讲法行 → 组内只调一次 GitHub API
	f.upstreamRepos = []scheduler.RepoRow{
		{ID: "1", Owner: "o", Repo: "r", Branch: "main", GitSha: strp("a")},
		{ID: "2", Owner: "o", Repo: "r", Branch: "main", GitSha: strp("b")},
	}
	cfg := loadConfigFromEnv()
	cfg.GitHubAPIBase = ts.URL
	scheduler.CheckUpstreamOnce(context.Background(), cfg.SchedulerConfig(), f)

	assert.Equal(t, 1, calls, "group should share one probe")
	assert.Len(t, f.written, 2, "both editions should get the write-back")
}

// 🧪 [5.7.3.1] web 文档库误打 GitHub API：sourceType=web 判定跳过，不发外部 HTTP
func TestCheckUpstreamOnceSkipsWebDocRepos(t *testing.T) {
	scheduler.ResetGatewayPolicyForTest() // 策略缓存跨测试隔离
	called := false
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		called = true
		_, _ = w.Write([]byte(`{"sha":"s"}`))
	}))
	defer ts.Close()

	f := newFakeStore()
	f.leaseRows = 1
	f.upstreamRepos = []scheduler.RepoRow{{Owner: "o", Repo: "site", Branch: "main", ProfileJSON: []byte(`{"sourceType":"web"}`)}}
	cfg := loadConfigFromEnv()
	cfg.GitHubAPIBase = ts.URL
	scheduler.CheckUpstreamOnce(context.Background(), cfg.SchedulerConfig(), f)

	assert.False(t, called, "web-doc repos must never hit the GitHub API from Go")
	assert.Empty(t, f.touched)
	assert.Empty(t, f.written)
}

func TestCheckUpstreamOnceEmergencyReadOnly(t *testing.T) {
	scheduler.ResetGatewayPolicyForTest() // 策略缓存跨测试隔离
	f := newFakeStore()
	f.emergencyRO = true
	f.leaseRows = 1
	f.upstreamRepos = []scheduler.RepoRow{{Owner: "o", Repo: "r", Branch: "main"}}
	scheduler.CheckUpstreamOnce(context.Background(), loadConfigFromEnv().SchedulerConfig(), f)

	assert.Empty(t, f.touched)
	assert.Empty(t, f.written, "emergency read-only must skip the whole cycle")
}

// 🧪 [5.7.2.2] 孤儿内容误删在用内容行：PickOrphanContentIds 双向排除在用内容与批次提取，orphanContentGcOnce 分批删除与并发保守终止
func TestPickOrphanContentIdsCycle(t *testing.T) {
	tests := []struct {
		name         string
		orphanIDs    []string
		deleteN      int64
		wantDeleteOp bool
		wantDeleted  string
	}{
		{
			name:         "no orphans returns zero and skips delete",
			orphanIDs:    nil,
			deleteN:      0,
			wantDeleteOp: false,
		},
		{
			name:         "orphans picked and deleted via DocumentContent table",
			orphanIDs:    []string{"orphan-1", "orphan-2"},
			deleteN:      2,
			wantDeleteOp: true,
			wantDeleted:  "orphan-1,orphan-2",
		},
		{
			name:         "concurrent reference stops cycle early when deleted count less than scanned",
			orphanIDs:    []string{"orphan-1", "orphan-2"},
			deleteN:      1, // n < len(ids), triggers break
			wantDeleteOp: true,
			wantDeleted:  "orphan-1,orphan-2",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := newFakeStore()
			f.orphanIDs = tt.orphanIDs
			f.deleteN["DocumentContent"] = tt.deleteN
			cfg := Config{
				OrphanContentGraceDays: 7,
				OrphanGcBatch:          100,
				OrphanGcMaxPerRun:      500,
			}
			scheduler.OrphanContentGcOnce(context.Background(), cfg.SchedulerConfig(), f)

			if !tt.wantDeleteOp {
				assert.Empty(t, f.deleted["DocumentContent"])
			} else {
				require.Len(t, f.deleted["DocumentContent"], 1)
				assert.Equal(t, tt.wantDeleted, f.deleted["DocumentContent"][0])
			}
		})
	}

	t.Run("SQL store PickOrphanContentIds enforces bidirectional NOT EXISTS exclusion", func(t *testing.T) {
		src, err := os.ReadFile("../scheduler/pgx_store.go")
		require.NoError(t, err)
		strSrc := string(src)
		assert.Contains(t, strSrc, `NOT EXISTS (SELECT 1 FROM "Document" d WHERE d."contentId" = dc.id)`)
		assert.Contains(t, strSrc, `NOT EXISTS (SELECT 1 FROM "ChapterVersion" cv WHERE cv."contentId" = dc.id)`)
		assert.Contains(t, strSrc, `dc."updatedAt" < $1`)
	})
}

// 🧪 [5.7.4.1] 内部触发面鉴权：/v1/tasks/{name}/run 缺少或错误 token 返回 403（对齐 Node internal-auth），非白名单任务名返回 400
func TestInternalTaskRunAuth(t *testing.T) {
	tests := []struct {
		name       string
		token      string
		taskName   string
		wantStatus int
	}{
		{
			name:       "missing token yields 403",
			token:      "",
			taskName:   "prune-telemetry",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "wrong token yields 403",
			token:      "wrong-token",
			taskName:   "prune-telemetry",
			wantStatus: http.StatusForbidden,
		},
		{
			name:       "invalid task name yields 400",
			token:      "valid-token",
			taskName:   "INVALID_NAME",
			wantStatus: http.StatusBadRequest,
		},
	}

	cfg := Config{InternalToken: "valid-token"}
	s := &Server{cfg: cfg}
	handler := s.internal(s.handleTaskRun)

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/tasks/"+tt.taskName+"/run", nil)
			req.SetPathValue("name", tt.taskName)
			if tt.token != "" {
				req.Header.Set("x-internal-token", tt.token)
			}
			rec := httptest.NewRecorder()
			handler(rec, req)
			assert.Equal(t, tt.wantStatus, rec.Code)
		})
	}
}

// 🧪 WP-B 内部鉴权契约（对齐 Node lib/internal-auth.ts）：
// 生产环境拒绝 compose 默认令牌（403 internal endpoint disabled）；
// 查询串 ?token= 不再作为内部令牌通道；错误令牌 403 Forbidden。
func TestInternalMiddlewareContract(t *testing.T) {
	tests := []struct {
		name       string
		appEnv     string
		cfgToken   string
		header     string
		queryToken string
		wantStatus int
		wantBody   string
	}{
		{
			name:       "production refuses compose default token even when it matches",
			appEnv:     "production",
			cfgToken:   authtoken.InsecureDefaultToken,
			header:     authtoken.InsecureDefaultToken,
			wantStatus: http.StatusForbidden,
			wantBody:   "internal endpoint disabled",
		},
		{
			name:       "development allows compose default token via header",
			appEnv:     "development",
			cfgToken:   authtoken.InsecureDefaultToken,
			header:     authtoken.InsecureDefaultToken,
			wantStatus: http.StatusOK,
		},
		{
			name:       "query-string token is no longer accepted",
			appEnv:     "development",
			cfgToken:   "valid-token",
			queryToken: "valid-token",
			wantStatus: http.StatusForbidden,
			wantBody:   "Forbidden",
		},
		{
			name:       "correct header token passes",
			appEnv:     "production",
			cfgToken:   "real-secret",
			header:     "real-secret",
			wantStatus: http.StatusOK,
		},
		{
			name:       "wrong token yields 403 Forbidden",
			appEnv:     "development",
			cfgToken:   "valid-token",
			header:     "bad",
			wantStatus: http.StatusForbidden,
			wantBody:   "Forbidden",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &Server{cfg: Config{InternalToken: tt.cfgToken, AppEnv: tt.appEnv}}
			called := false
			handler := s.internal(func(w http.ResponseWriter, _ *http.Request) {
				called = true
				w.WriteHeader(http.StatusOK)
			})
			req := httptest.NewRequest(http.MethodPost, "/v1/tasks/orphan-sweeper/run", nil)
			if tt.header != "" {
				req.Header.Set("x-internal-token", tt.header)
			}
			if tt.queryToken != "" {
				req.URL.RawQuery = "token=" + tt.queryToken
			}
			rec := httptest.NewRecorder()
			handler(rec, req)
			assert.Equal(t, tt.wantStatus, rec.Code)
			assert.Equal(t, tt.wantStatus == http.StatusOK, called)
			if tt.wantBody != "" {
				assert.Contains(t, rec.Body.String(), tt.wantBody)
			}
		})
	}
}
