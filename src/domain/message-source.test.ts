import { describe, expect, it } from 'vitest'
import { messageSource } from '@/domain/messages'
import { normalizeForRender } from '@/lib/markdown/render-source'
import { makeMessage } from '@/test/fixtures'

/**
 * 源文是标注坐标系的基准（见 features/chat/note-anchor.ts）：
 * 用户与助手气泡都走 Markdown 渲染，坐标必须与渲染端一致；
 * 只有助手气泡剥掉复习评分协议。
 */
describe('messageSource', () => {
  it('助手消息剥掉评分标记（那是协议，不进正文）', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text: '答案是 4。\n[[rating:good]]' }],
    })
    expect(messageSource(message)).toBe('答案是 4。')
  })

  it('用户消息也按 Markdown 渲染口径规范化', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [{ type: 'text', text: '求 $\\mathbbm{R}$ 与 $$B$$' }],
    })
    expect(messageSource(message)).toBe('求 $\\mathbb{R}$ 与 $$B$$')
  })

  it('助手消息的块级公式围栏按渲染口径规范化（否则偏移会整体错位）', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text: '前文\n\n$$I_n = \\frac{1}{2}$$\n\n后文' }],
    })
    // 单行 $$…$$ 走行内解析，规范化的三条边界保证它原样保留
    expect(messageSource(message)).toBe('前文\n\n$$I_n = \\frac{1}{2}$$\n\n后文')
  })

  it('引用块与 AI 上下文同一形态（`> ` 前缀留在坐标里）', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [
        { type: 'quote', text: '被引用的原文' },
        { type: 'text', text: '为什么？' },
      ],
    })
    expect(messageSource(message)).toBe('> 被引用的原文\n\n为什么？')
  })

  it.each(['user', 'assistant'] as const)('%s 消息的源文与渲染串走同一入口', (role) => {
    // 真实回归：渲染端加了 normalizeMathCommands 而这里没跟上，含不受支持命令的
    // 消息里公式之后的每个标注区间整体错位（错切自洽，自愈校验发现不了）
    const text = '记号 $\\centernot\\implies$ 之后是后文。'
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role,
      parts: [{ type: 'text', text }],
    })
    expect(messageSource(message)).toBe(normalizeForRender(text))
  })
})
