import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import { gradeNode, matchesWrittenState, undoGrade } from './grade'

const NOW = 1700000000000

describe('gradeNode & undoGrade', () => {
  it('computes correct grade patch and stores clean baseline', () => {
    const node: Node = {
      ...makeNode({ id: 'n1' }),
      mastery: { score: 70, updatedAt: NOW - 10000 },
    }

    const write = gradeNode(node, 'good', 'op-1', NOW)

    expect(write.patch.mastery?.score).toBe(75)
    // 关键规范：复习评分绝不改动 mastery.updatedAt，保留当初 AI 评估的快照时间
    expect(write.patch.mastery?.updatedAt).toBe(NOW - 10000)
    expect(write.patch.mastery?.gradedAt).toBe(NOW)
    expect(write.patch.review?.lastGrade).toBe('good')
    expect(write.patch.reviewEnrollment).toBe('enabled')

    expect(write.result.operationId).toBe('op-1')
    expect(write.result.baseMastery?.score).toBe(70)
  })

  it('accurately verifies matchWrittenState for conflict detection', () => {
    const node: Node = {
      ...makeNode({ id: 'n1' }),
      mastery: { score: 70, updatedAt: NOW },
    }
    const write = gradeNode(node, 'good', 'op-1', NOW)
    const afterNode: Node = { ...node, ...write.patch }

    expect(matchesWrittenState(afterNode, write.result)).toBe(true)

    // 假设外部同步或学习动作更改了分数
    const mutatedNode: Node = {
      ...afterNode,
      mastery: { score: 80, updatedAt: NOW + 1000 },
    }
    expect(matchesWrittenState(mutatedNode, write.result)).toBe(false)
  })

  it('undoes grading and restores exact baseline without resetting irrelevant fields', () => {
    const node: Node = {
      ...makeNode({ id: 'n1' }),
      title: '原有标题',
      mastery: { score: 60, updatedAt: NOW - 5000 },
      reviewEnrollment: 'enabled',
    }

    const write = gradeNode(node, 'again', 'op-2', NOW)
    const afterNode: Node = { ...node, ...write.patch }

    // 验证 again 将掌握度打回重新学习区间
    expect(afterNode.mastery?.score).toBeLessThanOrEqual(35)

    const undo = undoGrade(afterNode, write.result, NOW + 2000)
    expect(undo).not.toBeNull()

    const restoredNode: Node = { ...afterNode, ...undo!.patch }
    expect(restoredNode.mastery?.score).toBe(60)
    expect(restoredNode.title).toBe('原有标题')
    expect(restoredNode.reviewEnrollment).toBe('enabled')
  })

  it('rejects undo when state has drifted externally', () => {
    const node: Node = {
      ...makeNode({ id: 'n1' }),
      mastery: { score: 60, updatedAt: NOW },
    }
    const write = gradeNode(node, 'good', 'op-3', NOW)
    const driftedNode: Node = {
      ...node,
      ...write.patch,
      mastery: { score: 99, updatedAt: NOW + 5000 },
    }

    const undo = undoGrade(driftedNode, write.result, NOW + 6000)
    expect(undo).toBeNull()
  })
})