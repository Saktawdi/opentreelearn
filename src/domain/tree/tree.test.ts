import { describe, expect, it } from 'vitest'
import { makeNode } from '@/test/fixtures'
import {
  ancestorsOf,
  buildTreeIndex,
  childrenOf,
  collectReachable,
  depthOf,
  descendantsOf,
  forkedChildrenOf,
  pathTo,
  rootNodes,
} from './tree'

const nodes = [
  makeNode({ id: 'rootA', createdAt: 1 }),
  makeNode({ id: 'a1', parentId: 'rootA', createdAt: 2 }),
  makeNode({ id: 'a2', parentId: 'a1', createdAt: 3 }),
  makeNode({ id: 'rootB', createdAt: 4 }),
  makeNode({ id: 'orphan', parentId: 'missing', createdAt: 5 }),
]

describe('tree index', () => {
  it('promotes nodes with unknown parents to roots', () => {
    const index = buildTreeIndex(nodes)
    expect(rootNodes(index).map((node) => node.id)).toEqual(['rootA', 'rootB', 'orphan'])
  })

  it('resolves the path from a root to a node', () => {
    const index = buildTreeIndex(nodes)
    expect(pathTo(index, 'a2').map((node) => node.id)).toEqual(['rootA', 'a1', 'a2'])
    expect(ancestorsOf(index, 'a2').map((node) => node.id)).toEqual(['rootA', 'a1'])
    expect(depthOf(index, 'a2')).toBe(2)
  })

  it('collects children and descendants', () => {
    const index = buildTreeIndex(nodes)
    expect(childrenOf(index, 'rootA').map((node) => node.id)).toEqual(['a1'])
    expect(descendantsOf(index, 'rootA').map((node) => node.id)).toEqual(['a1', 'a2'])
  })

  it('detects unreachable nodes caused by cycles', () => {
    const cyclic = [
      makeNode({ id: 'x', parentId: 'y', createdAt: 1 }),
      makeNode({ id: 'y', parentId: 'x', createdAt: 2 }),
      makeNode({ id: 'ok', createdAt: 3 }),
    ]
    const index = buildTreeIndex(cyclic)
    const reachable = collectReachable(index)
    expect([...reachable]).toEqual(['ok'])
    expect(pathTo(index, 'x').map((node) => node.id)).toEqual(['y', 'x'])
  })
})

describe('fork relationships', () => {
  it('finds nodes forked from a given node', () => {
    const list = [
      makeNode({ id: 'a', createdAt: 1 }),
      makeNode({
        id: 'b',
        parentId: 'a',
        forkFrom: { nodeId: 'a', messageId: 'm1' },
        createdAt: 2,
      }),
      makeNode({ id: 'c', parentId: 'a', createdAt: 3 }),
    ]
    expect(forkedChildrenOf(list, 'a').map((node) => node.id)).toEqual(['b'])
  })
})