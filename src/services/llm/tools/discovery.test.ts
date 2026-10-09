import { describe, expect, it } from 'vitest'
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { buildStreamOptions } from '../chat'
import { buildReadOnlyTools, buildWriteTools, type ToolRuntime } from './registry'
import { buildReviewDeliveryTools } from './review-delivery'
import { TOOL_RESULT_LIMIT } from './result'
import { withToolDiscovery } from './discovery'

const runtime: ToolRuntime = {
  nodes: [], messagesByNode: new Map(), notes: [],
  approvalPolicy: 'enforced', permission: 'prompt',
}

async function discover(set: ToolSet, input: { name?: string } = {}) {
  const execute = set.list_tools.execute as (input: { name?: string }, options: unknown) => Promise<string>
  const output = await execute(input, {})
  expect(output.length).toBeLessThanOrEqual(TOOL_RESULT_LIMIT)
  return JSON.parse(output.split('\n').slice(1).join('\n'))
}

describe('list_tools', () => {
  it('列出最终的读写工具及自身，不改变原工具授权包装', async () => {
    const original = {
      ...buildReadOnlyTools(runtime),
      ...buildWriteTools(runtime, {
        createNode: async () => null, renameNode: async () => null,
        tagSpan: async () => null, updateAssessment: async () => null,
      }),
    }
    const set = withToolDiscovery(original)
    const data = await discover(set)
    expect(data.tools.map((entry: { name: string }) => entry.name).sort()).toEqual(Object.keys(set).sort())
    expect(data.total).toBe(Object.keys(set).length)
    expect(data.omitted).toBeUndefined()
    expect(set.create_node).toBe(original.create_node)
    expect(original).not.toHaveProperty('list_tools')
    expect(data.tools.every((entry: { description: string }) => entry.description.length > 0)).toBe(true)
  })

  it('只列出本轮实际注册的复习交付能力和可选历史检索', async () => {
    const set = withToolDiscovery({
      ...buildReadOnlyTools({ ...runtime, reviewHistory: async () => [] }),
      ...buildReviewDeliveryTools(['pose_question'], {
        deliverTeach: async () => ({ ok: true }), deliverQuestion: async () => ({ ok: true }),
        deliverHint: async () => ({ ok: true }), deliverFeedback: async () => ({ ok: true }),
      }),
    })
    const data = await discover(set)
    const names = data.tools.map((entry: { name: string }) => entry.name)
    expect(names).toContain('get_review_history')
    expect(names).toContain('pose_question')
    expect(names).not.toContain('submit_feedback')
    expect(names).not.toContain('create_node')
    const detail = await discover(set, { name: 'pose_question' })
    expect(detail.description).toBe(set.pose_question.description)
    expect(await discover(set, { name: 'missing' })).toHaveProperty('error')
    expect(await discover(set, { name: 'toString' })).toHaveProperty('error')
  })

  it('多条长描述仍保留全部工具名称', async () => {
    const original = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [
      `tool_${i}`, tool({ description: '用途'.repeat(200), inputSchema: z.object({}), execute: async () => '' }),
    ]))
    const set = withToolDiscovery(original)
    const data = await discover(set)
    expect(data.tools).toHaveLength(31)
    expect(data.omitted).toBeUndefined()
  })

  it('无工具的请求保留原提示词，有工具时加入持续调用规则', () => {
    const base = { model: {} as Parameters<typeof buildStreamOptions>[0]['model'], system: '原提示词', messages: [] }
    expect(buildStreamOptions(base).system).toBe('原提示词')
    expect(buildStreamOptions({ ...base, tools: {} }).system).toBe('原提示词')
    const options = buildStreamOptions({ ...base, tools: buildReadOnlyTools(runtime) })
    expect(options.system).toContain('本轮任何阶段都可以调用工具')
    expect(options.system).toContain('纯文本结束后不会自动进入下一步')
  })
})
