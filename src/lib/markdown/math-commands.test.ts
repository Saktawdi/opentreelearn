import { describe, expect, it } from 'vitest'
import { normalizeMathCommands } from './math-commands'

describe('normalizeMathCommands', () => {
  it('截图场景：centernot 与箭头连用替换为 KaTeX 支持的组合否定', () => {
    const input = '偏导存在 $\\centernot\\implies$ 连续'
    expect(normalizeMathCommands(input)).toBe('偏导存在 $\\not\\implies$ 连续')
  })

  it('不带反斜杠目标的边界：更长命令不被误伤', () => {
    expect(normalizeMathCommands('$\\mathbbmss{R}$')).toBe('$\\mathbbmss{R}$')
    expect(normalizeMathCommands('$\\centernotation$')).toBe('$\\centernotation$')
  })

  it('整表替换：其余六个命令各自落位', () => {
    expect(normalizeMathCommands('$\\nLongrightarrow$')).toBe('$\\nRightarrow$')
    expect(normalizeMathCommands('$\\nLongleftrightarrow$')).toBe('$\\nLeftrightarrow$')
    expect(normalizeMathCommands('$\\LongRightarrow$')).toBe('$\\Longrightarrow$')
    expect(normalizeMathCommands('$\\overparen{AB}$')).toBe('$\\overbrace{AB}$')
    expect(normalizeMathCommands('$\\underparen{AB}$')).toBe('$\\underbrace{AB}$')
    expect(normalizeMathCommands('$\\mathds{N}$')).toBe('$\\mathbb{N}$')
    expect(normalizeMathCommands('$\\mathbbm{R}$')).toBe('$\\mathbb{R}$')
  })

  it('代码围栏内部不动', () => {
    const input = '```tex\n\\centernot\\implies\n```'
    expect(normalizeMathCommands(input)).toBe(input)
  })

  it('行内代码 span 内不动', () => {
    const input = '写法见 `\\centernot\\implies` 这一段'
    expect(normalizeMathCommands(input)).toBe(input)
  })

  it('同一行公式与行内代码并存：只改公式侧', () => {
    const input = '记号 `X` 与 $\\centernot\\implies$ 同行'
    expect(normalizeMathCommands(input)).toBe('记号 `X` 与 $\\not\\implies$ 同行')
  })

  it('幂等：替换结果再过一遍不变', () => {
    const once = normalizeMathCommands('$\\centernot\\implies$ 与 $\\mathbbm{R}$')
    expect(normalizeMathCommands(once)).toBe(once)
  })

  it('无关内容原样返回（含普通反斜杠文本）', () => {
    const input = '\\begin{cases} 用于讲解的普通文字，不含目标命令 \\end{cases}'
    expect(normalizeMathCommands(input)).toBe(input)
  })
})
