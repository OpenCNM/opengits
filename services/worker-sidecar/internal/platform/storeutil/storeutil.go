package storeutil

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

type DBTX interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type TxExec = DBTX

func WithTx(ctx context.Context, pool *pgxpool.Pool, fn func(tx pgx.Tx) error) error {
	return WithTxTimeout(ctx, pool, 0, fn)
}

func WithTxTimeout(ctx context.Context, pool *pgxpool.Pool, timeout time.Duration, fn func(tx pgx.Tx) error) (err error) {
	if pool == nil {
		return errors.New("database connection pool is nil")
	}

	txCtx := ctx
	if timeout > 0 {
		var cancel context.CancelFunc
		txCtx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}

	tx, beginErr := pool.Begin(txCtx)
	if beginErr != nil {
		return fmt.Errorf("begin transaction: %w", beginErr)
	}

	defer func() {
		if p := recover(); p != nil {
			_ = tx.Rollback(txCtx)
			panic(p)
		} else if err != nil {
			_ = tx.Rollback(txCtx)
		}
	}()

	if err = fn(tx); err != nil {
		return err
	}

	if commitErr := tx.Commit(txCtx); commitErr != nil {
		return fmt.Errorf("commit transaction: %w", commitErr)
	}

	return nil
}

type ProgressInfo struct {
	Step      string `json:"step"`
	Progress  int    `json:"progress"`
	UpdatedAt string `json:"updatedAt"`
}

func FormatProgressPayload(step string, progress int) ([]byte, error) {
	return json.Marshal(ProgressInfo{
		Step:      step,
		Progress:  progress,
		UpdatedAt: time.Now().UTC().Format(time.RFC3339),
	})
}

func LogSlowOp(threshold time.Duration, op string, start time.Time) {
	elapsed := time.Since(start)
	if elapsed > threshold {
		log.Printf("[storeutil-slow-op] op=%s elapsed_ms=%d threshold_ms=%d", op, elapsed.Milliseconds(), threshold.Milliseconds())
	}
}
