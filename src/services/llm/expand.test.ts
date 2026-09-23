import { describe, expect, it } from 'vitest'
import type { ModelMessage } from 'ai'
import type { ContextMessage, ContextPart } from '@/domain/context/assemble'
import { toModelMessages } from './chat'

/**
 * `toModelMessages` 是整个工具记录方案的**承重墙**：厂商要求
 * `assistant(tool_call)` 后必须紧跟对应的 `tool(tool_result)`，少任何一半直接 400。
 * 这里断言的就是这条不变量本身 —— 只要它成立，任意形状的 parts 都安全。
 */

interface Pairing {
  calls: string[]
  results: string[]
}

/** 扫一遍展开结果：收集所有 tool-call / tool-result 的 id，并检查是否一一配对。 */
function pairing(messages: ModelMessage[]): Pairing {
  const calls: string[] = []
  const results: string[] = []

  messages.forEach((message, index) => {
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (part.type === 'tool-call') calls.push(part.toolCallId)
      }
      return
    }
    if (message.role === 'tool') {
      // 工具结果消息必须紧跟在 assistant 之后（不允许被别的消息隔开）
      expect(messages[index - 1]?.role).toBe('assistant')
      for (const part of message.content) {
        if (part.type === 'tool-result') results.push(part.toolCallId)
      }
    }
  })

  return { calls, results }
}

function part(overrides: Partial<Extract<ContextPart, { type: 'tool' }>> = {}): ContextPart {
  return {
    type: 'tool',
    callId: overrides.callId ?? 'call-1',
    name: overrides.name ?? 'search_nodes',
    input: overrides.input ?? { query: '动量守恒' },
    ...(overrides.output !== undefined ? { output: overrides.output } : {}),
    ...(overrides.error !== undefined ? { error: overrides.error } : {}),
  }
}

function assistant(parts: ContextPart[]): ContextMessage {
  return { role: 'assistant', parts }
}

function user(text: string): ContextMessage {
  return { role: 'user', parts: [{ type: 'text', text }] }
}

describe('toModelMessages: 工具记录的展开', () => {
  it('keeps every call paired with its result', () => {
    const messages = toModelMessages([
      user('我之前学过相关的吗？'),
      assistant([
        { type: 'text', text: '我查一下。' },
        part({ callId: 'c1', output: '查到两个节点' }),
        { type: 'text', text: '你在《动量守恒》里学过。' },
      ]),
    ])

    const { calls, results } = pairing(messages)
    expect(calls).toEqual(['c1'])
    expect(results).toEqual(['c1'])
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
    ])
  })

  it('gives consecutive calls a single tool message, in order', () => {
    const messages = toModelMessages([
      assistant([
        part({ callId: 'c1', output: '结果一' }),
        part({ callId: 'c2', output: '结果二' }),
      ]),
    ])

    const { calls, results } = pairing(messages)
    expect(calls).toEqual(['c1', 'c2'])
    expect(results).toEqual(['c1', 'c2'])
    // 一步里同时调两个工具是合法的：一次 assistant + 一条含两个结果的工具消息
    expect(messages).toHaveLength(2)
    expect(messages[0].role).toBe('assistant')
    expect(messages[1].role).toBe('tool')
  })

  it('drops half records produced by an interrupted round (call without result)', () => {
    const messages = toModelMessages([
      assistant([{ type: 'text', text: '我查一下。' }, part({ callId: 'c1' })]),
    ])

    expect(pairing(messages)).toEqual({ calls: [], results: [] })
    expect(messages).toHaveLength(1)
    expect(messages[0]).toMatchObject({ role: 'assistant', content: '我查一下。' })
  })

  it('carries tool failures as error-text results', () => {
    const messages = toModelMessages([
      assistant([part({ callId: 'c1', error: '这个节点不存在' })]),
    ])

    const toolMessage = messages[1]
    expect(toolMessage.role).toBe('tool')
    if (toolMessage.role === 'tool') {
      const [content] = toolMessage.content
      expect(content).toMatchObject({
        type: 'tool-result',
        output: { type: 'error-text', value: '这个节点不存在' },
      })
    }
  })

  it('keeps text-only assistant messages in the plain string shape', () => {
    // 不带工具的请求体必须与今天逐字节一致 —— 纯文本消息不能变成 content 数组
    const messages = toModelMessages([
      assistant([{ type: 'text', text: '第一段' }, { type: 'text', text: '第二段' }]),
    ])
    expect(messages[0]).toEqual({ role: 'assistant', content: '第一段\n\n第二段' })
  })

  it('handles several tool rounds interleaved with text', () => {
    const messages = toModelMessages([
      user('问题'),
      assistant([
        part({ callId: 'c1', output: '一' }),
        { type: 'text', text: '再看看。' },
        part({ callId: 'c2', output: '二' }),
        { type: 'text', text: '答案是…' },
      ]),
    ])

    const { calls, results } = pairing(messages)
    expect(calls).toEqual(['c1', 'c2'])
    expect(results).toEqual(['c1', 'c2'])
    expect(messages.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'tool',
      'assistant',
      'tool',
      'assistant',
    ])
    // 任意一轮的结果消息都紧跟在自己的 assistant 之后（pairing 里已断言），
    // 这里再确认正文没有被并进工具段
    const last = messages[messages.length - 1]
    expect(last).toMatchObject({ role: 'assistant', content: '答案是…' })
  })

  it('never emits an unmatched result for a stray tool result', () => {
    // 只有结果、没有举手（构造性输入）：展开里不该凭空多出一条 tool 消息
    const messages = toModelMessages([assistant([{ type: 'text', text: '正文' }])])
    expect(pairing(messages)).toEqual({ calls: [], results: [] })
  })
})