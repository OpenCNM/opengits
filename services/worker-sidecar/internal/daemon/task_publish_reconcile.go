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

const publishFanoutReconcileTimeout = 60 * time.Second

func runPublishFanoutReconcileOnce(ctx context.Context, cfg Config) {
	base := strings.TrimRight(cfg.NodeInternalURL, "/")
	if base == "" {
		// Report missing URL as failed so silent skips surface in DaemonTaskRun health alerts.
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
