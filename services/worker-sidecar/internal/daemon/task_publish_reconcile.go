package daemon

import (
	"context"
	"fmt"
	"io"
	"log"
	"net/http"
	"strings"
	"time"
)

// ─────────────────────────────────────────────────────────────
// 发布扇出定时对账（publish-fanout-reconcile）。
//
// 发布事务提交后的跨系统尾部（首页缓存 stale / L1 清退 / 导入奖励 /
// 接力通知）在 Node 侧全量幂等（lib/review/publish-fanout.ts），本任务周期唤醒
// Node 重放近 24h 发布的仓，兜底自愈任何单步漂移。架构分工不变：定时调度 100%
// Go 独占，Node 是被动执行体（租约防多重入在 Node 端点内完成）。
// ─────────────────────────────────────────────────────────────

const publishFanoutReconcileTimeout = 60 * time.Second

// runPublishFanoutReconcileOnce POST {NodeInternalURL}/api/tasks/publish-fanout-reconcile。
// NODE_INTERNAL_URL 未配置 → 自报 failed（静默跳过必须进入台账并被 task-health-alert 看见）。
func runPublishFanoutReconcileOnce(ctx context.Context, cfg Config) {
	base := strings.TrimRight(cfg.NodeInternalURL, "/")
	if base == "" {
		MarkRunFailed(ctx, "NODE_INTERNAL_URL not set")
		return
	}

	callCtx, cancel := context.WithTimeout(ctx, publishFanoutReconcileTimeout)
	defer cancel()

	req, err := http.NewRequestWithContext(callCtx, http.MethodPost,
		base+"/api/tasks/publish-fanout-reconcile", nil)
	if err != nil {
		MarkRunFailed(ctx, fmt.Sprintf("build request failed: %v", err))
		return
	}
	req.Header.Set("x-internal-token", cfg.InternalToken)

	res, err := http.DefaultClient.Do(req)
	if err != nil {
		MarkRunFailed(ctx, fmt.Sprintf("call node endpoint failed: %v", err))
		return
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<10))

	if res.StatusCode != http.StatusOK {
		MarkRunFailed(ctx, fmt.Sprintf("node endpoint status=%d body=%s", res.StatusCode, string(body)))
		return
	}
	log.Printf("[publish-fanout-reconcile] ok %s", string(body))
}
