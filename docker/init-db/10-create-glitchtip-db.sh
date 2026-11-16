#!/bin/bash
# Postgres 容器首次建卷时的附属库初始化（幂等）：
# - glitchtip_db：自托管 GlitchTip 错误监控的独立库（docker-compose.yml glitchtip 服务）
# 注意：本目录只在数据卷首次初始化时执行；存量部署请在 db 容器内手动执行同样的 CREATE DATABASE。
set -e

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" <<-EOSQL
    SELECT 'CREATE DATABASE glitchtip_db'
    WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'glitchtip_db')\gexec
    GRANT ALL PRIVILEGES ON DATABASE glitchtip_db TO $POSTGRES_USER;
EOSQL
