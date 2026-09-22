# OpenTreeLearn 同步服务（BFF）

前端是 local-first 的学习工作台（Vite SPA + IndexedDB），账号系统（`https://api.sakta.top`）**只提供身份**，没有任何数据存储接口。所以多端同步的数据落点在这个服务里：它负责把账号系统的 token 换成用户、把每个用户的记录存下来，并提供增量 pull/push。

架构照 Blog 的 `sakta-bff`：NestJS 10 + Prisma + SQLite。

## 快速开始

```bash
cd server
pnpm install
cp .env.example .env          # 按需改 PORT / RUIYI_API_URL / CORS_ORIGIN
pnpm prisma migrate dev       # 建库（SQLite 文件 prisma/dev.db）
pnpm start:dev                # http://localhost:3901/api
```

- 接口文档（Swagger）：`http://localhost:3901/api/docs`
- 单测：`pnpm test`（协议规则：LWW、分页、载荷上限、CORS 规则）
- 生产：`pnpm build && NODE_ENV=production node dist/main`

## 接口

所有接口都在 `/api` 前缀下，鉴权头支持 `token: <JWT>` 与 `Authorization: Bearer <JWT>` 两种形式；token 由守卫**转发账号系统 `getInfo`** 校验（不共享 JWT 密钥），同一 token 的结果缓存 60s。

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/health` | **无鉴权**：存活 + 数据库连通（容器/负载均衡探活） |
| `POST` | `/api/auth/dev-token` | **仅开发**（`ALLOW_DEV_TOKEN=true` 且非生产）：签发 `dev-<账号名>` token，绕过账号系统联调 |
| `GET` | `/api/sync/pull?cursor=0&limit=200` | 按游标增量拉取，返回 `{ cursor, hasMore, changes[] }` |
| `POST` | `/api/sync/push` | 批量写入本地变更，返回 `{ cursor, applied[] }` |
| `GET` | `/api/sync/status` | 当前账号、有效记录数、最新游标（客户端用它判断云端是否已有数据） |

响应信封与账号系统、Blog BFF 一致：

```json
{ "code": 0, "msg": "操作成功", "data": {} }
```

失败时 `code` 为 HTTP 状态码，`msg` 可直接展示给用户；校验失败取第一条信息。

### 记录的形状

```jsonc
// POST /api/sync/push
{
  "changes": [
    { "entity": "node", "id": "<客户端 uuid>", "updatedAt": 1758000000000,
      "data": { "title": "极限与连续", "parentId": null } },
    // 删除用 tombstone 表达（data 会被忽略）
    { "entity": "project", "id": "<uuid>", "updatedAt": 1758000001000, "deletedAt": 1758000001000 }
  ]
}
```

`entity` ∈ `project` / `projectSettings` / `node` / `message` / `note` / `globalSettings` / `asset`。

## 同步语义

- **游标**：服务端给每条记录分配账号内单调递增的 `rev`，pull 返回 `rev > cursor` 的记录；客户端存 `cursor` 做增量。**不用时间戳做游标**——客户端时钟不可信。
- **冲突**：逐条 last-write-wins，比客户端 `updatedAt`。判旧（含相等）返回 `status: "stale"` 并带上服务端版本，客户端据此覆盖本地；因此 **push 是幂等的**，重推同一批不会写出新 `rev`。
- **删除**：只有 tombstone 能传播（`deletedAt` 非空）。pull 会把 tombstone 一起带回，客户端收到后删本地记录。
- **上限**：单条 JSON ≤ 256KB、单批 ≤ 200 条、pull 单页 ≤ 1000 条，超出直接 400，不静默截断。
- **账号隔离**：记录按 `accountId` 分组，`loginName` 是账号映射键（账号系统侧改 userId 会跟着更新）。

## 数据模型

单表多态，实体内容存 JSON：

```prisma
model Account  { id, loginName @unique, userId, revCounter, createdAt, lastSeenAt }
model SyncRecord {
  id, accountId, entity, localId, rev,
  clientUpdatedAt, deletedAt, data, receivedAt
  @@unique([accountId, entity, localId]) @@index([accountId, rev])
}
```

这样客户端实体演进（新增字段、新增实体）**不需要服务端迁移**——代价是服务端不校验载荷内部结构，只保证索引与顺序正确。

## 环境变量

见 `.env.example`。要点：

- `RUIYI_API_URL`：账号系统地址，守卫用它校验 token。
- `CORS_ORIGIN`：逗号分隔白名单；非生产环境额外放行 `localhost` / `127.0.0.1` 任意端口（Vite 端口会漂移）。
- `ALLOW_DEV_TOKEN` / `ALLOW_INSECURE_TLS` / `ENABLE_SWAGGER`：**只在非生产环境生效**，生产环境无论如何都不开。
- `NODE_ENV=production` 是本服务唯一认可的生产标记。

## 部署

### Docker（推荐：一条命令带上前端）

仓库根目录的 `docker-compose.yml` 起两个容器：`web`（nginx 托管前端 `dist`，并把 `/lern-api` 反代到 `api`）与 `api`（本服务 + SQLite 卷）。api 不发布宿主端口，浏览器一律走同源 `/lern-api`，不依赖 CORS。

```bash
cp .env.docker.example .env      # 可选：改 RUIYI_API_URL / CORS_ORIGIN / WEB_PORT
docker compose up -d --build     # 访问 http://localhost:8080
```

- **迁移自动跑**：容器入口先 `prisma migrate deploy` 再起服务；迁移失败即退出，不会带着旧 schema 对外服务。因此 `prisma` CLI 放在 `dependencies` 里——`--prod` 安装也要带上它。
- **数据**：SQLite 在命名卷 `opentreelearn-sync-db`（容器内 `/data/sync.db`）。
  备份：`docker compose cp api:/data/sync.db ./sync-$(date +%F).db`；恢复：反向复制回 `/data/sync.db` 后 `docker compose restart api`。
- **生产开关**：compose 里写死 `NODE_ENV=production`，Swagger 与 dev-token 自动关闭（不再需要手工清 `ALLOW_DEV_TOKEN`）。
- **镜像**：`opentreelearn/web:local`（nginx + 静态产物）、`opentreelearn/sync-api:local`（Node + Prisma 引擎 + 生产依赖）。两个 Dockerfile 都与各自的包同目录：根 `Dockerfile`（前端）与 `server/Dockerfile`（本服务）。

### 传统方式（PM2 / systemd）

1. `pnpm build`，用 `NODE_ENV=production node dist/main` 起进程（迁移需手工 `pnpm prisma:migrate:deploy`）。
2. 前端把 `/lern-api` 反代到本服务（开发已在根 `vite.config.ts` 配好同源代理），这样浏览器不必依赖 CORS；若要直连，把前端源写进 `CORS_ORIGIN`。
3. SQLite 文件在 `prisma/dev.db`（由 `DATABASE_URL` 决定），备份直接复制该文件；量级不大时够用，将来要换 Postgres 只需改 datasource 与迁移。
4. 生产环境请清空 `ALLOW_DEV_TOKEN`：那一路径是唯一能绕过账号系统的入口（非生产才生效，但别留隐患）。

## 已知坑

- **`cors` 的函数 origin 会挂死请求**：该包把函数形式的 `origin` 当异步回调 `(origin, callback)`，同步返回布尔的函数永远不调 callback，表现为「连接建立、零字节响应」。所以 `createCorsOrigin()` 返回字符串/正则数组，并有单测锁住这一点。
- **body 上限**：Nest 默认 100KB，push 是批量提交，这里放宽到 16MB（`main.ts` 的 `BODY_LIMIT`），并用 `useBodyParser` 显式注册。nginx 侧也要放宽（`docker/nginx.conf` 的 `client_max_body_size 20m`），否则大 push 会先被网关 413 掉。
- **每次校验一次外部调用**：token 校验转发 `getInfo`，靠 60s 缓存摊薄；同步是低频批量操作，够用。
- **镜像里的 pnpm store/cache**：pnpm 把包硬链接进 `node_modules`，但 store（`~/.local/share/pnpm/store`）与元数据缓存（`~/.cache/pnpm`）会留在镜像里，实测多占约 350MB。`server/Dockerfile` 用 `--store-dir=/tmp/pnpm-store` 装完后在同层 `rm -rf`，并清掉 prisma 的下载缓存；改 Dockerfile 时别把这一步弄丢。