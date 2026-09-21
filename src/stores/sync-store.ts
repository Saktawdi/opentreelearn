import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { GUEST_DATABASE_NAME, getDatabase, getSyncLocal, openDatabase } from '@/data'
import { importRecordsInto } from '@/data/sync-local'
import type { FirstLoginPolicy, RemoteSyncStatus } from '@/domain/sync'
import type { OutboxRecord } from '@/data/dexie/db'
import { errorMessage } from '@/lib/utils'
import { ApiError } from '@/services/api/envelope'
import {
  PUSH_BATCH_SIZE,
  fetchRemoteStatus,
  pullChanges,
  pushChanges,
  type OutgoingChange,
} from '@/services/sync/client'
import { useAccountStore } from './account-store'
import { reloadStores } from './data-session'

/** 单次同步最多拉多少页（防御：服务端游标异常时别无限循环）。 */
const MAX_PULL_PAGES = 50
/** 单次同步最多推多少批。 */
const MAX_PUSH_BATCHES = 20

export interface SyncOutcome {
  ok: boolean
  pushed: number
  pulled: number
  error?: string
}

interface SyncState {
  phase: 'idle' | 'syncing' | 'error'
  error: string | null
  lastSyncedAt: number | null
  /** 待推送的本地变更条数 */
  pending: number
  /** 云端概况（首次登录弹窗里用来说明「云端已有多少数据」） */
  remote: RemoteSyncStatus | null
  /** 本机还没决定「已有的本地数据怎么办」 */
  needsPolicy: boolean
  initialize: () => Promise<void>
  refreshPending: () => Promise<void>
  syncNow: () => Promise<SyncOutcome>
  applyFirstLoginPolicy: (policy: FirstLoginPolicy) => Promise<SyncOutcome>
  reset: () => void
}

/**
 * 取一个能用的 token 执行请求：401 时先刷新会话再重试一次。
 *
 * token 的有效期由账号系统说了算，同步是后台动作 —— 用户不该因为 token
 * 刚好过期就看见一次失败，能自己续上就续上。
 */
async function withToken<T>(run: (token: string) => Promise<T>): Promise<T> {
  const token = useAccountStore.getState().token
  if (!token) throw new ApiError('未登录，无法同步', 401)

  try {
    return await run(token)
  } catch (error) {
    if (error instanceof ApiError && error.code === 401) {
      const refreshed = await useAccountStore.getState().refreshSession()
      if (refreshed) return await run(refreshed)
    }
    throw error
  }
}

/** 推送 outbox：逐条读当前记录内容，服务端判旧时用它的版本覆盖本地。 */
async function pushOutbox(): Promise<number> {
  const local = getSyncLocal()
  let pushed = 0

  for (let batch = 0; batch < MAX_PUSH_BATCHES; batch += 1) {
    const entries = await local.readOutbox(PUSH_BATCH_SIZE)
    if (entries.length === 0) break

    const plans: { entry: OutboxRecord; change: OutgoingChange }[] = []
    const stale: number[] = []

    for (const entry of entries) {
      if (entry.op === 'delete') {
        plans.push({
          entry,
          change: {
            entity: entry.entity,
            id: entry.localId,
            updatedAt: entry.updatedAt,
            deletedAt: entry.updatedAt,
          },
        })
        continue
      }

      const payload = await local.loadPayload(entry.entity, entry.localId)
      if (!payload) {
        // 记录已经不在了（项目被级联删除等）：这条变更没有意义，直接销账
        stale.push(entry.seq as number)
        continue
      }
      plans.push({
        entry,
        change: {
          entity: entry.entity,
          id: entry.localId,
          updatedAt: entry.updatedAt,
          data: payload.data,
        },
      })
    }

    if (stale.length > 0) await local.clearOutbox(stale)
    if (plans.length === 0) continue

    const result = await withToken((token) =>
      pushChanges(
        token,
        plans.map((plan) => plan.change),
      ),
    )

    const settled: number[] = []
    // 服务端按请求顺序逐条回执，所以下标一一对应
    for (const [index, applied] of result.applied.entries()) {
      const plan = plans[index]
      if (!plan) continue
      settled.push(plan.entry.seq as number)
      if (applied.status === 'stale' && applied.record) {
        // 服务端版本更新：用它覆盖本地，否则下一次 push 还会被同样判旧
        await local.applyRemote(applied.record)
      }
    }
    await local.clearOutbox(settled)
    pushed += settled.length

    if (entries.length < PUSH_BATCH_SIZE) break
  }

  return pushed
}

/** 拉取远端增量并写入本地（不记账，避免把远端变更再推回去）。 */
async function pullRemote(): Promise<number> {
  const local = getSyncLocal()
  let cursor = (await local.readState()).cursor
  let applied = 0

  for (let page = 0; page < MAX_PULL_PAGES; page += 1) {
    const result = await withToken((token) => pullChanges(token, cursor))
    for (const change of result.changes) {
      const outcome = await local.applyRemote(change)
      if (outcome !== 'skipped') applied += 1
    }
    cursor = result.cursor
    await local.writeState({ cursor })
    if (!result.hasMore) break
  }

  return applied
}

export const useSyncStore = create<SyncState>()(
  immer((set, get) => ({
    phase: 'idle',
    error: null,
    lastSyncedAt: null,
    pending: 0,
    remote: null,
    needsPolicy: false,

    refreshPending: async () => {
      const pending = await getSyncLocal().outboxCount()
      set((draft) => {
        draft.pending = pending
      })
    },

    /**
     * 进入「我的」页时调用：
     * 未决策过就弹首次登录选择；决策过就顺手同步一次（静默，失败只记在状态里）。
     */
    initialize: async () => {
      const account = useAccountStore.getState()
      if (account.status !== 'authenticated' || !account.token) return

      const local = getSyncLocal()
      await get().refreshPending()
      const state = await local.readState()

      set((draft) => {
        draft.lastSyncedAt = state.lastSyncedAt
      })

      if (!state.initialized) {
        const remote = await withToken(fetchRemoteStatus).catch(() => null)
        set((draft) => {
          draft.needsPolicy = true
          draft.remote = remote
        })
        return
      }

      await get().syncNow()
    },

    syncNow: async () => {
      if (get().phase === 'syncing') return { ok: false, pushed: 0, pulled: 0, error: '正在同步' }

      set((draft) => {
        draft.phase = 'syncing'
        draft.error = null
      })

      try {
        const pushed = await pushOutbox()
        const pulled = await pullRemote()
        const local = getSyncLocal()
        await local.writeState({ lastSyncedAt: Date.now() })
        const state = await local.readState()
        const pending = await local.outboxCount()

        set((draft) => {
          draft.phase = 'idle'
          draft.lastSyncedAt = state.lastSyncedAt
          draft.pending = pending
        })

        if (pushed > 0 || pulled > 0) await reloadStores()
        return { ok: true, pushed, pulled }
      } catch (error) {
        const message = errorMessage(error)
        set((draft) => {
          draft.phase = 'error'
          draft.error = message
        })
        await get().refreshPending()
        return { ok: false, pushed: 0, pulled: 0, error: message }
      }
    },

    applyFirstLoginPolicy: async (policy) => {
      const local = getSyncLocal()
      // 先落决策再同步：中途失败不该反复弹同一个问题，未推完的变更还在 outbox 里
      await local.writeState({ initialized: true })
      set((draft) => {
        draft.needsPolicy = false
      })

      if (policy === 'localOnly') {
        await get().refreshPending()
        return { ok: true, pushed: 0, pulled: 0 }
      }

      if (policy === 'cloud') {
        await local.clearLocalData()
        await reloadStores()
      } else {
        // 合并：先登录后活动库已经是账号库，游客库里的记录要搬进来才算「本机数据」
        const current = getDatabase()
        if (current.name !== GUEST_DATABASE_NAME) {
          const guest = openDatabase(GUEST_DATABASE_NAME)
          try {
            const imported = await importRecordsInto(current, guest)
            if (imported > 0) await reloadStores()
          } finally {
            guest.close()
          }
        }
        await local.recordAllLocal()
        await get().refreshPending()
      }

      return get().syncNow()
    },

    reset: () => {
      set((draft) => {
        draft.phase = 'idle'
        draft.error = null
        draft.lastSyncedAt = null
        draft.pending = 0
        draft.remote = null
        draft.needsPolicy = false
      })
    },
  })),
)