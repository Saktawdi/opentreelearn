import { describe, expect, it } from 'vitest'
import type { Message, Node, Project } from '@/domain/models'
import { parseTreeJson } from '@/services/import/tree-file'
import { buildTreeExportData, stringifyTreeExport } from './tree-export'

describe('tree-export', () => {
  it('converts Project, Nodes and Messages into standard .tree JSON format', () => {
    const project: Project = {
      id: 'p-1',
      name: '测试导出项目',
      tags: ['考研', '数学'],
      createdAt: 1000,
      updatedAt: 2000,
    }

    const nodes: Node[] = [
      {
        id: 'n-root',
        projectId: 'p-1',
        parentId: null,
        forkFrom: null,
        title: '极限与连续',
        position: { x: 100, y: 200 },
        status: 'active',
        createdAt: 1000,
        updatedAt: 1000,
      },
      {
        id: 'n-child1',
        projectId: 'p-1',
        parentId: 'n-root',
        forkFrom: null,
        title: '泰勒公式展开',
        contextSeed: ['引用前文极限知识'],
        position: { x: 300, y: 400 },
        status: 'active',
        createdAt: 1100,
        updatedAt: 1100,
      },
      {
        id: 'n-archived',
        projectId: 'p-1',
        parentId: 'n-root',
        forkFrom: null,
        title: '已归档草稿',
        position: null,
        status: 'archived',
        createdAt: 1200,
        updatedAt: 1200,
      },
    ]

    const messages: Message[] = [
      {
        id: 'm-1',
        nodeId: 'n-root',
        projectId: 'p-1',
        role: 'user',
        parts: [{ type: 'text', text: '什么是麦克劳林公式？' }],
        createdAt: 1010,
      },
      {
        id: 'm-2',
        nodeId: 'n-root',
        projectId: 'p-1',
        role: 'assistant',
        parts: [{ type: 'text', text: '麦克劳林公式是泰勒公式在 x=0 处的特例。' }],
        createdAt: 1020,
      },
      {
        id: 'm-3',
        nodeId: 'n-child1',
        projectId: 'p-1',
        role: 'user',
        parts: [{ type: 'text', text: '求 sin x 的展开式' }],
        createdAt: 1110,
      },
    ]

    const exported = buildTreeExportData(project, nodes, messages)

    expect(exported.type).toBe('project')
    expect(exported.version).toBe(1)
    expect(exported.data.name).toBe('测试导出项目')
    // 归档节点不包含
    expect(exported.data.cards.length).toBe(2)

    const rootCard = exported.data.cards.find((c) => c.id === 'n-root')!
    const childCard = exported.data.cards.find((c) => c.id === 'n-child1')!

    expect(rootCard.title).toBe('极限与连续')
    expect(rootCard.children).toEqual(['n-child1'])
    expect(rootCard.position).toEqual([100, 200, 0])
    expect(rootCard.messages.length).toBe(2)
    expect(rootCard.messages[0].role).toBe('user')
    expect(rootCard.messages[1].role).toBe('ai')

    expect(childCard.messages[0].context).toEqual(['引用前文极限知识'])

    // Round-trip 测试：导出的 JSON 可以被 parseTreeJson 成功解析无损还原
    const jsonStr = stringifyTreeExport(exported)
    const reparsed = parseTreeJson(JSON.parse(jsonStr))

    expect(reparsed.name).toBe('测试导出项目')
    expect(reparsed.stats.cards).toBe(2)
    expect(reparsed.stats.roots).toBe(1)
    expect(reparsed.stats.messages).toBe(3)
    expect(reparsed.stats.contextSeeds).toBe(1)

    const reparsedChild = reparsed.cards.find((c) => c.sourceId === 'n-child1')!
    expect(reparsedChild.parentSourceId).toBe('n-root')
    expect(reparsedChild.contextSeed).toEqual(['引用前文极限知识'])
  })
})
