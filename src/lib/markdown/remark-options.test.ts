import { describe, expect, it } from 'vitest'
import ReactMarkdown from 'react-markdown'
import rehypeKatex from 'rehype-katex'
import remarkGfm from 'remark-gfm'
import { renderToStaticMarkup } from 'react-dom/server'
import { REMARK_PLUGINS } from './remark-options'

/**
 * `singleTilde: false` 的回归。
 *
 * 真实故障：监督员提醒里的 `（Day 1~7）**以及**…（Day 8~10）` 被划掉一大段 ——
 * remark-gfm 默认把单个 `~` 当删除线分隔符，两个范围连接号之间的内容全进了 <del>，
 * 连中间的粗体边界一起吃掉。学习笔记里的单个 `~` 几乎全是 `Day 1~7`、`第 3~5 章`
 * 这类范围写法，所以必须关掉 singleTilde。
 */

function renderWith(plugins: Parameters<typeof ReactMarkdown>[0]['remarkPlugins'], content: string) {
  return renderToStaticMarkup(
    ReactMarkdown({
      remarkPlugins: plugins,
      rehypePlugins: [[rehypeKatex, { throwOnError: false, strict: false, output: 'html' }]],
      children: content,
    }),
  )
}

const hasKatexError = (html: string) => html.includes('katex-error')

describe('单个波浪线不做删除线', () => {
  it('监督员提醒原文：范围连接号与粗体都保持原样', () => {
    const html = renderWith(
      REMARK_PLUGINS,
      '你已经完成了**一元积分学全部内容（Day 1~7）**以及**多元函数微分学的大部分内容（Day 8~10）**。',
    )
    expect(html).not.toContain('<del')
    expect(html).toContain('（Day 1~7）')
    expect(html).toContain('（Day 8~10）')
    // 两处粗体都在：粗体边界没有被删除线吃掉
    expect(html.match(/<strong>/g)?.length).toBe(2)
  })

  it('实验数据里的 ~ 近似号不被当成删除线', () => {
    const html = renderWith(REMARK_PLUGINS, '测得 $\\ln 2 \\approx 0.693$，与理论值 ~0.693 一致')
    expect(html).not.toContain('<del')
    expect(html).toContain('~0.693')
  })

  it('标准 ~~删除线~~ 双波浪线仍然生效', () => {
    const html = renderWith(REMARK_PLUGINS, '这是~~删除线~~文字')
    expect(html).toContain('<del>删除线</del>')
  })

  it('对照组：默认 singleTilde 会把范围连接号之间的内容划掉（说明修复确实在起作用）', () => {
    const broken = renderWith(
      [remarkGfm],
      '完成了**一元积分学全部内容（Day 1~7）**以及**多元函数微分学的大部分内容（Day 8~10）**。',
    )
    expect(broken).toContain('<del>')
  })

  it('公式里的 ~ 不受影响（行内代码与数学块豁免）', () => {
    const html = renderWith(
      REMARK_PLUGINS,
      ['行内 $a~b$ 与块级：', '', '$$', 'x \\sim y~z', '$$', '', '`a~b` 代码'].join('\n'),
    )
    expect(html).not.toContain('<del')
    expect(hasKatexError(html)).toBe(false)
  })
})
