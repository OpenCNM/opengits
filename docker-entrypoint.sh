#!/bin/sh
# ─────────────────────────────────────────────────────────────
# 启动序列：等 DB → 同步 schema（migrate deploy）→ 启动应用
# - migrate deploy：应用 prisma/migrations（已包含 FTS/相似度 GIN 索引等全套基线，可审计可回滚，幂等）；
#   存量 db-push 库首次接入时无迁移历史（P3005）→ 先把基线 0_init 标记为
#   已应用再 deploy（一次性，数据不动）
# - SKIP_SCHEMA_SYNC=1：跳过迁移链（mcp 容器用——schema 同步由 web 独占，
#   避免多容器并发迁移；与 worker 的 entrypoint 覆盖先例同理）
# ─────────────────────────────────────────────────────────────
set -e

DB_HOST=$(echo "$DATABASE_URL" | sed -E 's|.*@([^:/]+).*|\1|')
DB_PORT=$(echo "$DATABASE_URL" | sed -E 's|.*:([0-9]+)/.*|\1|')
DB_PORT=${DB_PORT:-5432}

echo "[entrypoint] waiting for database ${DB_HOST}:${DB_PORT}..."
# debian slim 无 nc；用 node 内置 net 探测 TCP 连通
i=0
while ! node -e "const net=require('net');const s=net.connect($DB_PORT,'$DB_HOST',()=>{process.exit(0)});s.on('error',()=>{process.exit(1)})" 2>/dev/null; do
  i=$((i + 1))
  if [ "$i" -ge 60 ]; then
    echo "[entrypoint] database not reachable after 60s, aborting" >&2
    exit 1
  fi
  sleep 2
done
echo "[entrypoint] database ready."

if [ -n "$SKIP_SCHEMA_SYNC" ]; then
  echo "[entrypoint] SKIP_SCHEMA_SYNC set — schema sync owned by web container, starting: $*"
  exec "$@"
fi

echo "[entrypoint] applying database migrations (prisma migrate deploy)..."
if ! npx prisma migrate deploy; then
  echo "[entrypoint] migrate deploy failed; assuming legacy db-push database without migration history — baselining 20260827000000_init..."
  npx prisma migrate resolve --applied 20260827000000_init
  npx prisma migrate deploy
fi

echo "[entrypoint] starting: $*"
exec "$@"
