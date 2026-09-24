import { describe, expect, it } from 'vitest'
import { BRANCH_QUICK_CHOICES } from '@/domain/defaults'
import {
  deriveTitle,
  messageBodyText,
  messageImageIds,
  messagePreview,
  messageQuotes,
  messageText,
  replaceMessageText,
  sameMessageParts,
} from '@/domain/messages'
import { makeMessage } from '@/test/fixtures'

describe('messageText', () => {
  it('无引用时与正文一致（保持既有行为）', () => {
    const message = makeMessage({ id: 'm1', nodeId: 'n1', parts: [{ type: 'text', text: '你好' }] })
    expect(messageText(message)).toBe('你好')
  })

  it('引用片段渲染成 Markdown 引用行，且与正文空行分隔', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '第一行\n第二行' },
        { type: 'text', text: '为什么？' },
      ],
    })
    expect(messageText(message)).toBe('> 第一行\n> 第二行\n\n为什么？')
  })

  it('只引用不打字时正文非空', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [{ type: 'quote', text: '被引用的原文' }],
    })
    expect(messageText(message)).toBe('> 被引用的原文')
  })

  it('忽略图片 part', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'text', text: '看图' },
        { type: 'image', assetId: 'a1' },
      ],
    })
    expect(messageText(message)).toBe('看图')
    expect(messageImageIds(message)).toEqual(['a1'])
  })
})

describe('messageBodyText / messageQuotes', () => {
  it('正文与引用分开取用', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '引用A' },
        { type: 'quote', text: '引用B' },
        { type: 'text', text: '我的问题' },
      ],
    })
    expect(messageBodyText(message)).toBe('我的问题')
    expect(messageQuotes(message)).toEqual(['引用A', '引用B'])
  })
})

describe('编辑用户消息时的 parts 处理', () => {
  const message = makeMessage({
    id: 'm1',
    nodeId: 'n1',
    parts: [
      { type: 'quote', text: '被引用的原文' },
      { type: 'text', text: '旧问题' },
      { type: 'image', assetId: 'a1' },
    ],
  })

  it('只换 text part，引用与图片原样沿用', () => {
    expect(replaceMessageText(message, '新问题')).toEqual([
      { type: 'quote', text: '被引用的原文' },
      { type: 'text', text: '新问题' },
      { type: 'image', assetId: 'a1' },
    ])
  })

  it('原本没有 text part 时把文字补进去', () => {
    const quoted = makeMessage({
      id: 'm2',
      nodeId: 'n1',
      parts: [{ type: 'quote', text: '只引用' }],
    })
    expect(replaceMessageText(quoted, '补一句')).toEqual([
      { type: 'quote', text: '只引用' },
      { type: 'text', text: '补一句' },
    ])
  })

  it('sameMessageParts 认得出没改动的编辑', () => {
    const edited = { ...message, parts: replaceMessageText(message, '旧问题') }
    expect(sameMessageParts(message, edited)).toBe(true)
    expect(
      sameMessageParts(message, { ...message, parts: replaceMessageText(message, '新问题') }),
    ).toBe(false)
  })
})

describe('deriveTitle', () => {
  it('优先用用户自己打的字', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '被引用的原文' },
        { type: 'text', text: '这句话什么意思？' },
      ],
    })
    expect(deriveTitle(message)).toBe('这句话什么意思？')
  })

  it('只引用时用被引用的原文，不带引用符号', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [{ type: 'quote', text: '被引用的原文' }],
    })
    expect(deriveTitle(message)).toBe('被引用的原文')
  })

  it('正文是快捷指令模板时不当标题：带引用则标题取引用，避免一批子节点重名', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '旋转曲面的侧面积' },
        { type: 'text', text: BRANCH_QUICK_CHOICES[0].prompt },
      ],
    })
    expect(deriveTitle(message)).toBe('旋转曲面的侧面积')
  })

  it('自定义指令（非模板）仍然当标题', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '被引用的原文' },
        { type: 'text', text: '用费曼技巧讲解这段内容' },
      ],
    })
    expect(deriveTitle(message)).toBe('用费曼技巧讲解这段内容')
  })

  it('纯图片提问仍回退到图片占位标题', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [{ type: 'image', assetId: 'a1' }],
    })
    expect(deriveTitle(message)).toBe('［图片提问］')
  })
})

describe('messagePreview', () => {
  it('引用内容会进入预览', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      parts: [
        { type: 'quote', text: '被引用的原文' },
        { type: 'text', text: '为什么？' },
      ],
    })
    expect(messagePreview(message)).toBe('> 被引用的原文 为什么？')
  })
})
