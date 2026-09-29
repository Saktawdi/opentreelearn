# 前端镜像：Vite 构建 → nginx 托管静态产物，并把 /lern-api 反代到同步服务。
#
# 构建上下文是仓库根目录（compose 已配好）：
#   docker build -t opentreelearn/web:local .
# 只跟 api 服务一起用：nginx 配置里的上游主机名 `api` 由 compose 网络解析。

ARG NODE_VERSION=22
ARG PNPM_VERSION=11.21.0

# ---------- build：Vite 产物 ----------
FROM node:${NODE_VERSION}-bookworm-slim AS build
ARG PNPM_VERSION
ENV CI=true
RUN npm install -g pnpm@${PNPM_VERSION}
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build

# ---------- runtime：nginx 托管 ----------
FROM nginx:1.27-alpine AS runtime
# TrustAsia TLS ECC Root CA（2025 新根，经 Certum Trusted Network CA 交叉签名）还没进
# Alpine/Mozilla 信任库；不装它，/api-proxy 对用这批新根签发证书的上游（如自建中转站
# newapi.sakta.top）会在 TLS 握手校验阶段失败，nginx 回 502。取自中间证书的 AIA：
# http://ica.litessl.com/TrustAsiaTLSECCRootCA.crt
COPY docker/trustasia-tls-ecc-root-ca-cross.crt /usr/local/share/ca-certificates/
RUN apk add --no-cache ca-certificates && update-ca-certificates
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80