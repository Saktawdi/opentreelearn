import { describe, expect, it } from 'vitest'
import type { Node, Note } from '@/domain/models'
import type { ContextMessage } from './assemble'
import { makeNode } from '@/test/fixtures'
import {
  assembleFreeAskContext,
  buildStudyInventory,
  renderStudyInventory,
} from './free-ask'

const NOW = new Date('2026-09-22T21:00:00').getTime()
const DAY = 24 * 60 * 60 * 1000

function userMessage(text: string): ContextMessage {
  return { role: 'user', parts: [{ type: 'text', text }] }
}

function longText(length: number): string {
  return '学'.repeat(length)
}

describe('free-ask inventory', () => {
  it('lists title / summary / mastery band / created & edited dates with tree indentation', () => {
    const parent: Node = {
      ...makeNode({ id: 'p1', title: '一元函数积分' }),
      createdAt: new Date('2026-09-01T10:00:00').getTime(),
      updatedAt: new Date('2026-09-20T10:00:00').getTime(),
    }
    const child: Node = {
      ...makeNode({ id: 'c1', parentId: 'p1', title: '递推法速算' }),
      summary: '掌握了递推法基本应用',
      mastery: { score: 55, weakPoints: ['重根情形'], updatedAt: NOW },
    }

    const inventory = buildStudyInventory([parent, child])
    const text = renderStudyInventory(inventory)

    expect(text).toContain('- 《一元函数积分》 · 掌握：未评估 · 创建 2026-09-01 · 最后编辑 2026-09-20')
    expect(text).toContain('  - 《递推法速算》 · 掌握 55/100（档位 hard）')
    expect(text).toContain('      摘要：掌握了递推法基本应用')
  })

  it('skips legacy review centers and archived nodes, but discloses the archived count', () => {
    const center = makeNode({ id: 'r1', title: '复习中心', kind: 'review' })
    const archived = makeNode({ id: 'a1', title: '旧章节', status: 'archived' })
    const active = makeNode({ id: 'n1', title: '数列极限' })

    const inventory = buildStudyInventory([center, archived, active])
    const text = renderStudyInventory(inventory)

    expect(inventory.total).toBe(1)
    expect(text).toContain('数列极限')
    expect(text).not.toContain('复习中心')
    expect(text).not.toContain('旧章节')
    expect(text).toContain('（另有 1 个已归档主题未列出）')
  })

  it('says nothing was recorded instead of rendering an empty list', () => {
    const text = renderStudyInventory(buildStudyInventory([]))
    expect(text).toBe('（这个项目还没有学习主题）')
  })

  it('keeps the most recently edited topics when over the limit and reports the omission', () => {
    const nodes: Node[] = Array.from({ length: 6 }, (_, index) =>
      makeNode({
        id: `n${index}`,
        title: `主题${index}`,
        createdAt: index,
        updatedAt: index === 0 ? 999 : index,
      }),
    )

    const inventory = buildStudyInventory(nodes, { limit: 2 })
    expect(inventory.total).toBe(6)
    expect(inventory.omitted).toBe(4)
    // 最近编辑的 n0 必须留下，并且还原成树序（不按编辑时间重排）
    expect(inventory.entries.map((entry) => entry.nodeId)).toEqual(['n0', 'n5'])
    expect(renderStudyInventory(inventory)).toContain('（还有 4 个主题因上下文预算未列出）')
  })
})

describe('free-ask context assembly', () => {
  const nodes: Node[] = [
    makeNode({ id: 'n1', title: '极限', lastStudiedAt: NOW - DAY }),
    {
      ...makeNode({ id: 'n2', title: '导数' }),
      summary: '导数定义与几何意义',
      mastery: { score: 88, updatedAt: NOW },
    },
  ]

  it('carries the review-center rules, live study digest and node inventory', () => {
    const context = assembleFreeAskContext({
      nodes,
      history: [userMessage('今天我学了什么')],
      projectName: '考研数学二',
      projectDescription: '强化阶段',
      now: NOW,
    })

    expect(context.system).toContain('你是一位严谨的学科导师，正在和学习者自由讨论。')
    expect(context.system).toContain('你现在位于「复习中心」')
    expect(context.system).toContain('不要修改其他节点的任何数据')
    expect(context.system).toContain('## 学习快照')
    expect(context.system).toContain('- 《极限》 · 未评估 · 1 天前学习')
    expect(context.system).toContain('## 项目主题清单（标题 / 摘要 / 掌握度 / 创建与最后编辑时间）')
    expect(context.system).toContain('- 《导数》 · 掌握 88/100（档位 easy）')
    expect(context.system).toContain('- **名称**：考研数学二')
    expect(context.system).toContain('最后编辑时间」包含重命名')
    expect(context.listed).toBe(2)
    expect(context.total).toBe(2)
    expect(context.messages).toHaveLength(1)
  })

  it('drops summaries first when the budget is tight, keeping every topic', () => {
    const many: Node[] = Array.from({ length: 30 }, (_, index) => ({
      ...makeNode({ id: `n${index}`, title: `主题${index}` }),
      summary: longText(200),
    }))

    const context = assembleFreeAskContext({
      nodes: many,
      history: [userMessage('今天学了什么')],
      budgetTokens: 3200,
      now: NOW,
    })

    expect(context.system).not.toContain('摘要：')
    expect(context.listed).toBe(30)
    expect(context.system).not.toContain('因上下文预算未列出')
    expect(context.estimatedTokens).toBeLessThanOrEqual(3200)
  })

  it('cuts the inventory down and says so when summaries alone are not enough', () => {
    const many: Node[] = Array.from({ length: 30 }, (_, index) =>
      makeNode({ id: `n${index}`, title: `主题${index}` }),
    )

    const context = assembleFreeAskContext({
      nodes: many,
      history: [userMessage('今天学了什么')],
      budgetTokens: 1600,
      now: NOW,
    })

    expect(context.listed).toBeLessThan(30)
    expect(context.total).toBe(30)
    expect(context.system).toContain('因上下文预算未列出')
  })

  it('keeps the newest question and drops the oldest history when history is too large', () => {
    const history: ContextMessage[] = [
      userMessage(longText(4000)),
      { role: 'assistant', parts: [{ type: 'text', text: longText(4000) }] },
      userMessage('现在最该复习什么？'),
    ]

    const context = assembleFreeAskContext({
      nodes,
      history,
      budgetTokens: 2400,
      now: NOW,
    })

    expect(context.messages).toHaveLength(1)
    expect(context.messages[0].parts[0]).toEqual({ type: 'text', text: '现在最该复习什么？' })
  })
})
describe('free-ask user annotations', () => {
  const note = (id: string, labels: string[], extra: Partial<Note> = {}): Note => ({
    id,
    projectId: 'p1',
    nodeId: 'n1',
    messageId: 'm1',
    labels,
    quote: id,
    start: 0,
    end: 1,
    createdAt: 1,
    updatedAt: 1,
    ...extra,
  })

  const node: Node = makeNode({ id: 'n1', title: '动量守恒' })

  it('lists labeled annotations with their node, and keeps plain highlights out', () => {
    const ctx = assembleFreeAskContext({
      nodes: [node],
      notes: [
        note('忽略了竖直方向', ['mistake'], { nodeId: 'n1', quote: '忽略了竖直方向' }),
        note('只是书签', [], { nodeId: 'n1', quote: '只是书签' }),
      ],
      history: [userMessage('我有哪些还没搞懂的？')],
      now: NOW,
    })

    expect(ctx.system).toContain('## 用户标注（[错题] 1）')
    expect(ctx.system).toContain('- [错题] 《动量守恒》忽略了竖直方向')
    expect(ctx.system).toContain('「错题」= 学习者确认自己做错或答错的内容')
    expect(ctx.system).not.toContain('只是书签')
    expect(ctx.notes).toBe(1)
  })

  it('reports zero annotations when the project has none', () => {
    const ctx = assembleFreeAskContext({
      nodes: [node],
      notes: [],
      history: [userMessage('今天学什么？')],
      now: NOW,
    })

    expect(ctx.notes).toBe(0)
    expect(ctx.system).not.toContain('## 用户标注')
  })

  it('caps how many annotations are listed', () => {
    const many = Array.from({ length: 20 }, (_, index) =>
      note(`标注${index}`, ['mistake'], { nodeId: 'n1', quote: `标注${index}` }),
    )
    const ctx = assembleFreeAskContext({
      nodes: [node],
      notes: many,
      history: [userMessage('我有哪些错题？')],
      now: NOW,
    })

    expect(ctx.notes).toBe(12)
    expect(ctx.system).toContain('标注11')
    expect(ctx.system).not.toContain('标注12')
  })
})
