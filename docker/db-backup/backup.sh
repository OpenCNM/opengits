#!/bin/bash
# ─────────────────────────────────────────────────────────────
# 数据库定时备份（pg_dump 逻辑备份——运行中的 PG 不能做卷级拷贝）
# - 每日：opengits_db + glitchtip_db 各一份 pg_dump -Fc（自定义格式，压缩，可选择性恢复）
# - 周一：额外落一份周备（weekly- 前缀，保留 4 周）
# - 轮换：日备 >7 天删除；周备 >28 天删除；assets 每周 tar 保留 4 份
# - 异地（可选）：设 BACKUP_UPLOAD_CMD 则把产物路径交给该命令（rclone/scp 等）
# 产物落宿主机 ./backups（bind mount），容器删了备份还在。
# 恢复：解压对应 tar 得到 pg_dump -Fc 转储，用 pg_restore 导回目标库（assets 归档解压回 public/）。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/backups}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-7}"
WEEKLY_RETENTION_DAYS="${WEEKLY_RETENTION_DAYS:-28}"
DB_USER="${POSTGRES_USER:-opengits}"
DB_HOST="${DB_HOST:-db}"
DB_PORT="${DB_PORT:-5432}"
# 需要备份的业务库（langfuse 共用 opengits_db，随主库一并备份）
BACKUP_DATABASES="${BACKUP_DATABASES:-opengits_db glitchtip_db}"
STORAGE_DIR="${STORAGE_DIR:-/storage}"
BACKUP_ASSETS="${BACKUP_ASSETS:-1}"

mkdir -p "$BACKUP_DIR"

log() { echo "[db-backup] $(date '+%F %T') $*"; }

dump_database() {
  local db="$1" out="$2"
  # 环境变量直连（容器网络内信任认证）；失败重试一次
  PGPASSWORD="${POSTGRES_PASSWORD:-}" pg_dump \
    -h "$DB_HOST" -p "$DB_PORT" -U "$DB_USER" \
    -Fc -f "$out" "$db"
}

run_backup() {
  local stamp day_of_week
  stamp="$(date '+%Y%m%d-%H%M%S')"
  day_of_week="$(date '+%u')" # 1=周一

  local failed=0
  for db in $BACKUP_DATABASES; do
    local out="$BACKUP_DIR/${db}-${stamp}.dump"
    if dump_database "$db" "$out"; then
      local size
      size="$(du -h "$out" | cut -f1)"
      log "dumped $db -> $(basename "$out") ($size)"
      # 周备副本（周一落一份带 weekly- 前缀的硬链接，独立轮换窗口）
      if [ "$day_of_week" = "1" ]; then
        ln -f "$out" "$BACKUP_DIR/weekly-${db}-${stamp}.dump"
      fi
    else
      log "ERROR: dump $db failed, retrying once..."
      sleep 5
      if dump_database "$db" "$out"; then
        log "dumped $db on retry -> $(basename "$out")"
        [ "$day_of_week" = "1" ] && ln -f "$out" "$BACKUP_DIR/weekly-${db}-${stamp}.dump"
      else
        log "ERROR: dump $db failed twice, giving up this round"
        failed=1
      fi
    fi
  done

  # assets 周备（文档引用的图片；repos 缓存可从 GitHub 重建，不备份）
  if [ "$BACKUP_ASSETS" = "1" ] && [ "$day_of_week" = "1" ] && [ -d "$STORAGE_DIR/assets" ]; then
    local assets_out="$BACKUP_DIR/weekly-assets-${stamp}.tar.gz"
    if tar -czf "$assets_out" -C "$STORAGE_DIR" assets; then
      log "assets archived -> $(basename "$assets_out")"
    else
      log "WARN: assets tar failed (non-fatal)"
      rm -f "$assets_out"
    fi
  fi

  # ── 轮换 ──
  find "$BACKUP_DIR" -maxdepth 1 -name '*.dump' -not -name 'weekly-*' -mtime "+$RETENTION_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name 'weekly-*.dump' -mtime "+$WEEKLY_RETENTION_DAYS" -delete
  find "$BACKUP_DIR" -maxdepth 1 -name 'weekly-assets-*.tar.gz' -mtime "+$WEEKLY_RETENTION_DAYS" -delete

  # ── 异地钩子（可选）：把本轮产物交给外部命令 ──
  if [ -n "${BACKUP_UPLOAD_CMD:-}" ]; then
    # shellcheck disable=SC2086
    if $BACKUP_UPLOAD_CMD "$BACKUP_DIR" "$stamp"; then
      log "off-site hook done for $stamp"
    else
      log "WARN: off-site hook failed (non-fatal)"
    fi
  fi

  return $failed
}

# 手动单次触发（测试/运维用）：RUN_ONCE=1 bash backup.sh
if [ "${RUN_ONCE:-0}" = "1" ]; then
  run_backup
  exit $?
fi

# 定时循环：每天 BACKUP_HOUR 点（默认 3）触发；首次启动先跑一轮验证链路
BACKUP_HOUR="${BACKUP_HOUR:-3}"
log "scheduler started (daily at ${BACKUP_HOUR}:00, dir=$BACKUP_DIR, retention=${RETENTION_DAYS}d+weekly${WEEKLY_RETENTION_DAYS}d)"
log "running initial backup on boot..."
run_backup || log "WARN: initial backup had failures (will retry next cycle)"

while true; do
  now=$(date +%s)
  target=$(date -d "today ${BACKUP_HOUR}:00" +%s)
  [ "$target" -le "$now" ] && target=$(date -d "tomorrow ${BACKUP_HOUR}:00" +%s)
  sleep_seconds=$((target - now))
  log "next backup in $((sleep_seconds / 3600))h $(((sleep_seconds % 3600) / 60))m"
  sleep "$sleep_seconds"
  run_backup || log "WARN: scheduled backup had failures (will retry next cycle)"
done
