import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import i18n from '@/i18n'
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
import { useReviewSessionStore } from './review-session-store'

/** 单次同步最多拉多少页（防御：服务端游标异常时别无限循环）。 */
const MAX_PULL_PAGES = 50
/** 单次同步最多推多少批。 */
const MAX_PUSH_BATCHES = 20

/**
 * 两次**自动**同步之间的最小间隔。
 *
 * 聚焦、切回标签页、待推巡检都可能连续触发同一件事：把它们各自当成一次同步，
 * 用户点几下窗口就会打出一串请求。手动「立即同步」不受这个间隔限制。
 */
export const AUTO_SYNC_MIN_INTERVAL_MS = 120_000

/** 自动同步的触发原因，只影响要不要先看本机待推变更。 */
export type AutoSyncReason =
  /** 窗口重新聚焦 / 切回标签页：主要为拉云端变更 */
  | 'focus'
  /** 巡检本机待推变更：有东西才推，替代「每次写入都发请求」 */
  | 'pending'

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
  /** 最近一次**尝试**同步的时间（含失败）：自动同步用它做节流，避免失败后疯狂重试 */
  lastAttemptAt: number
  /** 待推送的本地变更条数 */
  pending: number
  /** 云端概况（首次登录弹窗里用来说明「云端已有多少数据」） */
  remote: RemoteSyncStatus | null
  /** 本机还没决定「已有的本地数据怎么办」 */
  needsPolicy: boolean
  initialize: () => Promise<void>
  refreshPending: () => Promise<void>
  syncNow: () => Promise<SyncOutcome>
  /** 自动同步（启动后、窗口聚焦、待推巡检）；节流不通过时返回 null，表示这次跳过 */
  autoSync: (reason: AutoSyncReason) => Promise<SyncOutcome | null>
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
  if (!token) throw new ApiError(i18n.t('common:sync.notLoggedIn'), 401)

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

/**
 * 推送 outbox：逐条读当前记录内容，服务端判旧时用它的版本覆盖本地。
 *
 * 返回两个数：`pushed` 是向上补账成功的条数；`remoteOverwrites` 是推送被判旧、
 * 远端版本覆盖了本机的条数 —— 后者本质是「远端内容落到了本库」，调用方要和
 * pull 增量一样对待（见 `syncNow` 的重载条件）。
 */
async function pushOutbox(): Promise<{ pushed: number; remoteOverwrites: number }> {
  const local = getSyncLocal()
  let pushed = 0
  let remoteOverwrites = 0

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
        // 服务端版本更新：用它覆盖本地，否则下一次 push 还会被同样判旧。
        // `applyRemote` 自己会跳过两种「不必落地」的情形：内容与本机一致（回声），
        // 以及本机还压着更大记账时间戳的未推送更新（那份更新上行后会赢）。
        const outcome = await local.applyRemote(applied.record)
        if (outcome !== 'skipped') remoteOverwrites += 1
      }
    }
    await local.clearOutbox(settled)
    pushed += settled.length

    if (entries.length < PUSH_BATCH_SIZE) break
  }

  return { pushed, remoteOverwrites }
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
    lastAttemptAt: 0,
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
      if (get().phase === 'syncing') {
        return { ok: false, pushed: 0, pulled: 0, error: i18n.t('common:sync.alreadySyncing') }
      }

      set((draft) => {
        draft.phase = 'syncing'
        draft.error = null
        // 记「尝试」而不是「成功」：失败也要进节流窗口，否则聚焦一次就重试一次
        draft.lastAttemptAt = Date.now()
      })

      try {
        const { pushed, remoteOverwrites } = await pushOutbox()
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

        // 重载只看「远端是否把内容写进了本库」：拉到增量，或推送被判旧时服务端版本
        // 覆盖了本机。纯推送是把本机已发生的事实向上补账 —— 库和内存本来就一致，
        // 这时重载只会让空闲中的页面整页闪一次骨架屏（用户看到的就是"突然刷新"），
        // 必须静默完成。
        if (pulled > 0 || remoteOverwrites > 0) await reloadStores()
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

    /**
     * 自动同步：登录后不必再进「我的」页才同步。
     *
     * 四道闸门，任一不满足就安静跳过（返回 null，不报错也不打扰用户）：
     * 1. 没有凭据 —— 未登录（或 token 已被 401 清掉）时无从同步；
     * 2. 正在同步 / 还没决定首次登录策略 —— 前者防重入，后者等用户选完再动数据；
     * 3. 库里还没落过决策（`initialized` 为 false）—— 同上，别偷偷替用户选；
     * 4. 距上次尝试不足 `AUTO_SYNC_MIN_INTERVAL_MS` —— 聚焦与巡检会连续触发；
     *    `pending` 这一路还要先看到本机确实有待推变更，否则连请求都不发。
     */
    autoSync: async (reason) => {
      if (!useAccountStore.getState().token) return null

      const state = get()
      if (state.phase === 'syncing' || state.needsPolicy) return null

      const local = getSyncLocal()
      const stored = await local.readState()
      if (!stored.initialized) return null

      if (reason === 'pending' && (await local.outboxCount()) === 0) return null

      const since = Math.max(stored.lastSyncedAt ?? 0, state.lastAttemptAt)
      if (Date.now() - since < AUTO_SYNC_MIN_INTERVAL_MS) return null

      return get().syncNow()
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
        // 库里连会话一起清空了，内存里那份（属于刚被清掉的库）也必须丢弃，
        // 否则下一次草稿保存会把它写回去，留下一份引用不到节点的幽灵会话
        useReviewSessionStore.getState().reset()
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
        draft.lastAttemptAt = 0
        draft.pending = 0
        draft.remote = null
        draft.needsPolicy = false
      })
    },
  })),
)