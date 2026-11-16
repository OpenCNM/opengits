# ─────────────────────────────────────────────────────────────
# OpenGits Client (Web) 生产镜像 (node:22-slim, EXPOSE 3000)
# 附加 target `worker-go`：Go worker sidecar（纯静态 Distroless 镜像，~24MB）。
# 完全切断 Node.js / V8 / npm / libc 依赖，冷启动 < 10ms，常驻内存 ~15MB。
#
# 阶段拆分：
# - gobuild：Go 原生二进制多阶段编译
# - deps / builder / runner：Web 生产环境
# - worker-go：纯静态 Distroless 二进制
# ─────────────────────────────────────────────────────────────

# 版本须与 services/*/go.mod 的 go 指令对齐（官方 golang 镜像 GOTOOLCHAIN=local，
# 不会自动下载更高工具链，低版本镜像会直接构建失败）
FROM golang:1.26-alpine AS gobuild
WORKDIR /src/services/worker-sidecar
COPY services/worker-sidecar/go.mod services/worker-sidecar/go.sum ./
RUN go mod download
COPY services/worker-sidecar/ ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/sidecar . && cp /out/sidecar /out/worker-sidecar

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
RUN npm ci
# Prisma client 生成（worker-go 的 tsx 引擎子进程与 web 共用同一 client）
COPY prisma ./prisma
RUN npx prisma generate

FROM node:22-slim AS builder
WORKDIR /app
# 构建期 page data 收集会执行模块顶层（含 NEXTAUTH_SECRET fail-fast 安全校验）。
# 此占位值只存在于 builder 阶段——runner 阶段独立 FROM，不继承该 ENV，
# 运行时未配置真实 NEXTAUTH_SECRET 仍会 fail-fast 拒绝启动。
ENV NEXTAUTH_SECRET=build-time-page-data-placeholder
COPY --from=deps /app/node_modules ./node_modules
COPY prisma ./prisma
RUN npx prisma generate

# 源码拷贝与 Client 应用构建
COPY . .
WORKDIR /app/apps/client
RUN npm run build

# ─────────────────────────────────────────────────────────────
FROM node:22-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000
ENV PATH="/app/node_modules/.bin:$PATH"

# 引入 jemalloc 抑制内存碎片，并安装 CJK 中文字体（供 Satori / next/og 社交分享卡片在 Linux 容器内保真渲染）
RUN apt-get update -y && apt-get install -y --no-install-recommends libjemalloc2 fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/* \
  && ln -s $(find /usr/lib -name 'libjemalloc.so.2' | head -n 1) /usr/local/lib/libjemalloc.so
ENV LD_PRELOAD=/usr/local/lib/libjemalloc.so

# 非 root 运行
RUN groupadd -r appuser && useradd -r -g appuser appuser

# 全量运行时
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/apps/client/.next ./apps/client/.next
COPY --from=builder /app/apps/client/public ./apps/client/public
COPY --from=builder /app/apps/client/package.json ./apps/client/package.json
COPY --from=builder /app/apps/client/next.config.ts ./apps/client/next.config.ts
COPY --from=builder /app/apps/client/tsconfig.json ./apps/client/tsconfig.json
COPY --from=builder /app/apps/client/src ./apps/client/src
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/package.json ./package.json

# 持久化卷目录
RUN mkdir -p /app/storage/assets /app/storage/repos && chown -R appuser:appuser /app/storage

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER appuser
WORKDIR /app/apps/client
EXPOSE 3000

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["next", "start", "-p", "3000"]

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

