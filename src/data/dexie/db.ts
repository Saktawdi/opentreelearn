import Dexie, { type Table } from 'dexie'
import type {
  Asset,
  GlobalSettings,
  Id,
  Message,
  Node,
  Note,
  Project,
  ProjectSettings,
} from '@/domain/models'
import type { SyncEntity } from '@/domain/sync'

export interface SettingsRecord {
  key: string
  value: GlobalSettings
}

export const SETTINGS_KEY = 'global'

/**
 * 待推送的本地变更台账（outbox）。
 *
 * 只记「谁改过」不记内容：push 时按 `entity + localId` 读当前记录 —— 中间态没有必要
 * 上传，本机最终状态才是要同步的东西。删除要单独记一条（记录本身已经不在库里了）。
 */
export interface OutboxRecord {
  /** 自增主键，同时定义 push 顺序 */
  seq?: number
  entity: SyncEntity
  localId: Id
  op: 'upsert' | 'delete'
  /** 这次变更的时间（epoch ms），push 时作为该记录的 LWW 时间戳 */
  updatedAt: number
}

export const SYNC_STATE_KEY = 'sync'

/** 同步状态：游标与首次登录决策都跟着库走（分账号分库后天然按账号隔离）。 */
export interface SyncStateRecord {
  key: string
  /** 已拉取到的服务端 rev 游标 */
  cursor: number
  lastSyncedAt: number | null
  /** 本机是否已做过首次登录决策；新账号库为 false → 弹「本机数据怎么办」 */
  initialized: boolean
}

export class AppDatabase extends Dexie {
  projects!: Table<Project, Id>
  projectSettings!: Table<ProjectSettings, Id>
  nodes!: Table<Node, Id>
  messages!: Table<Message, Id>
  assets!: Table<Asset, Id>
  notes!: Table<Note, Id>
  settings!: Table<SettingsRecord, string>
  outbox!: Table<OutboxRecord, number>
  syncState!: Table<SyncStateRecord, string>

  constructor(name = 'opentreelearn') {
    super(name)

    this.version(1).stores({
      projects: 'id, updatedAt, *tags',
      projectSettings: 'projectId',
      nodes: 'id, projectId, parentId, [projectId+parentId]',
      messages: 'id, nodeId, projectId, [nodeId+createdAt]',
      assets: 'id, projectId',
      settings: 'key',
    })

    // v2 只加表，不改老表：Dexie 会把新声明合并进已有 schema，v1 的索引原样保留。
    // nodeId 与 messageId 都建索引 —— 删除节点/重试消息时都要按它们级联清笔记。
    this.version(2).stores({
      notes: 'id, projectId, nodeId, messageId',
    })

    // v3 同样只加表：outbox 是变更台账（[entity+localId] 便于把同一条记录的多次改动并成一条），
    // syncState 存游标与「本机是否已做过首次登录决策」。
    this.version(3).stores({
      outbox: '++seq, entity, localId, [entity+localId]',
      syncState: 'key',
    })
  }
}