# OpenTreeLearn Sync Service (BFF)

> [简体中文](README.md) · English

The web app is a local-first learning workspace (Vite SPA + IndexedDB). The account system (`https://api.sakta.top`) **provides identity only** — it has no data-storage endpoints at all. Cross-device sync therefore stores data in this service: it exchanges the account system's token for a user, persists each user's records, and serves incremental pull/push.

## Getting Started

```bash
cd server
pnpm install
cp .env.example .env          # adjust PORT / RUIYI_API_URL / CORS_ORIGIN as needed
pnpm prisma migrate dev       # create the database (SQLite file prisma/dev.db)
pnpm start:dev                # http://localhost:3901/api
```

- API docs (Swagger): `http://localhost:3901/api/docs`
- Unit tests: `pnpm test` (protocol rules: LWW, pagination, payload limits, CORS rules)
- Production: `pnpm build && NODE_ENV=production node dist/main`

## Endpoints

All endpoints live under the `/api` prefix. Auth headers accept either `token: <JWT>` or `Authorization: Bearer <JWT>`; the guard validates a token by **forwarding it to the account system's `getInfo`** (no shared JWT secret), caching the result for the same token for 60s.

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/health` | **No auth**: liveness + database connectivity (container / load-balancer probes) |
| `POST` | `/api/auth/dev-token` | **Dev only** (`ALLOW_DEV_TOKEN=true` and non-production): issues a `dev-<account>` token, bypassing the account system for local integration |
| `GET` | `/api/sync/pull?cursor=0&limit=200` | Incremental pull by cursor, returns `{ cursor, hasMore, changes[] }` |
| `POST` | `/api/sync/push` | Batch-write local changes, returns `{ cursor, applied[] }` |
| `GET` | `/api/sync/status` | Current account, live record count, latest cursor (clients use it to detect existing cloud data) |

The response envelope matches the account system and the Blog BFF:

```json
{ "code": 0, "msg": "操作成功", "data": {} }
```

On failure `code` is the HTTP status code and `msg` is safe to show users; for validation errors the first message is returned.

### Shape of a Record

```jsonc
// POST /api/sync/push
{
  "changes": [
    { "entity": "node", "id": "<client uuid>", "updatedAt": 1758000000000,
      "data": { "title": "极限与连续", "parentId": null } },
    // deletions are expressed as tombstones (data is ignored)
    { "entity": "project", "id": "<uuid>", "updatedAt": 1758000001000, "deletedAt": 1758000001000 }
  ]
}
```

`entity` ∈ `project` / `projectSettings` / `node` / `message` / `note` / `globalSettings` / `asset`.

## Sync Semantics

- **Cursor**: the server assigns each record an account-scoped, monotonically increasing `rev`; pull returns records with `rev > cursor`, and the client stores `cursor` for incrementals. **Timestamps are never used as cursors** — client clocks cannot be trusted.
- **Conflicts**: per-record last-write-wins, compared on the client's `updatedAt`. Losing writes (including ties) get `status: "stale"` plus the server version, which the client uses to overwrite local state; therefore **push is idempotent** — re-pushing the same batch does not produce new `rev`s.
- **Deletion**: only tombstones propagate (`deletedAt` set). Pull returns tombstones too, and the client deletes the local record upon receiving one.
- **Limits**: single JSON ≤ 256KB, ≤ 200 records per batch, ≤ 1000 records per pull page; violations fail with 400 — nothing is silently truncated.
- **Account isolation**: records are grouped by `accountId`, with `loginName` as the account mapping key (a userId change on the account-system side is picked up automatically).

## Data Model

Single polymorphic table, entity payloads stored as JSON:

```prisma
model Account  { id, loginName @unique, userId, revCounter, createdAt, lastSeenAt }
model SyncRecord {
  id, accountId, entity, localId, rev,
  clientUpdatedAt, deletedAt, data, receivedAt
  @@unique([accountId, entity, localId]) @@index([accountId, rev])
}
```

This means client-side entity evolution (new fields, new entities) **requires no server migration** — the trade-off is that the server does not validate payload internals; it only guarantees correct indexing and ordering.

## Environment Variables

See `.env.example`. Key points:

- `RUIYI_API_URL`: account system URL, used by the guard to verify tokens.
- `CORS_ORIGIN`: comma-separated allowlist; non-production additionally allows `localhost` / `127.0.0.1` on any port (the Vite port drifts).
- `ALLOW_DEV_TOKEN` / `ALLOW_INSECURE_TLS` / `ENABLE_SWAGGER`: **effective in non-production only** — production never enables them, no matter what.
- `NODE_ENV=production` is the only production marker this service recognizes.

## Deployment

### Docker (recommended: one command with the frontend included)

The repository's `docker-compose.yml` starts two containers: `web` (nginx serves the frontend `dist` and reverse-proxies `/lern-api` to `api`) and `api` (this service + an SQLite volume). The api publishes no host port — browsers always use same-origin `/lern-api`, so CORS is irrelevant.

```bash
cp .env.docker.example .env      # optional: change RUIYI_API_URL / CORS_ORIGIN / WEB_PORT
docker compose up -d --build     # open http://localhost:8080
```

- **Migrations run automatically**: the container entrypoint runs `prisma migrate deploy` before starting; if a migration fails the container exits rather than serving with an outdated schema. This is why the `prisma` CLI lives in `dependencies` — it must survive `--prod` installs.
- **Data**: SQLite lives in the named volume `opentreelearn-sync-db` (mounted at `/data/sync.db`).
  Backup: `docker compose cp api:/data/sync.db ./sync-$(date +%F).db`; restore: copy the file back to `/data/sync.db` and `docker compose restart api`.
- **Production switches**: compose hard-codes `NODE_ENV=production`, so Swagger and dev-token are automatically off (no need to manually clear `ALLOW_DEV_TOKEN`).
- **Images**: `opentreelearn/web:local` (nginx + static assets) and `opentreelearn/sync-api:local` (Node + Prisma engines + production deps). Both Dockerfiles sit next to their packages: the root `Dockerfile` (frontend) and `server/Dockerfile` (this service).

### Classic deployment (PM2 / systemd)

1. `pnpm build`, then run with `NODE_ENV=production node dist/main` (migrations need a manual `pnpm prisma:migrate:deploy`).
2. Reverse-proxy `/lern-api` on the frontend to this service (same-origin proxying is already configured in the root `vite.config.ts` for development), so the browser doesn't depend on CORS; for direct connections, add the frontend origin to `CORS_ORIGIN`.
3. The SQLite file is at `prisma/dev.db` (controlled by `DATABASE_URL`) — back it up by copying the file. Fine at this scale; switching to Postgres later only means changing the datasource and migrations.
4. In production make sure `ALLOW_DEV_TOKEN` is unset: that route is the only way to bypass the account system (non-production only, but don't leave the hazard around).
