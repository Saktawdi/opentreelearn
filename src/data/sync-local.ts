import type { Id, ProjectSettings } from '@/domain/models'
import { normalizeGlobalSettings } from '@/domain/normalize'
import {
  GLOBAL_SETTINGS_ID,
  type SyncEntity,
  type WireChange,
} from '@/domain/sync'
import {
  SETTINGS_KEY,
  SYNC_STATE_KEY,
  type AppDatabase,
  type OutboxRecord,
  type ReviewSessionRow,
  type SyncStateRecord,
} from './dexie/db'

/** 本地记录的同步载荷 + 它自身的时间戳。 */
export interface LocalPayload {
  data: Record<string, unknown>
  /** 记录自身的 updatedAt；0 表示没有这个概念（如旧数据）。 */
  updatedAt: number
}

export type ApplyOutcome = 'written' | 'deleted' | 'skipped'

interface EntityAdapter {
  load(localId: Id): Promise<LocalPayload | null>
  save(change: WireChange): Promise<void>
  remove(localId: Id): Promise<void>
  listIds(): Promise<Id[]>
}

/**
 * 删除项目时清掉它名下的行（不发 outbox）。
 *
 * 单独抽出来是因为它有两条调用路径：本机删除（repos 记账后调用）与
 * 收到远端 project 的 tombstone（不记账 —— 把远端删除再推回去会形成回环）。
 */
export async function purgeProjectRows(db: AppDatabase, projectId: Id): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.projects,
      db.projectSettings,
      db.nodes,
      db.messages,
      db.assets,
      db.notes,
      db.reviewSessions,
      db.composerDrafts,
    ],
    async () => {
      await db.projects.delete(projectId)
      await db.projectSettings.delete(projectId)
      await db.nodes.where('projectId').equals(projectId).delete()
      await db.messages.where('projectId').equals(projectId).delete()
      await db.assets.where('projectId').equals(projectId).delete()
      await db.notes.where('projectId').equals(projectId).delete()
      // 复习会话只存在本机：项目没了，参考它的进度与草稿也没有意义
      await db.reviewSessions.where('projectId').equals(projectId).delete()
      // 输入框草稿同理，还带着待发图片的 Blob，不清就是实打实的孤儿数据
      await db.composerDrafts.where('projectId').equals(projectId).delete()
    },
  )
}

/** 项目/节点/消息/笔记的形状一致：主键 id，带 updatedAt。 */
function tableAdapter<T extends { id: Id; updatedAt?: number }>(
  table: AppDatabase['projects'] | AppDatabase['nodes'] | AppDatabase['messages'] | AppDatabase['notes'],
): EntityAdapter {
  const rows = table as unknown as {
    get(id: Id): Promise<T | undefined>
    put(value: T): Promise<unknown>
    delete(id: Id): Promise<void>
    toCollection(): { primaryKeys(): Promise<unknown[]> }
  }

  return {
    load: async (localId) => {
      const row = await rows.get(localId)
      if (!row) return null
      return {
        data: row as unknown as Record<string, unknown>,
        updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
      }
    },
    save: async (change) => {
      await rows.put(change.data as T)
    },
    remove: (localId) => rows.delete(localId),
    listIds: async () => (await rows.toCollection().primaryKeys()) as Id[],
  }
}

/** API Key 只留在本机：同步载荷里抹掉，应用远端版本时按 provider id 把本机密钥补回去。 */
function stripProviderKeys(data: Record<string, unknown>): Record<string, unknown> {
  const providers = Array.isArray(data.providers) ? data.providers : []
  return {
    ...data,
    providers: providers.map((provider) => ({
      ...(provider as Record<string, unknown>),
      apiKey: '',
    })),
  }
}

function restoreProviderKeys(
  remote: ReturnType<typeof normalizeGlobalSettings>,
  local: ReturnType<typeof normalizeGlobalSettings>,
): ReturnType<typeof normalizeGlobalSettings> {
  const providers = remote.providers.map((provider) => {
    if (provider.apiKey) return provider
    const mine = local.providers.find((item) => item.id === provider.id)
    return mine?.apiKey ? { ...provider, apiKey: mine.apiKey } : provider
  })
  return { ...remote, providers }
}

/**
 * 把 `source` 库里的记录搬进 `target` 库 —— 首次登录选「合并本机数据」时用。
 *
 * 为什么需要搬：数据按账号分库，登录后活动库变成了新的账号库（空的），
 * 游客库里的东西不会自己过去。若不搬，用户点「合并」会得到「已同步」但云端什么都没有。
 *
 * 设置行只在目标库还没有设置时导入（目标库已有设置说明它同步过云端，别被游客版覆盖）；
 * 图片资产没有同步通道（P2），但本机要能继续看图，所以一起搬。
 */
export async function importRecordsInto(
  target: AppDatabase,
  source: AppDatabase,
): Promise<number> {
  let count = 0

  const projects = await source.projects.toArray()
  if (projects.length > 0) {
    await target.projects.bulkPut(projects)
    count += projects.length
  }

  const projectSettings = await source.projectSettings.toArray()
  if (projectSettings.length > 0) {
    await target.projectSettings.bulkPut(projectSettings)
    count += projectSettings.length
  }

  for (const [sourceTable, targetTable] of [
    [source.nodes, target.nodes],
    [source.messages, target.messages],
    [source.notes, target.notes],
    [source.assets, target.assets],
  ] as const) {
    const rows = await sourceTable.toArray()
    if (rows.length > 0) {
      await (targetTable as { bulkPut(values: unknown[]): Promise<unknown> }).bulkPut(rows)
      count += rows.length
    }
  }

  // 复习会话是纯本机数据：一起搬过去，但**不进 outbox**（没有对应的云同步实体）。
  // 「每个项目至多一份未完成会话」这条不变量要在这里一并守住，见 mergeReviewSessions。
  const sessions = await source.reviewSessions.toArray()
  if (sessions.length > 0) {
    const migrated = await mergeReviewSessions(target, sessions)
    await target.reviewSessions.bulkPut(migrated)
    count += migrated.length
  }

  const sourceSettings = await source.settings.get(SETTINGS_KEY)
  if (sourceSettings && !(await target.settings.get(SETTINGS_KEY))) {
    await target.settings.put(sourceSettings)
    count += 1
  }

  return count
}

/**
 * 把源库的复习会话并入目标库，并守住「每个项目至多一份未完成会话」。
 *
 * 目标库里可能本来就有这个项目的未完成会话：这台设备上次登录过、退出到游客态又复习到
 * 一半，这次再登录合并 —— 两边都是 open。两份并行会各自往同一个节点写排期，`findOpen`
 * 也只能随机返回其中一份，另一份成了打不开的僵尸进度。
 *
 * 做法：按项目把「目标库已有的 + 这次要搬的」放在一起，按最后活动时间倒序，只留最新的
 * 一份 open，其余转 `ended`（内容全保留，历史仍可查看）。转 ended 的行版本 +1 ——
 * 仓储的 `save` 见状会拒绝内存里的旧副本覆盖，避免又被改回 active。
 *
 * @returns 源库里这些会话该写进目标库的样子（已转 ended 的已就地改好）
 */
async function mergeReviewSessions(
  target: AppDatabase,
  sessions: ReviewSessionRow[],
): Promise<ReviewSessionRow[]> {
  const openByProject = new Map<Id, ReviewSessionRow[]>()
  for (const row of sessions) {
    if (row.open !== 1) continue
    const bucket = openByProject.get(row.projectId)
    if (bucket) bucket.push(row)
    else openByProject.set(row.projectId, [row])
  }
  if (openByProject.size === 0) return sessions

  const now = Date.now()
  const close = (row: ReviewSessionRow): ReviewSessionRow => ({
    ...row,
    status: 'ended',
    finishedAt: row.finishedAt ?? now,
    open: 0,
    version: row.version + 1,
  })

  const closedFromSource = new Map<Id, ReviewSessionRow>()
  const closedInTarget: ReviewSessionRow[] = []

  for (const [projectId, incoming] of openByProject) {
    const existing = await target.reviewSessions
      .where('[projectId+open]')
      .equals([projectId, 1])
      .toArray()

    const candidates = [
      ...existing.map((row) => ({ row, incoming: false })),
      ...incoming.map((row) => ({ row, incoming: true })),
    ].sort((a, b) => b.row.updatedAt - a.row.updatedAt)

    for (const candidate of candidates.slice(1)) {
      if (candidate.incoming) closedFromSource.set(candidate.row.id, close(candidate.row))
      else closedInTarget.push(close(candidate.row))
    }
  }

  if (closedInTarget.length > 0) await target.reviewSessions.bulkPut(closedInTarget)
  return sessions.map((row) => closedFromSource.get(row.id) ?? row)
}

export function createSyncLocal(db: AppDatabase) {
  const adapters: Partial<Record<SyncEntity, EntityAdapter>> = {
    project: tableAdapter(db.projects),
    node: tableAdapter(db.nodes),
    message: tableAdapter(db.messages),
    note: tableAdapter(db.notes),
    projectSettings: {
      // 主键是 projectId 而不是 id，且历史数据可能没有 updatedAt
      load: async (projectId) => {
        const row = await db.projectSettings.get(projectId)
        if (!row) return null
        return {
          data: row as unknown as Record<string, unknown>,
          updatedAt: typeof row.updatedAt === 'number' ? row.updatedAt : 0,
        }
      },
      save: async (change) => {
        await db.projectSettings.put(change.data as ProjectSettings)
      },
      remove: (projectId) => db.projectSettings.delete(projectId),
      listIds: async () => (await db.projectSettings.toCollection().primaryKeys()) as Id[],
    },
    globalSettings: {
      load: async () => {
        const row = await db.settings.get(SETTINGS_KEY)
        if (!row) return null
        const settings = normalizeGlobalSettings(row.value)
        return { data: stripProviderKeys(settings as unknown as Record<string, unknown>), updatedAt: settings.updatedAt }
      },
      save: async (change) => {
        const remote = normalizeGlobalSettings(change.data)
        const local = normalizeGlobalSettings((await db.settings.get(SETTINGS_KEY))?.value)
        await db.settings.put({ key: SETTINGS_KEY, value: restoreProviderKeys(remote, local) })
      },
      // 全局设置没有「删除」：删掉等于回到默认值，远端 tombstone 直接忽略
      remove: async () => undefined,
      listIds: async () => [GLOBAL_SETTINGS_ID],
    },
    // asset 留空：图片走对象存储属于 P2，pull 到 asset 记录会被跳过
  }

  async function enqueue(
    entity: SyncEntity,
    localId: Id,
    op: OutboxRecord['op'],
    updatedAt: number,
  ): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      const existing = await db.outbox.where('[entity+localId]').equals([entity, localId]).toArray()

      if (op === 'delete') {
        // 删除是终点：把这条记录之前攒下的所有变更都并掉
        await db.outbox.bulkDelete(existing.map((entry) => entry.seq as number))
        await db.outbox.add({ entity, localId, op, updatedAt })
        return
      }

      const upserts = existing.filter((entry) => entry.op === 'upsert')
      const hasDelete = existing.some((entry) => entry.op === 'delete')
      if (upserts.length > 0 && !hasDelete) {
        // 同一记录反复改（拖拽、流式写消息）只留一条，时间取最新
        const [keep, ...redundant] = upserts
        if (redundant.length > 0) {
          await db.outbox.bulkDelete(redundant.map((entry) => entry.seq as number))
        }
        await db.outbox.update(keep.seq as number, { updatedAt })
        return
      }

      // 先删后改（重建同 id）要按顺序保留：push 也会按 seq 顺序提交
      await db.outbox.add({ entity, localId, op, updatedAt })
    })
  }

  return {
    /** 记一次本地变更。 */
    async recordChange(entity: SyncEntity, localId: Id, op: OutboxRecord['op']): Promise<void> {
      const now = Date.now()
      if (op === 'delete') {
        await enqueue(entity, localId, op, now)
        return
      }

      // 时间取「现在」与「本机已有版本 + 1」的较大者：别的设备时钟快时，
      // 它的版本会把本机记录的 updatedAt 顶到未来，直接用 now 会让本地改动永远判旧。
      const stored = await adapters[entity]?.load(localId)
      const stamp = Math.max(now, (stored?.updatedAt ?? 0) + 1)
      await enqueue(entity, localId, op, stamp)
    },

    /** 首次登录「上传本机数据」：按每条记录自身的时间戳记账，云端更新的记录仍然会赢。 */
    async recordAllLocal(): Promise<number> {
      let count = 0
      for (const [entity, adapter] of Object.entries(adapters) as [SyncEntity, EntityAdapter][]) {
        const ids = await adapter.listIds()
        for (const localId of ids) {
          const stored = await adapter.load(localId)
          if (!stored) continue
          await enqueue(entity, localId, 'upsert', stored.updatedAt)
          count += 1
        }
      }
      return count
    },

    readOutbox: (limit = 200): Promise<OutboxRecord[]> =>
      db.outbox.orderBy('seq').limit(limit).toArray(),

    clearOutbox: async (seqs: number[]): Promise<void> => {
      if (seqs.length > 0) await db.outbox.bulkDelete(seqs)
    },

    outboxCount: (): Promise<number> => db.outbox.count(),

    /** 读一条记录的同步载荷；记录已不存在（例如被级联删掉）时返回 null。 */
    loadPayload: async (entity: SyncEntity, localId: Id): Promise<LocalPayload | null> =>
      (await adapters[entity]?.load(localId)) ?? null,

    /**
     * 应用一条远端记录。**不记账**：把远端变更再推回去会形成回环。
     * `asset` 等没有适配器的实体直接跳过，避免把图片二进制当 JSON 处理。
     */
    async applyRemote(change: WireChange): Promise<ApplyOutcome> {
      const adapter = adapters[change.entity]
      if (!adapter) return 'skipped'

      if (change.deletedAt) {
        await adapter.remove(change.id)
        if (change.entity === 'project') await purgeProjectRows(db, change.id)
        return 'deleted'
      }

      if (!change.data || typeof change.data !== 'object' || Object.keys(change.data).length === 0) {
        // 空载荷只会是异常数据，写进去等于把本机的好记录抹成空壳
        return 'skipped'
      }

      await adapter.save(change)
      return 'written'
    },

    async readState(): Promise<SyncStateRecord> {
      return (
        (await db.syncState.get(SYNC_STATE_KEY)) ?? {
          key: SYNC_STATE_KEY,
          cursor: 0,
          lastSyncedAt: null,
          initialized: false,
        }
      )
    },

    async writeState(patch: Partial<Omit<SyncStateRecord, 'key'>>): Promise<void> {
      const current = await db.syncState.get(SYNC_STATE_KEY)
      await db.syncState.put({
        key: SYNC_STATE_KEY,
        cursor: patch.cursor ?? current?.cursor ?? 0,
        lastSyncedAt: patch.lastSyncedAt ?? current?.lastSyncedAt ?? null,
        initialized: patch.initialized ?? current?.initialized ?? false,
      })
    },

    /**
     * 「以云端为准」：清空本机实体与待推送队列，游标归零后整库重拉。
     * 刻意不动 `settings`：BYOK 密钥只存在本机，云端没有备份，
     * 清掉就再也回不来了 —— 拉到的设置会按 provider id 把密钥补回去。
     */
    async clearLocalData(): Promise<void> {
      await db.transaction(
        'rw',
        [
          db.projects,
          db.projectSettings,
          db.nodes,
          db.messages,
          db.assets,
          db.notes,
          db.outbox,
          db.reviewSessions,
        ],
        async () => {
          await Promise.all([
            db.projects.clear(),
            db.projectSettings.clear(),
            db.nodes.clear(),
            db.messages.clear(),
            db.assets.clear(),
            db.notes.clear(),
            db.outbox.clear(),
            // 「以云端为准」= 本机被清空重拉；会话不参与同步，留下就成了孤儿
            db.reviewSessions.clear(),
          ])
        },
      )
      await db.syncState.put({
        key: SYNC_STATE_KEY,
        cursor: 0,
        lastSyncedAt: null,
        initialized: true,
      })
    },
  }
}

export type SyncLocal = ReturnType<typeof createSyncLocal>