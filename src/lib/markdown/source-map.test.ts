import { describe, expect, it } from 'vitest'
import {
  EXACT_PROP,
  parseSourceAttr,
  rehypeSourceMap,
  SRC_PROP,
  type MarkdownNode,
} from './source-map'

/**
 * 这些树是手搭的，但形状与 remark-parse + remark-rehype 实际产出的 hast 一致
 * （元素位置含定界符、文字节点位置可能比 value 宽、表格补的换行没有位置）。
 * 用真实解析器写测试会连带把「位置由解析器给」这个前提也测掉，而这不是本文件的职责。
 */

interface El {
  type: 'element'
  tagName: string
  properties?: Record<string, unknown>
  children?: Node[]
  position?: { start: { offset: number }; end: { offset: number } }
}
interface Text {
  type: 'text'
  value: string
  position?: { start: { offset: number }; end: { offset: number } }
}
type Node = El | Text

function text(value: string, start?: number, end?: number): Text {
  if (start === undefined) return { type: 'text', value }
  return {
    type: 'text',
    value,
    // 位置可能比 value 宽（行内代码含反引号、实体含 &amp;）：end 缺省按 value 长度算
    position: { start: { offset: start }, end: { offset: end ?? start + value.length } },
  }
}

function el(tagName: string, children: Node[], start?: number, end?: number, properties?: Record<string, unknown>): El {
  return {
    type: 'element',
    tagName,
    ...(properties ? { properties } : {}),
    children,
    ...(start !== undefined && end !== undefined
      ? { position: { start: { offset: start }, end: { offset: end } } }
      : {}),
  }
}

function run(source: string, children: Node[]): El {
  const tree = el('root', children) as unknown as MarkdownNode
  rehypeSourceMap(source)(tree)
  return tree as unknown as El
}

/** 单位元素上的区间：`[start, end)` 与是否精确。 */
function spanOf(node: El): { start: number; end: number; exact: boolean } | null {
  const raw = node.properties?.[SRC_PROP]
  if (typeof raw !== 'string') return null
  const parsed = parseSourceAttr(raw, node.properties?.[EXACT_PROP] === '1')
  return parsed ? { start: parsed.start, end: parsed.end, exact: parsed.exact } : null
}

describe('rehypeSourceMap', () => {
  it('把文字节点包成精确单位，区间落在源文里', () => {
    const source = '在极坐标系下，双纽线方程为 $A$。'
    const [paragraph] = run(source, [
      el('p', [text('在极坐标系下，双纽线方程为 ', 0), text('。', 17, 18)], 0, 18),
    ]).children!

    const inner = (paragraph as El).children![0] as El
    expect(inner.tagName).toBe('span')
    expect(spanOf(inner)).toEqual({ start: 0, end: 14, exact: true })
  })

  it('转义与实体把位置撑得比 value 宽时，整段原子（DOM 文字 ≠ 源文）', () => {
    // 源文 `转义 \*星号\* 与实体 &amp; 收尾`，渲染出来是 `转义 *星号* 与实体 & 收尾`：
    // 一个 text 节点，位置覆盖整段，value 与它逐字不同 —— 只能整段锚定
    const source = '转义 \\*星号\\* 与实体 &amp; 收尾'
    const value = '转义 *星号* 与实体 & 收尾'
    const [paragraph] = run(source, [el('p', [text(value, 0, source.length)], 0, source.length)]).children!

    const inner = (paragraph as El).children![0] as El
    expect(spanOf(inner)).toEqual({ start: 0, end: source.length, exact: false })
  })

  it('行内公式包一层并整段锚定（区间含着 $，KaTeX 会换掉原元素）', () => {
    const source = '面积 $A$ 与 $V = \\frac{2}{3}\\pi r^3$'
    const math = el('code', [text('A')], 3, 6, { className: ['language-math', 'math-inline'] })
    const [paragraph] = run(source, [el('p', [text('面积 ', 0), math], 0, source.length)]).children!

    const wrapper = ((paragraph as El).children![1] as El)
    expect(wrapper.tagName).toBe('span')
    expect(spanOf(wrapper)).toEqual({ start: 3, end: 6, exact: false })
    // 包的是原元素，KaTeX 仍然认得出这段公式
    expect((wrapper.children![0] as El).properties?.className).toEqual(['language-math', 'math-inline'])
  })

  it('行间公式用 div 包住（pre 会被 KaTeX 整个替换，属性只能由外层承住）', () => {
    const source = '前文\n\n$$\ndV = \\frac{2}{3}\\pi r^3 \\sin\\theta\\,d\\theta\n$$\n'
    const start = source.indexOf('$$')
    const end = source.lastIndexOf('$$') + 2
    // 真实形状：math class 挂在子 code 上，pre 自己看不出是公式；子节点没有位置
    const code = el('code', [text('dV = 1')], undefined, undefined, {
      className: ['language-math', 'math-display'],
    })
    const [wrapper] = run(source, [el('pre', [code], start, end)]).children!

    expect((wrapper as El).tagName).toBe('div')
    expect(spanOf(wrapper as El)).toEqual({ start, end, exact: false })
  })

  it('代码块锚到代码本身，围栏与语言标记不算在内', () => {
    const source = '说明\n\n```js\nconst a = 1\n```\n'
    const fence = source.indexOf('```js')
    const code = el('code', [text('const a = 1\n')], fence, source.length - 1, {
      className: ['language-js'],
    })
    const [annotated] = run(source, [el('pre', [code], fence, source.length - 1)]).children!

    const codeStart = source.indexOf('const')
    expect((annotated as El).tagName).toBe('pre')
    expect(spanOf(annotated as El)).toEqual({
      start: codeStart,
      end: codeStart + 'const a = 1'.length,
      exact: true,
    })
  })

  it('行内代码只在反引号里面精确锚定', () => {
    const source = '见 `a < b` 一行'
    // 真实形状：code 元素与它的 text 子节点位置都覆盖反引号，value 只有内容
    const code = el('code', [text('a < b', 2, 9)], 2, 9)
    const [paragraph] = run(source, [el('p', [text('见 ', 0), code, text(' 一行', 9)], 0, source.length)]).children!

    expect(spanOf((paragraph as El).children![0] as El)).toEqual({ start: 0, end: 2, exact: true })
  })

  it('图片整段锚定在自己身上，不额外包一层', () => {
    const source = '看图 ![图](u.png) 完'
    const img = el('img', [], 3, 15, { src: 'u.png', alt: '图' })
    const [paragraph] = run(source, [el('p', [text('看图 ', 0), img], 0, source.length)]).children!

    const annotated = (paragraph as El).children![1] as El
    expect(annotated.tagName).toBe('img')
    expect(spanOf(annotated)).toEqual({ start: 3, end: 15, exact: false })
  })

  it('没有位置的合成节点（表格补的换行）原样放着', () => {
    const source = '| 列 A |'
    const [row] = run(source, [el('th', [text('列 A', 2, 5)], 0, source.length)]).children!

    expect(spanOf(((row as El).children![0] as El))).toEqual({ start: 2, end: 5, exact: true })
    // 表格自己的结构与位置不动
    expect((row as El).tagName).toBe('th')
  })

  it('嵌套单位逐层标注（加粗里的文字各自成单位）', () => {
    const source = '**重点** 与普通文字'
    const strong = el('strong', [text('重点', 2, 4)], 0, 6)
    const [paragraph] = run(source, [
      el('p', [strong, text(' 与普通文字', 6, 12)], 0, source.length),
    ]).children!

    const star = (paragraph as El).children![0] as El
    expect(star.tagName).toBe('strong')
    // 加粗标记 `**` 不属于文字，只锚住里面那两个字
    expect(spanOf(star.children![0] as El)).toEqual({ start: 2, end: 4, exact: true })
    expect(spanOf((paragraph as El).children![1] as El)).toEqual({ start: 6, end: 12, exact: true })
  })

  it('空源文不做任何标注', () => {
    const [paragraph] = run('', [el('p', [text('文字', 0)], 0, 2)]).children!
    expect(spanOf((paragraph as El).children![0] as El)).toBeNull()
  })
})

describe('parseSourceAttr', () => {
  it('解析合法区间', () => {
    expect(parseSourceAttr('3,7', true)).toEqual({ start: 3, end: 7, exact: true })
    expect(parseSourceAttr('0,0', false)).toEqual({ start: 0, end: 0, exact: false })
  })

  it('噪声一律当作没标注', () => {
    expect(parseSourceAttr(undefined, false)).toBeNull()
    expect(parseSourceAttr('', false)).toBeNull()
    expect(parseSourceAttr('3', false)).toBeNull()
    expect(parseSourceAttr('a,b', false)).toBeNull()
    expect(parseSourceAttr('5,3', false)).toBeNull()
    expect(parseSourceAttr('-1,3', false)).toBeNull()
    expect(parseSourceAttr('1.5,3', false)).toBeNull()
  })
})
