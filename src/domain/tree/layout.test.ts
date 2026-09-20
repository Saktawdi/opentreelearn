import { describe, expect, it } from 'vitest'
import { makeNode } from '@/test/fixtures'
import { computeTreeLayout, DEFAULT_LAYOUT_OPTIONS } from './layout'

const nodes = [
  makeNode({ id: 'root', createdAt: 1 }),
  makeNode({ id: 'c1', parentId: 'root', createdAt: 2 }),
  makeNode({ id: 'c2', parentId: 'root', createdAt: 3 }),
  makeNode({ id: 'g1', parentId: 'c1', createdAt: 4 }),
]

describe('computeTreeLayout', () => {
  it('lays out depth vertically and siblings horizontally', () => {
    const { positions } = computeTreeLayout(nodes)
    const root = positions.get('root')
    const c1 = positions.get('c1')
    const c2 = positions.get('c2')
    const g1 = positions.get('g1')

    expect(root).toBeDefined()
    expect(c1).toBeDefined()
    expect(c2).toBeDefined()
    expect(g1).toBeDefined()

    expect(root!.y).toBeLessThan(c1!.y)
    expect(c1!.y).toBe(c2!.y)
    expect(c1!.y).toBeLessThan(g1!.y)
    expect(c1!.x).not.toBe(c2!.x)
  })

  it('packs multiple roots side by side without overlap', () => {
    const list = [
      ...nodes,
      makeNode({ id: 'root2', createdAt: 10 }),
      makeNode({ id: 'root2c', parentId: 'root2', createdAt: 11 }),
    ]
    const { positions, width } = computeTreeLayout(list)
    const root = positions.get('root')!
    const root2 = positions.get('root2')!

    expect(root2.x).toBeGreaterThan(root.x + DEFAULT_LAYOUT_OPTIONS.nodeWidth)
    expect(width).toBeGreaterThan(root2.x)
  })

  it('ignores archived nodes', () => {
    const list = [...nodes, makeNode({ id: 'gone', parentId: 'root', status: 'archived' })]
    const { positions } = computeTreeLayout(list)
    expect(positions.has('gone')).toBe(false)
  })

  it('still positions nodes trapped in a cycle', () => {
    const cyclic = [
      makeNode({ id: 'x', parentId: 'y', createdAt: 1 }),
      makeNode({ id: 'y', parentId: 'x', createdAt: 2 }),
    ]
    const { positions } = computeTreeLayout(cyclic)
    expect(positions.has('x')).toBe(true)
    expect(positions.has('y')).toBe(true)
  })
})