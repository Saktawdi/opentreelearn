/**
 * 同步协议里客户端与服务端共用的形状（服务端对应 `server/src/entities.ts` 与 `sync-types.ts`）。
 *
 * 放在 domain 而不是 services：data 层（本地 outbox / applyRemote）也要用这些类型，
 * 而按分层约束 data 只依赖 domain —— 让 data 反向依赖 services 会破坏这条线。
 */

/**
 * 参与同步的实体。`asset` 只是先占位与服务端对齐：图片是二进制，
 * 走对象存储属于 P2，现在 pull 到 asset 记录会被直接跳过（见 sync-local 的适配器表）。
 */
export const SYNC_ENTITIES = [
  'project',
  'projectSettings',
  'node',
  'message',
  'note',
  'globalSettings',
  'asset',
] as const

export type SyncEntity = (typeof SYNC_ENTITIES)[number]

export function isSyncEntity(value: unknown): value is SyncEntity {
  return typeof value === 'string' && (SYNC_ENTITIES as readonly string[]).includes(value)
}

/** 一条同步记录在线上的样子。 */
export interface WireChange {
  entity: SyncEntity
  /** 客户端生成的实体 id；globalSettings 固定为 'global' */
  id: string
  /** 服务端分配的单调修订号 */
  rev: number
  /** 客户端时钟（epoch ms），LWW 依据 */
  updatedAt: number
  /** 非空即删除标记（tombstone），此时 data 为 {} */
  deletedAt: number | null
  data: unknown
}

export interface WireApplied {
  entity: SyncEntity
  id: string
  rev: number
  status: 'applied' | 'stale'
  /** status 为 stale 时带回服务端版本，客户端据此覆盖本地 */
  record?: WireChange
}

export interface PullResult {
  cursor: number
  hasMore: boolean
  changes: WireChange[]
}

export interface PushResult {
  cursor: number
  applied: WireApplied[]
}

export interface RemoteSyncStatus {
  account?: { loginName?: string; userId?: number }
  /** 云端有效记录数（不含 tombstone） */
  records: number
  cursor: number
  latestUpdatedAt: number | null
}

/** globalSettings 在同步里的固定 localId —— 全局设置只有一份。 */
export const GLOBAL_SETTINGS_ID = 'global'

/** 首次登录时对「本机已有数据」的处理方式。 */
export type FirstLoginPolicy = 'merge' | 'cloud' | 'localOnly'