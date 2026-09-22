import { describe, expect, it } from 'vitest'
import type { Node } from '@/domain/models'
import { makeNode } from '@/test/fixtures'
import {
  hasHiddenAncestor,
  isLegacyCenter,
  legacyReviewCenters,
  projectVisibleNodes,
} from './center'

describe('legacy review center projection', () => {
  it('hides legacy centers and reparents their active children to the nearest visible ancestor', () => {
    const root = makeNode({ id: 'root', parentId: null })
    const legacyCenter: Node = {
      ...makeNode({ id: 'center', parentId: 'root' }),
      kind: 'review',
    }
    const childOfCenter = makeNode({ id: 'child1', parentId: 'center' })
    const grandchild = makeNode({ id: 'child2', parentId: 'child1' })

    const nodes = [root, legacyCenter, childOfCenter, grandchild]

    expect(legacyReviewCenters(nodes).map((n) => n.id)).toEqual(['center'])
    expect(isLegacyCenter(legacyCenter)).toBe(true)
    expect(hasHiddenAncestor(childOfCenter, nodes)).toBe(true)
    expect(hasHiddenAncestor(root, nodes)).toBe(false)

    const projected = projectVisibleNodes(nodes)
    // 隐藏的中心节点不出现在常规树投影中
    expect(projected.find((n) => n.id === 'center')).toBeUndefined()

    // 它的后代被重新接回其祖先 root
    const projectedChild = projected.find((n) => n.id === 'child1')!
    expect(projectedChild.parentId).toBe('root')

    // 孙节点仍保持指着 child1
    const projectedGrandchild = projected.find((n) => n.id === 'child2')!
    expect(projectedGrandchild.parentId).toBe('child1')
  })
})