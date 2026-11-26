# syntax=docker/dockerfile:1
# ─────────────────────────────────────────────────────────────
# OpenGits Client (Web) 生产镜像 (node:22-slim, EXPOSE 3000)
# 附加 target `worker-go`：Go worker sidecar（纯静态 Distroless 镜像，~24MB）。
# 完全切断 Node.js / V8 / npm / libc 依赖，冷启动 < 10ms，常驻内存 ~15MB。
#
# 阶段拆分：
# - gobuild：Go 原生二进制多阶段编译（BuildKit mod + build 缓存）
# - deps -> builder：Node 依赖 + Prisma generate + Next.js standalone 构建（BuildKit cache）
# - runner：基于 Next.js standalone 的极简 Web 生产镜像（~250MB 替代 1.8GB node_modules）
# - worker-go：纯静态 Distroless 二进制
# ─────────────────────────────────────────────────────────────

# 版本须与 services/*/go.mod 的 go 指令对齐（官方 golang 镜像 GOTOOLCHAIN=local，
# 不会自动下载更高工具链，低版本镜像会直接构建失败）
FROM golang:1.26-alpine AS gobuild
WORKDIR /src/services/worker-sidecar
COPY services/worker-sidecar/go.mod services/worker-sidecar/go.sum ./
RUN --mount=type=cache,target=/go/pkg/mod \
    go mod download
COPY services/worker-sidecar/ ./
RUN --mount=type=cache,target=/go/pkg/mod \
    --mount=type=cache,target=/root/.cache/go-build \
    CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sidecar . && cp /out/sidecar /out/worker-sidecar

FROM node:22-slim AS deps
WORKDIR /app
# openssl 先于 prisma generate 安装——缺它时 generate 探测回落 openssl-1.1.x，
# 运行期（openssl-3.x 环境）即报 Query Engine 目标错配
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*
# workspace 包清单必须先于 npm ci 拷入——否则 npm 看不到 workspace 包，
# 仅在其内声明的依赖（如 @aws-sdk/client-s3）不会被安装
COPY package.json package-lock.json ./
COPY apps/client/package.json apps/client/
RUN --mount=type=cache,target=/root/.npm \
    npm ci --prefer-offline
# Prisma client 生成（仅执行一次，供后续 builder 复用）
COPY prisma ./prisma
RUN npx prisma generate

FROM deps AS builder
WORKDIR /app
ENV NODE_OPTIONS="--max-old-space-size=2560"
# 构建期 page data 收集会执行模块顶层（含 NEXTAUTH_SECRET fail-fast 安全校验）。
# 此占位值只存在于 builder 阶段——runner 阶段独立 FROM，不继承该 ENV，
# 运行时未配置真实 NEXTAUTH_SECRET 仍会 fail-fast 拒绝启动。
ENV NEXTAUTH_SECRET=build-time-page-data-placeholder

# 仅拷贝 Web 构建所需文件，避免 Go/文档/脚本改动触发 Next.js 重编
COPY tsconfig.json ./
COPY apps/client ./apps/client
WORKDIR /app/apps/client
# apps/client 的 build 脚本内部已包含 i18n:compile，无需在外部重复执行；
# 挂载 .next/cache 保留 Turbopack/Next 增量编译缓存
RUN --mount=type=cache,target=/app/apps/client/.next/cache \
    npm run build

# ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# 引入 jemalloc 抑制内存碎片，安装 openssl（供 prisma migrate deploy）与 CJK 中文字体（Satori / next/og 社交分享卡片）
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl libjemalloc2 fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s $(find /usr/lib -name 'libjemalloc.so.2' | head -n 1) /usr/local/lib/libjemalloc.so
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so

# 仅安装 prisma CLI（供 docker-entrypoint.sh 执行 migrate deploy），避免向运行镜像拷贝 1.8GB 全量 node_modules
RUN --mount=type=cache,target=/root/.npm \
    npm install -g --no-audit --no-fund prisma@6.19.3

# 非 root 运行
RUN groupadd -r appuser && useradd -r -g appuser appuser

# Next.js standalone 精简运行时 + 静态资源 + Prisma schema/migrations
COPY --from=builder --chown=appuser:appuser /app/apps/client/.next/standalone ./
COPY --from=builder --chown=appuser:appuser /app/apps/client/.next/static ./apps/client/.next/static
COPY --from=builder --chown=appuser:appuser /app/apps/client/public ./apps/client/public
COPY --from=builder --chown=appuser:appuser /app/prisma ./prisma

# 持久化卷目录 & 可写 .next/cache（防止 appuser 写 fetch-cache 报 EACCES）
RUN mkdir -p /app/storage/assets /app/storage/repos /app/apps/client/.next/cache \
  && chown -R appuser:appuser /app/storage /app/apps/client/.next

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER appuser
WORKDIR /app/apps/client
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "server.js"]

# ─────────────────────────────────────────────────────────────
# worker-go（或 sidecar-go）：Unified Sidecar Daemon（EXPOSE 8081 8082）。
# 单进程双活承接 MCP 机器协议与 Worker 调度控制，~25MB 纯静态 Distroless 镜像。
# ─────────────────────────────────────────────────────────────
FROM gcr.io/distroless/static-debian12:nonroot AS worker-go
WORKDIR /app
COPY --from=gobuild /out/sidecar /usr/local/bin/sidecar
COPY --from=gobuild /out/worker-sidecar /usr/local/bin/worker-sidecar
USER nonroot:nonroot
EXPOSE 8081 8082
ENTRYPOINT ["/usr/local/bin/sidecar"]

