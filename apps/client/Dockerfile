# ─────────────────────────────────────────────────────────────
# OpenGits Client (Web) 独立生产镜像 (node:22-slim, EXPOSE 3000)
# ─────────────────────────────────────────────────────────────

FROM node:22-slim AS builder
WORKDIR /app

# 依赖安装（利用层缓存）
COPY package.json package-lock.json ./
RUN PUPPETEER_SKIP_DOWNLOAD=true npm ci

# Prisma client 生成
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

# 安装 CJK 中文字体（供 Satori / next/og 社交分享卡片保真渲染，消除 Linux 容器豆腐块乱码）与配置非 root 运行
RUN apt-get update -y && apt-get install -y --no-install-recommends fonts-wqy-zenhei \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd -r appuser && useradd -r -g appuser appuser

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
