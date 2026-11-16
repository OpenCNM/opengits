package scheduler

import (
	"context"
	"errors"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDeleteInBatches(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name         string
		table        string
		batchSize    int
		pickIDs      []string
		deleteCount  int64
		deleteErr    error
		pickErr      error
		wantTotal    int
		wantErr      bool
	}{
		{
			name:        "正常单批次删除完成",
			table:       "DaemonTaskRun",
			batchSize:   10,
			pickIDs:     []string{"id-1", "id-2", "id-3"},
			deleteCount: 3,
			wantTotal:   3,
			wantErr:     false,
		},
		{
			name:        "无匹配记录直接返回 0",
			table:       "ImportJobEvent",
			batchSize:   5,
			pickIDs:     []string{},
			deleteCount: 0,
			wantTotal:   0,
			wantErr:     false,
		},
		{
			name:        "默认批次大小防护 (batchSize <= 0 时自愈为 500)",
			table:       "DaemonTaskRun",
			batchSize:   0,
			pickIDs:     []string{"d1"},
			deleteCount: 1,
			wantTotal:   1,
			wantErr:     false,
		},
		{
			name:        "Pick 阶段报错立即短路中断",
			table:       "DaemonTaskRun",
			batchSize:   10,
			pickErr:     errors.New("db connection closed"),
			wantTotal:   0,
			wantErr:     true,
		},
		{
			name:        "Delete 阶段报错立即短路中断",
			table:       "DaemonTaskRun",
			batchSize:   10,
			pickIDs:     []string{"d1"},
			deleteErr:   errors.New("deadlock detected"),
			wantTotal:   0,
			wantErr:     true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			store := newFakeStore()
			if tt.pickErr != nil {
				store.pickErr = tt.pickErr
			}
			if tt.deleteErr != nil {
				store.deleteErr = tt.deleteErr
			}
			if len(tt.pickIDs) > 0 {
				store.pickIDs[tt.table] = tt.pickIDs
				store.deleteN[tt.table] = tt.deleteCount
			}

			total, err := DeleteInBatches(context.Background(), store, tt.table, time.Now(), tt.batchSize)
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantTotal, total)
			}
		})
	}
}

func TestDeleteColdDissectionCacheInBatches(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name        string
		batchSize   int
		coldIDs     []string
		deleteCount int64
		deleteErr   error
		wantTotal   int
		wantErr     bool
	}{
		{
			name:        "正常回收冷缓存",
			batchSize:   10,
			coldIDs:     []string{"c1", "c2"},
			deleteCount: 2,
			wantTotal:   2,
			wantErr:     false,
		},
		{
			name:        "无冷缓存直接返回 0",
			batchSize:   5,
			coldIDs:     []string{},
			deleteCount: 0,
			wantTotal:   0,
			wantErr:     false,
		},
		{
			name:        "删除报错返回错误",
			batchSize:   10,
			coldIDs:     []string{"c1"},
			deleteErr:   errors.New("permission denied"),
			wantTotal:   0,
			wantErr:     true,
		},
	}

	for _, tt := range tests {
		tt := tt
		t.Run(tt.name, func(t *testing.T) {
			t.Parallel()
			store := newFakeStore()
			store.coldDissectionIDs = tt.coldIDs
			store.deleteN["DissectionCache"] = tt.deleteCount
			if tt.deleteErr != nil {
				store.deleteErr = tt.deleteErr
			}

			total, err := deleteColdDissectionCacheInBatches(context.Background(), store, time.Now(), 5, tt.batchSize)
			if tt.wantErr {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
				assert.Equal(t, tt.wantTotal, total)
			}
		})
	}
}

func TestRunRetentionPruneCompleteCoverage(t *testing.T) {
	t.Parallel()

	store := newFakeStore()
	store.pickIDs["DaemonTaskRun"] = []string{"dt1"}
	store.deleteN["DaemonTaskRun"] = 1
	store.pickIDs["ImportJobEvent"] = []string{"ie1", "ie2"}
	store.deleteN["ImportJobEvent"] = 2
	store.coldDissectionIDs = []string{"cd1"}
	store.deleteN["DissectionCache"] = 1

	cfg := Config{
		RetentionEpisodicDays:        7,
		RetentionMonitorDays:         7,
		RetentionMcpCallLogDays:      30,
		RetentionTokenUsageDays:      30,
		RetentionAdminAuditDays:      90,
		RetentionGatewayEvDays:       14,
		RetentionDaemonTaskRunDays:   7,
		RetentionImportJobEventDays:  14,
		RetentionDissectionCacheDays: 30,
		PruneBatchSize:               100,
	}

	report := RunRetentionPrune(context.Background(), cfg, store)

	assert.Equal(t, 1, report["daemonTaskRun"])
	assert.Equal(t, 2, report["importJobEvent"])
	assert.Equal(t, 1, report["coldDissectionCache"])
	assert.Contains(t, report, "episodicEvent")
	assert.Contains(t, report, "monitorEvent")
	assert.Contains(t, report, "mcpCallLog")
	assert.Contains(t, report, "tokenUsageLog")
	assert.Contains(t, report, "adminAuditLog")
	assert.Contains(t, report, "gatewaySecurityEvent")
	assert.Contains(t, report, "sessionExpired")
}
