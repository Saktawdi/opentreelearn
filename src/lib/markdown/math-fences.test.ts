import { describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import { renderToStaticMarkup } from 'react-dom/server'
import { normalizeDisplayMath } from './math-fences'
import { normalizeForRender } from './render-source'
import { REMARK_PLUGINS } from './remark-options'

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
      remarkPlugins: REMARK_PLUGINS,
      rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]],
      children: normalizeForRender(content),
    }),
  )
}

/** 对照组：不做规范化，用于确认某段内容「本来就不该被修好」。 */
function renderWithoutNormalization(content: string): string {
  return renderToStaticMarkup(
    ReactMarkdown({
      remarkPlugins: REMARK_PLUGINS,
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

describe('列表项内的块级公式（容器边界）', () => {
  // 用户真实故障：列表项内 3 空格缩进开栏，`\begin{cases}` 与闭合 `$$` 都顶格。
  // 顶格行不是列表续行 → 公式块在项内被掐成空块，顶格 `$$` 又开新块吞到文末 → 红色原文。
  const listCase = [
    '2. **求一阶偏导并令为零**：',
    '   $$',
    '\\begin{cases}',
    "   L'_x = f'_x + \\lambda \\varphi'_x = 0 \\\\",
    "   L'_y = f'_y + \\lambda \\varphi'_y = 0 \\\\",
    "   L'_\\lambda = \\varphi(x, y) = 0",
    '   \\end{cases}',
    '$$',
    '3. **联立解方程组**：求出驻点。',
    '',
    '### 三、检验',
  ].join('\n')

  it('块内缩进不足开栏缩进的行补齐到开栏缩进，撑住列表容器', () => {
    expect(normalizeDisplayMath(listCase)).toBe(
      [
        '2. **求一阶偏导并令为零**：',
        '   $$',
        '   \\begin{cases}',
        "   L'_x = f'_x + \\lambda \\varphi'_x = 0 \\\\",
        "   L'_y = f'_y + \\lambda \\varphi'_y = 0 \\\\",
        "   L'_\\lambda = \\varphi(x, y) = 0",
        '   \\end{cases}',
        '   $$',
        '3. **联立解方程组**：求出驻点。',
        '',
        '### 三、检验',
      ].join('\n'),
    )
    // 幂等
    expect(normalizeDisplayMath(normalizeDisplayMath(listCase))).toBe(normalizeDisplayMath(listCase))
  })

  it('列表内「开栏同行带内容」的公式也走同一修复', () => {
    const input = ['- 第一步：', '   $$x = \\begin{cases}', '   1, & a \\\\', '   \\end{cases}', '$$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      [
        '- 第一步：',
        '   $$',
        '   x = \\begin{cases}',
        '   1, & a \\\\',
        '   \\end{cases}',
        '   $$',
      ].join('\n'),
    )
  })

  it('顶层（非容器）缩进开栏补齐后解析等价，闭合围栏仍在合法缩进内', () => {
    const input = ['   $$', 'x = 1', '$$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(['   $$', '   x = 1', '   $$'].join('\n'))
  })

  it('列表内未闭合的半截公式仍不改写（与不规范化渲染一致）', () => {
    const unclosed = ['2. 第一步：', '   $$', '\\begin{cases}', "   L'_x = 0 \\\\"].join('\n')
    expect(normalizeDisplayMath(unclosed)).toBe(unclosed)
    expect(renderWithAppPipeline(unclosed)).toBe(renderWithoutNormalization(unclosed))
  })

  it('端到端：cases 渲染成功、列表与后文不再被吞', () => {
    const html = renderWithAppPipeline(listCase)
    expect(hasKatexError(html)).toBe(false)
    expect(html).toContain('mtable')
    // 列表延续：第 2、3 项在同一个有序列表里，cases 排在第 2 项内
    expect(html).toContain('<ol start="2">')
    expect(html).toContain('联立解方程组')
    // 后文标题照常渲染，没有被吞进公式
    expect(html).toContain('<h3')
  })

  it('对照组：不规范化时同一段内容渲染出红色错误块（说明修复确实在起作用）', () => {
    const broken = renderWithoutNormalization(listCase)
    expect(hasKatexError(broken)).toBe(true)
    expect(broken).not.toContain('<h3')
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
        remarkPlugins: REMARK_PLUGINS,
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

describe('深层列表与引用块（容器边界第二层）', () => {
  // 两位编号 `10. ` 的内容列是 4 空格、嵌套列表更深 —— 旧版只认 ≤ 3 空格缩进，
  // 这些位置上的模型写法（开栏带内容 / 行尾闭合 / 块内顶格）仍然渲染成红色原文。
  it('两位编号列表（内容列 4 空格）里的模型写法照常修复', () => {
    const input = [
      '10. **求驻点**：',
      '    $$I_n = \\begin{cases}',
      '    \\frac{1}{2}, & n \\\\',
      '    \\end{cases}$$',
      '11. **后文一项**。',
    ].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      [
        '10. **求驻点**：',
        '    $$',
        '    I_n = \\begin{cases}',
        '    \\frac{1}{2}, & n \\\\',
        '    \\end{cases}',
        '    $$',
        '11. **后文一项**。',
      ].join('\n'),
    )
    // 幂等
    expect(normalizeDisplayMath(normalizeDisplayMath(input))).toBe(normalizeDisplayMath(input))
  })

  it('端到端：两位编号 cases 渲染成功、第 11 项不被吞', () => {
    const input = [
      '10. **求驻点**：',
      '    $$I_n = \\begin{cases}',
      '    \\frac{1}{2}, & n \\\\',
      '    \\end{cases}$$',
      '11. **后文一项**。',
    ].join('\n')
    const html = renderWithAppPipeline(input)
    expect(hasKatexError(html)).toBe(false)
    expect(html).toContain('mtable')
    expect(html).toContain('<ol start="10">')
    expect(html).toContain('后文一项')
  })

  it('嵌套列表（二级项内容列 4 空格）补齐到开栏缩进', () => {
    const input = ['- 外层', '  - 内层：', '      $$', 'x = 1', '      $$', '- 后文'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      ['- 外层', '  - 内层：', '      $$', '      x = 1', '      $$', '- 后文'].join('\n'),
    )
  })

  it('标记行直接开栏（- $$）把块内行补齐到内容列', () => {
    const input = ['- $$', '\\begin{cases}', 'x = 1 \\\\', '\\end{cases}', '$$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      ['- $$', '  \\begin{cases}', '  x = 1 \\\\', '  \\end{cases}', '  $$'].join('\n'),
    )
    const html = renderWithAppPipeline(input)
    expect(hasKatexError(html)).toBe(false)
    expect(html).toContain('mtable')
  })

  it('引用块里的模型写法照常修复（每行保持 > 前缀）', () => {
    const input = [
      '> $$I_n = \\begin{cases}',
      '> \\frac{1}{2}, & n \\\\',
      '> \\end{cases}$$',
    ].join('\n')
    expect(normalizeDisplayMath(input)).toBe(
      ['> $$', '> I_n = \\begin{cases}', '> \\frac{1}{2}, & n \\\\', '> \\end{cases}', '> $$'].join(
        '\n',
      ),
    )
    // 幂等
    expect(normalizeDisplayMath(normalizeDisplayMath(input))).toBe(normalizeDisplayMath(input))
    const html = renderWithAppPipeline(input)
    expect(hasKatexError(html)).toBe(false)
    expect(html).toContain('<blockquote')
    expect(html).toContain('mtable')
  })

  it('引用块里有行脱离引用时不改写（块在原文档里本就断开）', () => {
    const input = ['> $$x = 1', '脱队的一行', '> $$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('代码围栏的引用前缀写法（> ```）同样豁免', () => {
    const input = ['> ```latex', '> $$I_n = \\begin{cases}', '> a & b', '> $$', '> ```'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('块中间冒出顶格列表标记时不改写（新项开始，外层块无从闭合）', () => {
    const input = ['- $$', 'x = 1', '- 下一项', '$$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
  })

  it('顶层 4 空格缩进（缩进代码块）仍不动', () => {
    const input = ['    $$', 'x = 1', '    $$'].join('\n')
    expect(normalizeDisplayMath(input)).toBe(input)
  })
})
