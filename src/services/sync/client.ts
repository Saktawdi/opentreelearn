import type {
  PullResult,
  PushResult,
  RemoteSyncStatus,
  SyncEntity,
} from '@/domain/sync'
import { ApiError, interpretEnvelope, readJson } from '@/services/api/envelope'
import { errorMessage } from '@/lib/utils'

/**
 * 同步服务（仓库里的 `server/`）基地址。
 *
 * 默认走同源 `/lern-api`：开发由 Vite 代理，生产由部署侧反代同一路径，
 * 这样浏览器不必依赖 CORS。需要直连其它地址时用 `VITE_SYNC_BASE_URL` 覆盖。
 */
export const SYNC_BASE_URL =
  (import.meta.env.VITE_SYNC_BASE_URL as string | undefined)?.replace(/\/+$/, '') || '/lern-api'

/** 单次 push 的条数上限，与服务端 `MAX_PUSH_CHANGES` 对齐。 */
export const PUSH_BATCH_SIZE = 200

export interface OutgoingChange {
  entity: SyncEntity
  id: string
  updatedAt: number
  /** 非空即删除（tombstone），此时不带 data */
  deletedAt?: number
  data?: Record<string, unknown>
}

async function request<T>(
  path: string,
  options: { method?: 'GET' | 'POST'; token: string; body?: unknown },
): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json', token: options.token }
  let body: string | undefined
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.body)
  }

  let response: Response
  try {
    response = await fetch(`${SYNC_BASE_URL}${path}`, {
      method: options.method ?? 'GET',
      headers,
      body,
    })
  } catch (error) {
    throw new ApiError(`无法连接同步服务：${errorMessage(error)}`, 0)
  }

  const envelope = interpretEnvelope<unknown>(await readJson(response), response.status)
  return envelope.data as T
}

export async function pullChanges(
  token: string,
  cursor: number,
  limit?: number,
): Promise<PullResult> {
  const query = new URLSearchParams({ cursor: String(cursor) })
  if (limit) query.set('limit', String(limit))
  return request<PullResult>(`/sync/pull?${query.toString()}`, { token })
}

export async function pushChanges(
  token: string,
  changes: OutgoingChange[],
): Promise<PushResult> {
  return request<PushResult>('/sync/push', { method: 'POST', token, body: { changes } })
}

export async function fetchRemoteStatus(token: string): Promise<RemoteSyncStatus> {
  return request<RemoteSyncStatus>('/sync/status', { token })
}