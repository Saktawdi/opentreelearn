import type { SyncEntity } from '../entities'

/** 一条同步记录在线上的样子。 */
export interface WireChange {
  entity: SyncEntity
  /** 客户端生成的 id（`crypto.randomUUID()`），服务端不重编号 */
  id: string
  /** 服务端分配的单调修订号，账号内递增 */
  rev: number
  /** 客户端时钟（epoch ms），LWW 依据 */
  updatedAt: number
  /** 非空即删除标记；此时 data 固定为 {} */
  deletedAt: number | null
  data: unknown
}

/** push 的结果条目。 */
export interface WireApplied {
  entity: SyncEntity
  id: string
  rev: number
  /** applied = 已接受；stale = 服务端版本更新，record 带回服务端版本供客户端覆盖本地 */
  status: 'applied' | 'stale'
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

export interface SyncStatus {
  records: number
  cursor: number
  /** 服务端已存记录里最新的客户端更新时间，便于判断云端是否有数据 */
  latestUpdatedAt: number | null
}