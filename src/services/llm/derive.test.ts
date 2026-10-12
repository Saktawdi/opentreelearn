import { describe, expect, it } from 'vitest'
import { MockLanguageModelV3 } from 'ai/test'
import { generateSummary } from './derive'

function response(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: { unified: 'stop' as const, raw: undefined },
    usage: {
      inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: 10, text: 10, reasoning: undefined },
    },
    warnings: [],
  }
}

const params = { title: '拓扑排序', transcript: '学习者：我理解了关键路径，但拓扑排序的队列实现仍有疑问。' }
const assessment = { summary: '理解关键路径，队列实现仍需加强', mastery: 65, weakPoints: ['拓扑排序队列实现'] }

describe('learning assessment generation', () => {
  it('gets a complete assessment in one structured request', async () => {
    const model = new MockLanguageModelV3({ doGenerate: response(JSON.stringify(assessment)) })
    expect(await generateSummary(model, params)).toEqual(assessment)
    expect(model.doGenerateCalls).toHaveLength(1)
    expect(model.doGenerateCalls[0].responseFormat?.type).toBe('json')
  })

  it('uses plain JSON when the gateway rejects structured output, keeping mastery and weak points', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (options.responseFormat?.type === 'json') throw new Error('Unsupported response_format')
        return response(`\u0060\u0060\u0060json\n${JSON.stringify(assessment)}\n\u0060\u0060\u0060`)
      },
    })
    expect(await generateSummary(model, params)).toEqual(assessment)
    expect(model.doGenerateCalls).toHaveLength(2)
    expect(model.doGenerateCalls[1].responseFormat?.type).not.toBe('json')
    expect(model.doGenerateCalls[1].prompt[0].content).toContain('weakPoints')
  })

  it.each([
    '已掌握关键路径，但队列实现仍需加强',
    JSON.stringify({ summary: '只有摘要', weakPoints: [] }),
    JSON.stringify({ ...assessment, mastery: null }),
    JSON.stringify({ ...assessment, mastery: '65' }),
    JSON.stringify({ ...assessment, summary: ' ' }),
  ])('rejects incomplete fallback output instead of saving only a summary: %s', async (text) => {
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        if (options.responseFormat?.type === 'json') throw new Error('Unsupported response_format')
        return response(text)
      },
    })
    await expect(generateSummary(model, params)).rejects.toThrow()
  })

  it('does not call the model for an empty transcript', async () => {
    const model = new MockLanguageModelV3()
    expect(await generateSummary(model, { title: '空主题', transcript: ' ' })).toBeNull()
    expect(model.doGenerateCalls).toHaveLength(0)
  })
})
