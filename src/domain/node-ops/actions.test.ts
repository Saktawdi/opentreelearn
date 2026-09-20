import { describe, expect, it } from 'vitest'
import { makeNode } from '@/test/fixtures'
import { createNodeFromAction, resolveForkFrom, resolveParentId } from './actions'

const root = makeNode({ id: 'root', createdAt: 1 })
const child = makeNode({ id: 'child', parentId: 'root', createdAt: 2 })

describe('node actions', () => {
  it('diverge creates a sibling that inherits context', () => {
    expect(resolveParentId('diverge', child)).toBe('root')
    expect(resolveForkFrom('diverge', child, 'm1')).toEqual({ nodeId: 'child', messageId: 'm1' })
  })

  it('diverge on a root produces a new root', () => {
    expect(resolveParentId('diverge', root)).toBeNull()
  })

  it('child creates an empty descendant without context inheritance', () => {
    expect(resolveParentId('child', child)).toBe('child')
    expect(resolveForkFrom('child', child, 'm1')).toBeNull()
  })

  it('branch creates a descendant that inherits context', () => {
    expect(resolveParentId('branch', child)).toBe('child')
    expect(resolveForkFrom('branch', child, 'm1')).toEqual({ nodeId: 'child', messageId: 'm1' })
  })

  it('builds a node with placeholder title and no manual position', () => {
    const node = createNodeFromAction({
      projectId: 'p1',
      sourceNode: child,
      kind: 'branch',
      sourceMessageId: 'm1',
      id: 'new-node',
      now: 42,
    })

    expect(node).toMatchObject({
      id: 'new-node',
      projectId: 'p1',
      parentId: 'child',
      forkFrom: { nodeId: 'child', messageId: 'm1' },
      title: '新节点',
      position: null,
      status: 'active',
      createdAt: 42,
    })
  })
})