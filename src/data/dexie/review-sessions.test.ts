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

  // 拒绝路径此前零覆盖：这些分支以前直接返回中文字面量 message，
  // 现在返回枚举 reason（数据口径），界面按语言取译。断言枚举，不断言译文。
  it('refuses grading with a typed reason instead of a display string', async () => {
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
    patchItem(session, session.items[0].itemId, { phase: 'feedback' }, NOW)
    await repo.save(session)

    const base = {
      sessionId: session.id,
      itemId: session.items[0].itemId,
      operationId: 'op-1',
      projectId: 'p1',
      nodeId: 'n1',
      grade: 'good' as const,
      now: NOW + 1000,
    }

    // 会话不存在
    const gone = await repo.grade({ ...base, sessionId: 'nope', expectedVersion: 0 })
    expect(gone.status).toBe('missing')
    if (gone.status === 'missing') expect(gone.reason).toBe('sessionMissing')

    // 这一项不在会话里
    const noItem = await repo.grade({ ...base, itemId: 'nope', expectedVersion: session.version })
    expect(noItem.status).toBe('conflict')
    if (noItem.status === 'conflict') expect(noItem.reason).toBe('itemMissing')

    // 版本过期：调用方拿着比库里旧的版本
    const stale = await repo.grade({ ...base, expectedVersion: 0 })
    expect(stale.status).toBe('conflict')
    if (stale.status === 'conflict') expect(stale.reason).toBe('versionStale')

    // 阶段对不上：另起一份会话（换项目 —— 一个项目只允许一份未完成会话），
    // 项还没进到 feedback 阶段就确认评分
    const fresh = createReviewSession({
      projectId: 'p2',
      items: [{ nodeId: 'n1', title: '主题2', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    await repo.save(fresh)
    const wrongPhase = await repo.grade({
      ...base,
      sessionId: fresh.id,
      itemId: fresh.items[0].itemId,
      operationId: 'op-2',
      projectId: 'p2',
      expectedVersion: fresh.version,
    })
    expect(wrongPhase.status).toBe('conflict')
    if (wrongPhase.status === 'conflict') expect(wrongPhase.reason).toBe('phaseChanged')
  })

  it('marks an unenrolled node unavailable and keeps skipReason for the model', async () => {
    const node: Node = {
      ...makeNode({ id: 'n1', projectId: 'p1' }),
      mastery: { score: 60, updatedAt: NOW - 5000 },
      reviewEnrollment: 'disabled',
    }
    await db.nodes.put(node)

    const session = createReviewSession({
      projectId: 'p1',
      items: [{ nodeId: 'n1', title: '主题1', mode: 'review' }],
      origin: 'overview',
      now: NOW,
    })
    patchItem(session, session.items[0].itemId, { phase: 'feedback' }, NOW)
    await repo.save(session)

    const outcome = await repo.grade({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      operationId: 'op-1',
      projectId: 'p1',
      nodeId: 'n1',
      grade: 'good',
      expectedVersion: session.version,
      now: NOW + 1000,
    })

    expect(outcome.status).toBe('unavailable')
    if (outcome.status === 'unavailable') {
      expect(outcome.reason).toBe('unenrolled')
      // skipReason 是给 get_review_history 工具读的模型上下文，按边界保持中文
      expect(outcome.session.items[0].skipReason).toBe('这个主题已移出复习计划')
      // 掌握度不该被写
      expect((await db.nodes.get('n1'))?.mastery?.score).toBe(60)
    }
  })

  it('refuses undo when the session or the grading is gone', async () => {
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
    patchItem(session, session.items[0].itemId, { phase: 'feedback' }, NOW)
    await repo.save(session)

    const gone = await repo.undo({
      sessionId: 'nope',
      itemId: session.items[0].itemId,
      projectId: 'p1',
      nodeId: 'n1',
      now: NOW + 1000,
    })
    expect(gone.status).toBe('missing')
    if (gone.status === 'missing') expect(gone.reason).toBe('sessionMissing')

    // 会话在，但这一项从没评过分
    const nothing = await repo.undo({
      sessionId: session.id,
      itemId: session.items[0].itemId,
      projectId: 'p1',
      nodeId: 'n1',
      now: NOW + 1000,
    })
    expect(nothing.status).toBe('missing')
    if (nothing.status === 'missing') expect(nothing.reason).toBe('nothingToUndo')
  })
})