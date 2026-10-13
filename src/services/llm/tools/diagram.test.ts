// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { simulateReadableStream } from 'ai'
import { diagramMarkdown, normalizeMermaidSource, validateMermaid } from '@/lib/mermaid'
import { resolveToolApproval } from '@/domain/agent/permissions'
import { makeMessage, makeNode } from '@/test/fixtures'
import { buildTreeExportData } from '@/services/export/tree-export'
import { parseTreeJson } from '@/services/import/tree-file'
import { streamReply } from '../chat'
import { buildReadOnlyTools } from './registry'

const sources = [
  'mindmap\n  root((学习主题))\n    概念\n    例题',
  'flowchart LR\n A[活动 A] --> B[活动 B]\n A --> C[活动 C]\n B --> C',
  'flowchart LR\n v1((1)) -->|a1: 3| v2((2))\n v1 -->|a2: 2| v3((3))\n v2 -. 虚活动: 0 .-> v3',
  'flowchart TB\n A((A)) ---|4| B((B))\n A ---|4| C((C))\n B ---|1| C',
  'sequenceDiagram\n 用户->>Agent: 绘图\n Agent-->>用户: 图表',
]

describe('Mermaid diagram tools', () => {
  it.each(sources)('validates actual Mermaid syntax: %s', async (source) => {
    expect((await validateMermaid(source)).source).toBe(source)
  })

  it('rejects syntax errors and source-controlled renderer configuration', async () => {
    await expect(validateMermaid('flowchart LR\n A -->')).rejects.toThrow()
    expect(() => normalizeMermaidSource('%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\n A-->B')).toThrow()
    expect(() => normalizeMermaidSource('---\nconfig:\n securityLevel: loose\n---\nflowchart LR\n A-->B')).toThrow()
    expect(() => normalizeMermaidSource('x'.repeat(20_001))).toThrow()
    expect(() => normalizeMermaidSource('mindmap\n' + '  node\n'.repeat(501))).toThrow()
    expect(normalizeMermaidSource('```mermaid\r\nflowchart LR\r\n A-->B\r\n```')).toBe('flowchart LR\n A-->B')
  })

  it('pure generation is registered and requires no project-write approval', () => {
    expect(resolveToolApproval('create_diagram', {}, {
      permission: 'prompt', findNode: () => null, withinOpenZone: () => false,
    }).action).toBe('allow')
  })

  const tools = buildReadOnlyTools({
    nodes: [], messagesByNode: new Map(), notes: [], approvalPolicy: 'enforced', permission: 'prompt',
  })

  function model(source: string) {
    let step = 0
    return new MockLanguageModelV3({
      doStream: async () => {
        step += 1
        return { stream: simulateReadableStream({
          initialDelayInMs: 0, chunkDelayInMs: 0,
          chunks: [
            { type: 'stream-start', warnings: [] },
            ...(step === 1 ? [{
              type: 'tool-call' as const, toolCallId: 'diagram1', toolName: 'create_diagram',
              input: JSON.stringify({ title: '带权图', source }),
            }] : [
              { type: 'text-start' as const, id: 'text' },
              { type: 'text-delta' as const, id: 'text', delta: '这是图的讲解。' },
              { type: 'text-end' as const, id: 'text' },
            ]),
            { type: 'finish', finishReason: { unified: step === 1 ? 'tool-calls' : 'stop', raw: undefined }, usage: {
              inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 5, text: 5, reasoning: undefined },
            } },
          ],
        }) }
      },
    })
  }

  it('tool-only generation delivers complete source through the stream and survives .tree export', async () => {
    const source = sources[3]
    const deltas: string[] = []
    const reviewDiagrams: string[] = []
    const result = await streamReply({
      model: model(source), system: '', messages: [{ role: 'user', content: '画一个带权图' }],
      tools, maxSteps: 1,
      onDelta: (delta) => deltas.push(delta),
      onDiagram: (markdown) => { reviewDiagrams.push(markdown) },
    })
    expect(result.text).toContain('```mermaid\n' + source + '\n```')
    expect(result.text).toBe(deltas.join(''))
    expect(reviewDiagrams).toEqual([result.text])
    expect(result.hitStepLimit).toBe(true)

    const node = makeNode({ id: 'n1', projectId: 'p1' })
    const message = makeMessage({ id: 'm1', nodeId: 'n1', projectId: 'p1', role: 'assistant', parts: [{ type: 'text', text: result.text }] })
    const project = { id: 'p1', name: '图论', tags: [], createdAt: 1, updatedAt: 1 }
    const exported = buildTreeExportData(project, [node], [message])
    expect(exported.data.cards[0].messages[0].content).toBe(result.text.trim())
    expect(parseTreeJson(exported).cards[0].messages[0].content).toBe(result.text.trim())
  })

  it('failed validation produces no diagram, and successful generation can continue to explanatory text', async () => {
    const failed = await streamReply({ model: model('flowchart LR\n A -->'), system: '', messages: [{ role: 'user', content: '画图' }], tools, maxSteps: 1 })
    expect(failed.text).toBe('')
    const complete = await streamReply({ model: model(sources[0]), system: '', messages: [{ role: 'user', content: '画图' }], tools, maxSteps: 2 })
    expect(complete.text).toContain(sources[0])
    expect(complete.text.endsWith('这是图的讲解。')).toBe(true)
  })

  it('escapes titles and uses a safe Markdown fence for labels containing backticks', () => {
    const markdown = diagramMarkdown('图\n<script>', 'flowchart LR\n A["```"]')
    expect(markdown).toContain('**图 \\<script\\>**')
    expect(markdown).toContain('````mermaid')
  })
})
