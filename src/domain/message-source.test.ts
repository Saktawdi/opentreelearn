import { describe, expect, it } from 'vitest'
import { messageSource, userBodySpans } from '@/domain/messages'
import { normalizeForRender } from '@/lib/markdown/render-source'
import { makeMessage } from '@/test/fixtures'

/**
 * 源文是标注坐标系的基准（见 features/chat/note-anchor.ts）：
 * 助手气泡走 Markdown 渲染，所以坐标必须与渲染端一致（先剥评分标记、再规范化块级公式）；
 * 用户气泡不走 Markdown，坐标就是 messageText 自己。
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

  it('用户消息不做 Markdown 规范化（气泡是直接渲染的）', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [{ type: 'text', text: '求 $A$ 与 $$B$$' }],
    })
    expect(messageSource(message)).toBe('求 $A$ 与 $$B$$')
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

  it('助手消息的源文与渲染串走同一入口（命令归一化不再缺席，坐标系不分叉）', () => {
    // 真实回归：渲染端加了 normalizeMathCommands 而这里没跟上，含不受支持命令的
    // 消息里公式之后的每个标注区间整体错位（错切自洽，自愈校验发现不了）
    const text = '记号 $\\centernot\\implies$ 之后是后文。'
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text }],
    })
    expect(messageSource(message)).toBe(normalizeForRender(text))
  })
})

describe('userBodySpans', () => {
  it('单段正文与源文逐字一致时为精确区间', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [{ type: 'text', text: '正文一段' }],
    })
    const spans = userBodySpans(message)

    expect(spans.body).toEqual({ start: 0, end: 4 })
    expect(spans.bodyExact).toBe(true)
  })

  it('引用块锚到含 `> ` 前缀的整段（渲染时前缀被去掉）', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [
        { type: 'quote', text: '第一行\n第二行' },
        { type: 'text', text: '为什么？' },
      ],
    })
    const spans = userBodySpans(message)

    // 源文：`> 第一行\n> 第二行` + 空行 + `为什么？`
    expect(spans.quotes[0]).toEqual({ start: 0, end: 11 })
    expect(spans.body).toEqual({ start: 13, end: 17 })
    expect(spans.bodyExact).toBe(true)
  })

  it('多段正文合成一个 `<p>` 时整段锚定，不假装逐字对齐', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [
        { type: 'text', text: '第一段' },
        { type: 'text', text: '第二段' },
      ],
    })
    const spans = userBodySpans(message)

    // 源文是 `第一段\n\n第二段`，气泡里却渲染成一个段落，所以只能整段锚定
    expect(spans.body).toEqual({ start: 0, end: 8 })
    expect(spans.bodyExact).toBe(false)
  })

  it('只有图片时没有任何区间', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'user',
      parts: [{ type: 'image', assetId: 'a1' }],
    })
    const spans = userBodySpans(message)

    expect(spans.quotes).toEqual([])
    expect(spans.body).toBeNull()
  })
})
