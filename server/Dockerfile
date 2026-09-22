# 同步服务镜像：NestJS 构建 → 只带生产依赖运行，启动时自动应用数据库迁移。
#
# 构建（在 server/ 目录，compose 已配好）：
#   docker build -t opentreelearn/sync-api:local .
# 运行需要 DATABASE_URL（SQLite 指向挂载卷里的文件，见根 docker-compose.yml）。

ARG NODE_VERSION=22
ARG PNPM_VERSION=11.21.0

# ---------- base：锁定 Node / pnpm 版本 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS base
ARG PNPM_VERSION
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION} && rm -rf /root/.npm
WORKDIR /app

# ---------- deps：全量依赖（构建与 Prisma Client 生成都要）----------
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# ---------- build：Nest 产物 ----------
FROM deps AS build
COPY . .
RUN pnpm exec prisma generate && pnpm run build

# ---------- runtime：生产依赖 + 迁移能力，非 root 运行 ----------
FROM base AS runtime
ENV NODE_ENV=production

# Prisma 的查询引擎 / 迁移引擎依赖 openssl 3，bookworm-slim 默认没带
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl \
  && rm -rf /var/lib/apt/lists/*

# prisma CLI 在 dependencies 里，所以 --prod 也带得上（migrate deploy 要用）。
# store / cache 都落在 /tmp 与 /root，装完即删（node_modules 是硬链接，删 store 不影响
# 已装好的文件）：不删的话所有包会在镜像里再存一份，白白多出三四百 MB。
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY prisma ./prisma
RUN pnpm install --prod --frozen-lockfile --store-dir=/tmp/pnpm-store \
  && pnpm exec prisma generate \
  && rm -rf /tmp/pnpm-store /root/.cache /root/.npm \
  && mkdir -p /data \
  && chown -R node:node /app /data

COPY --from=build /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

USER node
EXPOSE 3901
ENTRYPOINT ["docker-entrypoint.sh"]