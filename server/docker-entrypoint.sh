#!/bin/sh
# 同步服务容器入口：先应用数据库迁移，再启动进程。
# 迁移失败就直接退出（不带着旧 schema 对外服务），交给编排层的重启策略处理。
set -eu

echo "[entrypoint] prisma migrate deploy"
pnpm run prisma:migrate:deploy

echo "[entrypoint] start sync api (port ${PORT:-3901})"
exec node dist/main