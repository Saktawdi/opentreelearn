import type { Id, Node } from '@/domain/models'
import { normalizeNode } from '@/domain/normalize'
import { enrollmentOf } from '@/domain/review/enrollment'
import { gradeNode, undoGrade } from '@/domain/review/grade'
import {
  advanceAfter,
  isReadableSession,
  patchItem,
  undoConfirm,
  type ReviewSessionRecord,
} from '@/domain/review/session'
import type {
  GradeReviewOutcome,
  ReviewRefusal,
  ReviewSessionRepository,
  UndoReviewOutcome,
} from '@/data/repository'
import { createSyncLocal } from '../sync-local'
import type { AppDatabase, ReviewSessionRow } from './db'

/**
 * 复习会话的持久化与原子评分。
 *
 * 三件事在这里收口：
 * 1. **事务一致**：节点（掌握度 + 排期）、同步台账（outbox）、会话记录在同一个
 *    Dexie 事务里。任一步失败整体回滚 —— 旧实现里节点写成功、会话只在内存，
 *    刷新一次就丢，用户看到的是「评了但没记住」；
 * 2. **幂等**：确认记录带操作 ID，重试同一操作直接返回既有结果；同一项被两个
 *    标签页同时确认也只生效一次；
 * 3. **每项目一份未完成会话**：约束落在 `[projectId+open]` 索引 + 事务内查询上，
 *    而不是按钮禁用（那挡不住多标签页）。
 */

const OPEN_STATUSES = new Set(['active', 'paused'])

function isOpen(session: ReviewSessionRecord): boolean {
  return OPEN_STATUSES.has(session.status)
}

function toRow(session: ReviewSessionRecord): ReviewSessionRow {
  return { ...session, open: isOpen(session) ? 1 : 0 }
}

/** 行 → 领域记录：去掉索引字段，并保证形状完整（老行 / 手改行都不能炸）。 */
function toRecord(row: ReviewSessionRow): ReviewSessionRecord | null {
  if (!isReadableSession(row)) return null
  const { open: _open, ...record } = row
  return record as ReviewSessionRecord
}

export function createReviewSessionRepository(db: AppDatabase): ReviewSessionRepository {
  const sync = createSyncLocal(db)

  async function readOpen(projectId: Id, exceptId?: Id): Promise<ReviewSessionRecord | null> {
    const rows = await db.reviewSessions
      .where('[projectId+open]')
      .equals([projectId, 1])
      .toArray()
    for (const row of rows) {
      if (exceptId && row.id === exceptId) continue
      const record = toRecord(row)
      if (record) return record
    }
    return null
  }

  async function readNode(id: Id): Promise<Node | null> {
    const raw = await db.nodes.get(id)
    return raw ? normalizeNode(raw) : null
  }

  /**
   * 当前项不可用（节点已删除 / 归档 / 移出计划）：不评分，推进到下一项。
   *
   * `skipReason` 是中文且**必须**是中文 —— 它经 `reviewHistoryForNode` 进入
   * `get_review_history` 工具的输出，是给模型读的上下文，按 i18n 迁移的边界不迁。
   * 给用户看的那一份由 `reason`（枚举）交给界面按当前语言取译，两者各司其职。
   */
  async function markUnavailable(
    session: ReviewSessionRecord,
    itemId: Id,
    reason: ReviewRefusal,
    skipReason: string,
    now: number,
  ): Promise<GradeReviewOutcome> {
    patchItem(
      session,
      itemId,
      {
        phase: 'unavailable',
        skipReason,
        pendingRequestId: undefined,
        pendingPurpose: undefined,
        pendingOperationId: undefined,
      },
      now,
    )
    advanceAfter(session, itemId, now)
    await db.reviewSessions.put(toRow(session))
    return { status: 'unavailable', reason, session }
  }

  return {
    get: async (id) => {
      const row = await db.reviewSessions.get(id)
      return row ? (toRecord(row) ?? undefined) : undefined
    },

    findOpen: async (projectId) => (await readOpen(projectId)) ?? undefined,

    listByProject: async (projectId) => {
      const rows = await db.reviewSessions.where('projectId').equals(projectId).toArray()
      return rows
        .map(toRecord)
        .filter((record): record is ReviewSessionRecord => record !== null)
        .sort((a, b) => b.updatedAt - a.updatedAt)
    },

    save: async (session) => {
      return db.transaction('rw', db.reviewSessions, async () => {
        // 同一项目已有另一份未完成会话时不写入：宁可返回既有会话让用户先处理它，
        // 也不能悄悄留下两份并行进度（各自的评分会各写一遍排期）
        if (isOpen(session)) {
          const open = await readOpen(session.projectId, session.id)
          if (open) return open
        }
        const stored = await db.reviewSessions.get(session.id)
        const record = stored ? toRecord(stored) : null
        // 库里已有更新的版本（另一个标签页刚写过）：不用旧内容覆盖
        if (record && record.version > session.version) return record
        await db.reviewSessions.put(toRow(session))
        return session
      })
    },

    remove: async (id) => {
      await db.reviewSessions.delete(id)
    },

    removeByProject: async (projectId) => {
      await db.reviewSessions.where('projectId').equals(projectId).delete()
    },

    grade: async (input) => {
      return db.transaction(
        'rw',
        [db.nodes, db.outbox, db.reviewSessions],
        async (): Promise<GradeReviewOutcome> => {
          const row = await db.reviewSessions.get(input.sessionId)
          const session = row ? toRecord(row) : null
          if (!session) {
            return { status: 'missing', reason: 'sessionMissing' }
          }
          const item = session.items.find((entry) => entry.itemId === input.itemId)
          if (!item) {
            return { status: 'conflict', reason: 'itemMissing', session }
          }

          // 已经评过：同一操作 ID（重试）或同一档位（另一个标签页）都算同一次
          if (item.result) {
            if (
              item.result.operationId === input.operationId ||
              item.result.grade === input.grade
            ) {
              const node = await readNode(input.nodeId)
              if (node) return { status: 'duplicate', node, session, result: item.result }
            }
            return { status: 'conflict', reason: 'alreadyGraded', session }
          }

          if (session.status !== 'active') {
            return { status: 'conflict', reason: 'sessionEnded', session }
          }
          const isSavingRetry =
            item.phase === 'saving' && item.pendingOperationId === input.operationId
          if (item.phase !== 'feedback' && !isSavingRetry) {
            return { status: 'conflict', reason: 'phaseChanged', session }
          }
          const allowedVersion = input.expectedVersion + (isSavingRetry ? 1 : 0)
          if (session.version > allowedVersion) {
            return { status: 'conflict', reason: 'versionStale', session }
          }

          const node = await readNode(input.nodeId)
          if (!node || node.status !== 'active' || node.projectId !== input.projectId) {
            return markUnavailable(session, input.itemId, 'nodeUnavailable', '这个主题已不可用', input.now)
          }
          if (enrollmentOf(node) !== 'enabled') {
            return markUnavailable(session, input.itemId, 'unenrolled', '这个主题已移出复习计划', input.now)
          }

          const write = gradeNode(node, input.grade, input.operationId, input.now)
          await db.nodes.update(node.id, write.patch)
          await sync.recordChange('node', node.id, 'upsert')

          patchItem(
            session,
            input.itemId,
            {
              result: write.result,
              phase: 'done',
              selectedGrade: undefined,
              pendingRequestId: undefined,
              pendingPurpose: undefined,
              pendingOperationId: undefined,
              error: undefined,
            },
            input.now,
          )
          advanceAfter(session, input.itemId, input.now)
          await db.reviewSessions.put(toRow(session))

          const after = normalizeNode({ ...node, ...write.patch }) ?? node
          return { status: 'applied', node: after, session, result: write.result }
        },
      )
    },

    undo: async (input) => {
      return db.transaction(
        'rw',
        [db.nodes, db.outbox, db.reviewSessions],
        async (): Promise<UndoReviewOutcome> => {
          const row = await db.reviewSessions.get(input.sessionId)
          const session = row ? toRecord(row) : null
          if (!session) return { status: 'missing', reason: 'sessionMissing' }

          const item = session.items.find((entry) => entry.itemId === input.itemId)
          if (!item?.result) {
            return { status: 'missing', reason: 'nothingToUndo', session }
          }

          const node = await readNode(input.nodeId)
          if (!node) {
            return { status: 'conflict', reason: 'nodeDeleted', session }
          }

          const write = undoGrade(node, item.result, input.now)
          if (!write) {
            // 掌握度 / 排期已经不是这次评分写下的值：外部（同步、另一个标签页、
            // 本地学习）改过它，用旧快照覆盖会把新记录抹掉
            return { status: 'conflict', reason: 'recordChanged', session }
          }

          await db.nodes.update(node.id, write.patch)
          await sync.recordChange('node', node.id, 'upsert')
          undoConfirm(session, input.itemId, input.now)
          await db.reviewSessions.put(toRow(session))

          const after = normalizeNode({ ...node, ...write.patch }) ?? node
          return { status: 'applied', node: after, session }
        },
      )
    },
  }
}