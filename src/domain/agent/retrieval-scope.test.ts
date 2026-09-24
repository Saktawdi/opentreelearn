import { describe, expect, it } from 'vitest'
import type { Message, Node, Note } from '@/domain/models'
import type { Id } from '@/domain/models'
import { makeNode, messagesByNode } from '@/test/fixtures'
import {
  getNodeDetail,
  inScope,
  searchLabeledNotes,
  searchNodes,
  type ProjectSnapshot,
  type RetrievalScope,
} from './retrieval'

function note(partial: Partial<Note> & { id: string }): Note {
  return {
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    labels: [],
    quote: partial.id,
    start: 0,
    end: 1,
    createdAt: 1,
    updatedAt: 1,
    ...partial,
  }
}

function snapshot(nodes: Node[], messages: Array<[string, Message[]]>, notes: Note[] = []): ProjectSnapshot {
  return { nodes, messagesByNode: messagesByNode(messages), notes }
}

const scope: RetrievalScope = { nodeIds: ['n1' as Id] }

describe('searchNodes 作用域', () => {
  const selected = makeNode({ id: 'n1', title: '二叉树遍历' })
  const outside = makeNode({ id: 'n2', title: '二叉树性质' })
  const snap = snapshot([selected, outside], [])

  it('默认只返回作用域内的命中，且带 selected 标注', () => {
    const hits = searchNodes(snap, '二叉树', 8, { scope })
    expect(hits.map((hit) => hit.nodeId)).toEqual(['n1'])
    expect(hits[0].scope).toBe('selected')
  })

  it('widen 显式跨出：外部命中带 other 标注并排在后面', () => {
    const hits = searchNodes(snap, '二叉树', 8, { scope, widen: true })
    expect(hits.map((hit) => hit.nodeId)).toEqual(['n1', 'n2'])
    expect(hits[0].scope).toBe('selected')
    expect(hits[1].scope).toBe('other')
  })

  it('不绑作用域时行为与标注都和原来一致', () => {
    const hits = searchNodes(snap, '二叉树')
    expect(hits).toHaveLength(2)
    expect(hits.map((hit) => hit.nodeId).sort()).toEqual(['n1', 'n2'])
    expect(hits.every((hit) => hit.scope === undefined)).toBe(true)
  })
})

describe('searchLabeledNotes 作用域', () => {
  const n1 = makeNode({ id: 'n1', title: '框选内' })
  const n2 = makeNode({ id: 'n2', title: '框选外' })
  const notes = [
    note({ id: 'a', nodeId: 'n1', labels: ['mistake'], createdAt: 1 }),
    note({ id: 'b', nodeId: 'n2', labels: ['mistake'], createdAt: 2 }),
  ]
  const snap = snapshot([n1, n2], [], notes)

  it('默认只返回作用域内', () => {
    const result = searchLabeledNotes(snap, { labels: ['mistake'], scope })
    expect(result.total).toBe(1)
    expect(result.hits[0].noteId).toBe('a')
    expect(result.hits[0].scope).toBe('selected')
  })

  it('widen 跨出：外部标注带 other 标注', () => {
    const result = searchLabeledNotes(snap, { labels: ['mistake'], scope, widen: true })
    expect(result.total).toBe(2)
    expect(result.hits.map((hit) => hit.scope)).toEqual(['selected', 'other'])
  })

  it('nodeId 指向作用域外时在默认下查不到', () => {
    const result = searchLabeledNotes(snap, { nodeId: 'n2' as Id, scope })
    expect(result.total).toBe(0)
    const widened = searchLabeledNotes(snap, { nodeId: 'n2' as Id, scope, widen: true })
    expect(widened.total).toBe(1)
  })
})

describe('inScope / getNodeDetail', () => {
  it('未绑作用域视为全部在界内', () => {
    expect(inScope('anything' as Id, undefined)).toBe(true)
    expect(inScope('n2' as Id, scope)).toBe(false)
  })

  it('getNodeDetail 对框选外的节点也能返回（由工具层决定放行与否）', () => {
    const snap = snapshot([makeNode({ id: 'n2', title: '框选外' })], [])
    expect(getNodeDetail(snap, 'n2' as Id)?.title).toBe('框选外')
  })
})
