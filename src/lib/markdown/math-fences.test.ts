import { describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeDisplayMath } from './math-fences'

/**
 * 块级公式围栏的规范化。
 *
 * 回归的是这样一个真实故障：模型按最常见的 cases 写法输出
 *
 *     $$I_n = \begin{cases}
 *     \frac{n-1}{n}, & n \text{ 为正偶数} \\
 *     \end{cases}$$
 *
 * 开栏同行内容被当成围栏元信息丢掉（`\begin{cases}` 消失，`&` 变成顶层字符），
 * 行尾的 `$$` 又不构成闭合围栏，公式块一路吞到文末 —— 渲染出一大片红色原始文本。
 */

/** 用应用里完全相同的插件配置渲染，只看是否有 KaTeX 报错块。 */
function renderWithAppPipeline(content: string): string {
  return renderToStaticMarkup(
    ReactMarkdown({
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]],
      children: normalizeDisplayMath(content),
    }),
  )
}

/** 对照组：不做规范化，用于确认某段内容「本来就不该被修好」。 */
function renderWithoutNormalization(content: string): string {
  return renderToStaticMarkup(
    ReactMarkdown({
      remarkPlugins: [remarkGfm, remarkMath],
      rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]],
      children: content,
    }),
  )
}

const hasKatexError = (html: string) => html.includes('katex-error')

describe('normalizeDisplayMath', () => {
  it('把「开栏同行有内容」的块级围栏拆到独占一行', () => {
    const input = ['$$I_n = \\begin{cases}', '\\frac{1}{2}, & n \\\\', '$$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      ['$$', 'I_n = \\begin{cases}', '\\frac{1}{2}, & n \\\\', '$$'].join('\n'),
    )
  })

  it('把写在内容行尾的闭合围栏拆到独占一行', () => {
    const input = ['$$', '\\frac{1}{2}', '\\end{cases}$$', '', '后文'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      ['$$', '\\frac{1}{2}', '\\end{cases}', '$$', '', '后文'].join('\n'),
    )
  })

  it('两侧围栏都已规范时原样返回（幂等）', () => {
    const input = ['$$', '\\frac{1}{2}', '$$', '', '后文'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
    // 再规范化一次不再改变
    expect(normalizeDisplayMath(normalizeDisplayMath(input))).toBe(input)
  })

  it('单行 $$…$$ 原样保留（走行内解析，不该被改成块级）', () => {
    const cases = [
      '$$E = mc^2$$',
      '计算：$$I_1 = \\int_0^1 x \\, dx$$ 结束',
      '- 列表里的 $$a = b$$',
    ]
    for (const input of cases) {
      expect(normalizeDisplayMath(input)).toBe(input)
    }
  })

  it('行内 $…$ 不受影响', () => {
    const input = '设 $f(x)$ 连续，则 $\\int_a^b f = \\int_a^b f(a+b-x)\\,dx$。\n\n后文'
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('代码围栏里的 $$ 不动', () => {
    const input = ['```latex', '$$a = b$$', '$$I_n = \\begin{cases}', '```'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('转义的反斜杠美元不算围栏', () => {
    const input = '价格是 \\$\\$ 两个符号\n\n后文'
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('未闭合的块级公式一律不改写（流式中途的半截公式不能被改差）', () => {
    const unclosed = [
      '$$I_n = \\begin{cases}\n',
      [
        '$$I_n = \\begin{cases}',
        '\\frac{n-1}{n} \\cdot \\frac{\\pi}{2}, & n \\text{ 为正偶数} \\\\',
      ].join('\n'),
      ['$$', 'I_n = \\begin{cases}', '\\frac{1}{2}'].join('\n'),
      ['$$I_n = \\begin{cases}', '\\frac{1}{2}', '\\end{cases}'].join('\n'),
    ]

    for (const input of unclosed) {
      // 找不到闭合围栏就不猜：逐字节原样输出
      expect(normalizeDisplayMath(input), `不该改写：${JSON.stringify(input)}`).toBe(input)
      // 渲染结果与不做规范化完全一致（既不修好、也不弄坏）
      expect(renderWithAppPipeline(input)).toBe(renderWithoutNormalization(input))
    }
  })

  it('没有 $$ 时直接原样返回', () => {
    const input = '# 标题\n\n正文 $x$ 与普通文本'
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('对不是「坏掉的块级围栏」的文本一律是空操作', () => {
    const untouched = [
      '价格是 $$100 元，很贵',
      '用 `$$x$$` 表示公式',
      '$$$$',
      '$$',
      '$$I = \\int_0^1 x\\,dx$$ 结束',
      '$$a$$ 与 $$b$$ 都是',
      ['```latex', '$$I_n = \\begin{cases}', 'a & b', '```'].join('\n'),
      ['~~~', '$$x$$', '~~~'].join('\n'),
      '    $$四个空格缩进是代码块',
      '成本是 \\$\\$ 两个符号',
      ['> $$', '> a = b', '> $$'].join('\n'),
    ]
    for (const input of untouched) {
      expect(normalizeDisplayMath(input), `不该改写：${JSON.stringify(input)}`).toBe(input)
    }
  })
})

describe('修复后的端到端渲染', () => {
  it('cases 的两种围栏写法都渲染成功，且不再吞掉后文', () => {
    // 模型的原写法：开栏同行有内容 + 行尾闭合
    const original = [
      '## Day 04',
      '',
      '设 $$I_n = \\int_0^{\\frac{\\pi}{2}} \\sin^n x\\,dx$$：',
      '$$I_n = \\begin{cases}',
      '\\frac{n-1}{n} \\cdots \\frac{1}{2} \\cdot \\frac{\\pi}{2}, & n \\text{ 为正偶数} \\\\',
      '\\frac{n-1}{n} \\cdots \\frac{2}{3} \\cdot 1, & n \\text{ 为正奇数}',
      '\\end{cases}$$',
      '',
      '> **记忆口诀**：偶数乘到半个 $\\pi$。',
      '',
      '### 三、检验',
      '',
      '计算：$$I_1 = \\int_{-1}^{1} x^5 \\cos(x^2)\\,dx$$',
      '',
      '请在草稿纸上作答！',
    ].join('\n')

    const html = renderWithAppPipeline(original)
    expect(hasKatexError(html)).toBe(false)
    // 开栏行的 `I_n = \begin{cases}` 不再被当元信息丢掉
    expect(html).toContain('mtable')
    // 后文没有被吞进公式：标题、列表、收尾句都按 Markdown 渲染
    expect(html).toContain('<h3')
    expect(html).toContain('<blockquote')
    expect(html).toContain('请在草稿纸上作答！')
  })

  it('对照组：不做规范化时同一段内容会渲染出红色错误块（说明修复确实在起作用）', () => {
    const original = [
      '$$I_n = \\begin{cases}',
      '\\frac{n-1}{n}, & n \\text{ 为正偶数} \\\\',
      '\\end{cases}$$',
      '',
      '### 三、检验',
    ].join('\n')

    const broken = renderToStaticMarkup(
      ReactMarkdown({
        remarkPlugins: [remarkGfm, remarkMath],
        rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]],
        children: original,
      }),
    )
    expect(hasKatexError(broken)).toBe(true)
    expect(broken).not.toContain('<h3')

    const fixed = renderWithAppPipeline(original)
    expect(hasKatexError(fixed)).toBe(false)
    expect(fixed).toContain('<h3')
  })

  it('正常内容（单行公式、行内公式、代码块）渲染结果不受影响', () => {
    const normal = [
      '行内 $a^2 + b^2 = c^2$ 与单行块：',
      '',
      '$$\\int_0^1 x\\,dx = \\frac{1}{2}$$',
      '',
      '```js',
      'const a = 1 // $$not math$$',
      '```',
    ].join('\n')

    const html = renderWithAppPipeline(normal)
    expect(hasKatexError(html)).toBe(false)
    expect(html).toContain('katex')
    expect(html).not.toContain('katex-error')
  })
})
