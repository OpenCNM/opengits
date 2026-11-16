package storeutil

import (
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mockDBTX struct {
	lastSQL  string
	lastArgs []any
	execErr  error
}

func (m *mockDBTX) Exec(ctx context.Context, sql string, args ...any) (pgconn.CommandTag, error) {
	m.lastSQL = sql
	m.lastArgs = args
	return pgconn.NewCommandTag("UPDATE 1"), m.execErr
}

func (m *mockDBTX) Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error) {
	return nil, errors.New("not implemented")
}

func (m *mockDBTX) QueryRow(ctx context.Context, sql string, args ...any) pgx.Row {
	return nil
}

func TestFormatProgressPayload(t *testing.T) {
	payload, err := FormatProgressPayload("sniffing_ast", 45)
	require.NoError(t, err)

	var p ProgressInfo
	err = json.Unmarshal(payload, &p)
	require.NoError(t, err)

	assert.Equal(t, "sniffing_ast", p.Step)
	assert.Equal(t, 45, p.Progress)

	parsedTime, err := time.Parse(time.RFC3339, p.UpdatedAt)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now().UTC(), parsedTime, 2*time.Second)
}

func TestWithTxTimeoutNilPool(t *testing.T) {
	ctx := context.Background()
	err := WithTxTimeout(ctx, nil, 5*time.Second, func(tx pgx.Tx) error {
		return nil
	})
	assert.Error(t, err)
	assert.Equal(t, "database connection pool is nil", err.Error())
}

func TestWithTxNilPool(t *testing.T) {
	ctx := context.Background()
	err := WithTx(ctx, nil, func(tx pgx.Tx) error {
		return nil
	})
	assert.Error(t, err)
	assert.Equal(t, "database connection pool is nil", err.Error())
}

func TestLogSlowOp(t *testing.T) {
	// Should not panic or crash
	LogSlowOp(100*time.Millisecond, "fast_query", time.Now())
	LogSlowOp(1*time.Nanosecond, "slow_query", time.Now().Add(-10*time.Millisecond))
}
