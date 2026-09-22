import 'fake-indexeddb/auto'
import { beforeEach, describe, expect, it } from 'vitest'
import { AppDatabase } from './db'
import { createReviewSessionRepository } from './review-sessions'
import { createReviewSession, patchItem } from '@/domain/review/session'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'

const NOW = 1700000000000

describe('ReviewSessionRepository & atomic grading', () => {
  let db: AppDatabase
  let repo: ReturnType<typeof createReviewSessionRepository>

  beforeEach(async () => {
    db = new AppDatabase(`test-${Date.now()}-${Math.random()}`)
    repo = createReviewSessionRepository(db)
  })

  it('saves and loads a review session with open status index', async () => {
    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '测试一', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })

    await repo.save(session)

    const loaded = await repo.get(session.id)
    expect(loaded?.id).toBe(session.id)
    expect(loaded?.items[0].title).toBe('测试一')

    const open = await repo.findOpen('p1')
    expect(open?.id).toBe(session.id)
  })

  it('guarantees only one open session per project at storage layer', async () => {
    const first = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '会话1', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    const second = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n2', title: '会话2', mode: 'review' }],
      origin: 'overview',
      now: NOW + 1000,
    })

    const savedFirst = await repo.save(first)
    expect(savedFirst.id).toBe(first.id)

    // 第二份未完成会话写入被拒绝并返回既有会话
    const attemptedSecond = await repo.save(second)
    expect(attemptedSecond.id).toBe(first.id)

    const all = await repo.listByProject('p1')
    expect(all).toHaveLength(1)
  })

  it('performs atomic grading: updates node, records outbox, records session result idempotently', async () => {
    const node: Node = {
      ...makeNode({ id: 'n1', projectId: 'p1' }),
      mastery: { score: 60, updatedAt: NOW - 5000 },
      reviewEnrollment: 'enabled',
    }
    await db.nodes.put(node)

    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '主题1', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    patchItem(session, session.items[0].itemId, { phase: 'feedback', answer: '我的回答' }, NOW)
    await repo.save(session)

    const outcome = await repo.grade({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      operationId: 'op-101',
      projectId: 'p1',
      nodeId: 'n1',
      grade: 'good',
      expectedVersion: session.version,
      now: NOW + 1000,
    })

    expect(outcome.status).toBe('applied')
    if (outcome.status === 'applied') {
      expect(outcome.node.mastery?.score).toBe(65)
      expect(outcome.session.items[0].phase).toBe('done')
      expect(outcome.result.operationId).toBe('op-101')
    }

    // 检查节点库中已更新
    const storedNode = await db.nodes.get('n1')
    expect(storedNode?.mastery?.score).toBe(65)

    // 检查 outbox 已记账
    const outbox = await db.outbox.toArray()
    expect(outbox.some((entry) => entry.entity === 'node' && entry.localId === 'n1')).toBe(true)

    // 幂等重试同一操作 ID
    const retry = await repo.grade({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      operationId: 'op-101',
      projectId: 'p1',
      nodeId: 'n1',
      grade: 'good',
      expectedVersion: session.version,
      now: NOW + 2000,
    })
    expect(retry.status).toBe('duplicate')
  })

  it('undoes grading atomically and restores exact node baseline', async () => {
    const node: Node = {
      ...makeNode({ id: 'n1', projectId: 'p1' }),
      mastery: { score: 60, updatedAt: NOW - 5000 },
      reviewEnrollment: 'enabled',
    }
    await db.nodes.put(node)

    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '主题1', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    patchItem(session, session.items[0].itemId, { phase: 'feedback', answer: '我的回答' }, NOW)
    await repo.save(session)

    await repo.grade({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      operationId: 'op-102',
      projectId: 'p1',
      nodeId: 'n1',
      grade: 'good',
      expectedVersion: session.version,
      now: NOW + 1000,
    })

    const undoOutcome = await repo.undo({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      projectId: 'p1',
      nodeId: 'n1',
      now: NOW + 2000,
    })

    expect(undoOutcome.status).toBe('applied')
    if (undoOutcome.status === 'applied') {
      expect(undoOutcome.node.mastery?.score).toBe(60)
      expect(undoOutcome.session.items[0].phase).toBe('feedback')
      expect(undoOutcome.session.items[0].result).toBeUndefined()
    }

    const restoredNode = await db.nodes.get('n1')
    expect(restoredNode?.mastery?.score).toBe(60)
  })
})