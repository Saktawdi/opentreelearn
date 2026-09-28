import { describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { messageSource } from '@/domain/messages'
import { makeMessage } from '@/test/fixtures'
import { MarkdownView } from './MarkdownView'
import { normalizeForRender } from './render-source'

/**
 * 渲染坐标系不变量：登记源文（messageSource）与渲染串（normalizeForRender）必须是
 * 同一份字符串 —— `data-otl-src` 挂在渲染串的坐标上，框选与写工具又拿登记源文去
 * 换算，两边差一个字符，公式之后的每个标注切片都静默错位（错切自洽，自愈发现不了）。
 *
 * 这里用**组件本体**渲染：MarkdownView 内部再做一遍 normalizeForRender（幂等），
 * 挂出来的区间就必须落在 messageSource 的坐标上 —— 按区间切回源文逐字成立。
 */

describe('渲染坐标系（登记源文 === 渲染串）', () => {
  it('含不受支持命令的消息：公式前后的标注区间都切出正确原文', () => {
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text: '记号 $\\centernot\\implies$ 之后是后文。' }],
    })
    const source = messageSource(message)
    const html = renderToStaticMarkup(createElement(MarkdownView, { content: source }))

    // 命令归一化让公式变短（$\centernot\implies$ → $\not\implies$）：渲染串比原文短，
    // 公式之后的区间若还按「没归一化的串」算就会整体错位 —— 回归时会在这里断
    const from = source.indexOf('$')
    const to = source.indexOf('$', from + 1) + 1
    expect(source.slice(from, to)).toBe('$\\not\\implies$')
    expect(html).toContain(`data-otl-src="${from},${to}"`)

    const tail = source.indexOf('之后是后文。')
    // 文字单位的区间含公式后的那个空格（17,24）
    expect(html).toContain(`data-otl-src="${tail - 1},${tail + 6}"`)
  })

  it('列表项 cases 修复后：后文标题的源文区间仍然成立', () => {
    const text = [
      '2. **求导**：',
      '   $$',
      '\\begin{cases}',
      "   L'_x = 0 \\\\",
      '   \\end{cases}',
      '$$',
      '3. **联立**。',
      '',
      '### 三、检验',
    ].join('\n')
    const message = makeMessage({
      id: 'm1',
      nodeId: 'n1',
      role: 'assistant',
      parts: [{ type: 'text', text }],
    })
    const source = messageSource(message)
    const html = renderToStaticMarkup(createElement(MarkdownView, { content: source }))

    expect(html).toContain('<h3')
    const heading = source.indexOf('三、检验')
    expect(html).toContain(`data-otl-src="${heading},${heading + 4}"`)
  })

  it('normalizeForRender 幂等：登记与渲染各算一次结果一致', () => {
    const text = [
      '记号 $\\centernot\\implies$ 与 $\\mathbbm{R}$：',
      '',
      '$$I_n = \\begin{cases}',
      '\\frac{1}{2}, & n \\\\',
      '\\end{cases}$$',
    ].join('\n')
    expect(normalizeForRender(normalizeForRender(text))).toBe(normalizeForRender(text))
  })
})
