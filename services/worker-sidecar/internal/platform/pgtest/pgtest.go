// Package pgtest 为需要真实 PostgreSQL 的集成测试提供一次性临时库。
//
// 设计约束（346·第一性原理）：
//   - 无 WORKER_TEST_DATABASE_URL 时 t.Skip——本地离线 `go test ./...`
//     与既有离线单测完全兼容；CI 由 service container 注入该变量激活。
//   - 每个测试在实例上创建唯一临时库并按文件名序执行 sidecar 迁移，
//     绝不触碰开发库的既有 schema/数据；测试结束强删临时库。
//   - 迁移经 PgConn 简单协议整体执行（多语句），避免手工分语句的脆弱性。
package pgtest

import (
	"context"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnvVar 激活集成测试的连接串变量（指向实例任意可管理库）。
const EnvVar = "WORKER_TEST_DATABASE_URL"

// Pool 返回应用完整迁移的临时库连接池；未配置 EnvVar 时跳过测试。
func Pool(t *testing.T) *pgxpool.Pool {
	t.Helper()

	baseURL := os.Getenv(EnvVar)
	if baseURL == "" {
		t.Skipf("%s 未设置——集成测试需要真实 PostgreSQL（CI 由 service container 注入）", EnvVar)
	}
	return poolFor(t, baseURL)
}

func poolFor(t *testing.T, baseURL string) *pgxpool.Pool {
	t.Helper()
	ctx := context.Background()

	dbName := fmt.Sprintf("wstest_%d_%d", os.Getpid(), time.Now().UnixNano())

	// 1. 在目标实例上创建唯一临时库
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		t.Fatalf("pgtest: 连接失败（检查 %s）: %v", EnvVar, err)
	}
	if _, err := admin.Exec(ctx, fmt.Sprintf(`CREATE DATABASE %s`, dbName)); err != nil {
		_ = admin.Close(ctx)
		t.Fatalf("pgtest: 创建临时库失败: %v", err)
	}

	// 2. 解析 URL 并切换库名，得到临时库连接串
	testURL, err := swapDatabase(baseURL, dbName)
	if err != nil {
		t.Fatalf("pgtest: 解析连接串失败: %v", err)
	}

	// 3. 执行 sidecar 迁移（简单协议，多语句整体执行）
	if err := applyMigrations(ctx, testURL); err != nil {
		_ = dropDatabase(ctx, baseURL, dbName)
		t.Fatalf("pgtest: 迁移执行失败: %v", err)
	}

	// 4. 连接池 + 测试结束强删临时库
	pool, err := pgxpool.New(ctx, testURL)
	if err != nil {
		_ = dropDatabase(ctx, baseURL, dbName)
		t.Fatalf("pgtest: 临时库连接池创建失败: %v", err)
	}
	t.Cleanup(func() {
		pool.Close()
		if err := dropDatabase(context.Background(), baseURL, dbName); err != nil {
			t.Logf("pgtest: 临时库清理失败（残留 %s）: %v", dbName, err)
		}
	})
	return pool
}

func swapDatabase(baseURL, dbName string) (string, error) {
	u, err := url.Parse(baseURL)
	if err != nil {
		return "", err
	}
	u.Path = "/" + dbName
	return u.String(), nil
}

func dropDatabase(ctx context.Context, baseURL, dbName string) error {
	admin, err := pgx.Connect(ctx, baseURL)
	if err != nil {
		return err
	}
	defer admin.Close(ctx)
	_, err = admin.Exec(ctx, fmt.Sprintf(`DROP DATABASE %s WITH (FORCE)`, dbName))
	return err
}

// applyMigrations 定位模块根的 migrations 目录（从测试 cwd 向上找 go.mod），
// 按文件名序在临时库上整体执行。
func applyMigrations(ctx context.Context, dbURL string) error {
	root, err := findModuleRoot()
	if err != nil {
		return err
	}
	dir := filepath.Join(root, "migrations")
	entries, err := os.ReadDir(dir)
	if err != nil {
		return fmt.Errorf("读取迁移目录 %s 失败: %w", dir, err)
	}
	var files []string
	for _, e := range entries {
		if !e.IsDir() && filepath.Ext(e.Name()) == ".sql" {
			files = append(files, e.Name())
		}
	}
	sort.Strings(files)
	if len(files) == 0 {
		return fmt.Errorf("迁移目录 %s 无 .sql 文件", dir)
	}

	conn, err := pgx.Connect(ctx, dbURL)
	if err != nil {
		return err
	}
	defer conn.Close(ctx)
	for _, f := range files {
		raw, err := os.ReadFile(filepath.Join(dir, f))
		if err != nil {
			return err
		}
		// PgConn 简单协议：多语句脚本一次执行（扩展协议不支持多语句）
		if _, err := conn.PgConn().Exec(ctx, string(raw)).ReadAll(); err != nil {
			return fmt.Errorf("迁移 %s 失败: %w", f, err)
		}
	}
	return nil
}

func findModuleRoot() (string, error) {
	dir, err := os.Getwd()
	if err != nil {
		return "", err
	}
	for {
		if _, err := os.Stat(filepath.Join(dir, "go.mod")); err == nil {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			return "", fmt.Errorf("未找到模块根（go.mod）")
		}
		dir = parent
	}
}
