import { describe, expect, it } from 'vitest'
import type { ReviewCard } from '@/domain/models'
import {
  advanceAfter,
  canConfirm,
  createReviewSession,
  currentItem,
  isExhausted,
  isReadableSession,
  patchItem,
  pauseSession,
  resumeSession,
  sessionProgress,
  sessionSummary,
  undoableItem,
  undoConfirm,
} from './session'

const NOW = 1700000000000

function fakeCard(due: number): ReviewCard {
  return {
    due,
    stability: 5,
    difficulty: 5,
    scheduledDays: 1,
    learningSteps: 0,
    reps: 1,
    lapses: 0,
    state: 'review',
  }
}

describe('review session state machine', () => {
  it('creates an active session with preparing items', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [
        { nodeId: 'n1', title: '主题一', mode: 'review' },
        { nodeId: 'n2', title: '主题二', mode: 'relearn' },
      ],
      origin: 'overview',
      now: NOW,
    })

    expect(session.status).toBe('active')
    expect(session.cursor).toBe(0)
    expect(session.items).toHaveLength(2)
    expect(session.items[0].phase).toBe('preparing')
    expect(session.items[1].mode).toBe('relearn')
    expect(isReadableSession(session)).toBe(true)
  })

  it('tracks progress accurately across phases', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [
        { nodeId: 'n1', title: '一', mode: 'review' },
        { nodeId: 'n2', title: '二', mode: 'review' },
        { nodeId: 'n3', title: '三', mode: 'review' },
      ],
      origin: 'overview',
      now: NOW,
    })

    expect(sessionProgress(session)).toEqual({
      total: 3,
      done: 0,
      skipped: 0,
      unavailable: 0,
      remaining: 3,
      processed: 0,
    })

    patchItem(session, session.items[0].itemId, { phase: 'done' }, NOW)
    advanceAfter(session, session.items[0].itemId, NOW)

    expect(sessionProgress(session).done).toBe(1)
    expect(session.cursor).toBe(1)

    patchItem(session, session.items[1].itemId, { phase: 'skipped' }, NOW)
    advanceAfter(session, session.items[1].itemId, NOW)

    expect(sessionProgress(session).skipped).toBe(1)
    expect(session.cursor).toBe(2)

    patchItem(session, session.items[2].itemId, { phase: 'done' }, NOW)
    advanceAfter(session, session.items[2].itemId, NOW)

    expect(session.status).toBe('completed')
    expect(isExhausted(session)).toBe(true)
  })

  it('enforces canConfirm only when answering has completed and feedback is reached', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '一', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    const item = currentItem(session)!
    expect(canConfirm(item)).toBe(false)

    patchItem(session, item.itemId, { phase: 'feedback', answer: '我的回忆答案' }, NOW)
    expect(canConfirm(item)).toBe(true)

    // 空答案不可确认
    patchItem(session, item.itemId, { answer: '   ' }, NOW)
    expect(canConfirm(item)).toBe(false)
  })

  it('supports pause and resume, resetting in-flight interrupted requests', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '一', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    const item = currentItem(session)!
    patchItem(session, item.itemId, { phase: 'preparing', pendingRequestId: 'req1' }, NOW)

    pauseSession(session, NOW)
    expect(session.status).toBe('paused')

    resumeSession(session, NOW + 1000)
    expect(session.status).toBe('active')
    expect(item.error).toBe('上次生成已中断')
    expect(item.pendingRequestId).toBeUndefined()
  })

  it('supports undoing the last confirmed item within the window', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [
        { nodeId: 'n1', title: '一', mode: 'review' },
        { nodeId: 'n2', title: '二', mode: 'review' },
      ],
      origin: 'overview',
      now: NOW,
    })

    // 第一项确认评分
    const item1 = session.items[0]
    patchItem(
      session,
      item1.itemId,
      {
        phase: 'done',
        result: {
          operationId: 'op1',
          confirmedAt: NOW,
          grade: 'good',
          baseCard: null,
          baseUpdatedAt: NOW - 1000,
          masteryAfter: { score: 65, updatedAt: NOW },
          cardAfter: { card: fakeCard(NOW + 86400000), lastGrade: 'good' },
        },
      },
      NOW,
    )
    advanceAfter(session, item1.itemId, NOW)

    // 第二项尚未作答，撤销窗口有效
    expect(undoableItem(session)?.itemId).toBe(item1.itemId)

    undoConfirm(session, item1.itemId, NOW + 2000)
    expect(item1.result).toBeUndefined()
    expect(item1.phase).toBe('feedback')
    expect(session.cursor).toBe(0)

    // 若第二项已经产生回答，则窗口关闭
    const item2 = session.items[1]
    patchItem(
      session,
      item1.itemId,
      {
        phase: 'done',
        result: {
          operationId: 'op1-again',
          confirmedAt: NOW + 3000,
          grade: 'good',
          baseCard: null,
          baseUpdatedAt: NOW - 1000,
          masteryAfter: { score: 65, updatedAt: NOW + 3000 },
          cardAfter: { card: fakeCard(NOW + 86400000), lastGrade: 'good' },
        },
      },
      NOW + 3000,
    )
    advanceAfter(session, item1.itemId, NOW + 3000)
    patchItem(session, item2.itemId, { answer: '已作答' }, NOW + 4000)

    expect(undoableItem(session)).toBeNull()
  })

  it('produces accurate session summary', () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [
        { nodeId: 'n1', title: '通过项', mode: 'review' },
        { nodeId: 'n2', title: '跳过项', mode: 'review' },
      ],
      origin: 'overview',
      now: NOW,
    })

    patchItem(
      session,
      session.items[0].itemId,
      {
        phase: 'done',
        result: {
          operationId: 'op1',
          confirmedAt: NOW,
          grade: 'good',
          baseCard: null,
          baseUpdatedAt: NOW - 1000,
          masteryAfter: { score: 75, updatedAt: NOW },
          cardAfter: { card: fakeCard(NOW + 86400000), lastGrade: 'good' },
        },
      },
      NOW,
    )
    patchItem(session, session.items[1].itemId, { phase: 'skipped', skipReason: '跳过' }, NOW)

    const summary = sessionSummary(session)
    expect(summary.done).toBe(1)
    expect(summary.skipped).toBe(1)
    expect(summary.rows).toHaveLength(2)
    expect(summary.rows[0].grade).toBe('good')
  })
})