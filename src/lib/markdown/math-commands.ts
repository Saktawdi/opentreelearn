/**
 * KaTeX 不支持命令的渲染前归一化。
 *
 * KaTeX 遇到不认识的命令不报错，而是把原始 TeX 以 #cc0000 红字**内联**渲染在公式里
 * （`\centernot\implies` → 红字 `\centernot` + 后面的长箭头正常渲染）。模型生成讲解
 * 时会从 LaTeX 宏包 / MathJax 词表里带出 KaTeX 没有的命令，这里在渲染前替换成
 * KaTeX 支持的等价字形 —— 已落库的旧内容无需改写。
 *
 * 清单按「输出中是否出现 #cc0000」实测（katex 0.16.47）：
 *
 * - `\centernot`（centernot 宏包，居中否定）→ `\not`：`\not\implies` 渲染出斜杠叠在
 *   箭头上的组合字形，正是原命令的意图；
 * - `\nLongrightarrow` / `\nLongleftrightarrow` → `\nRightarrow` / `\nLeftrightarrow`；
 * - `\LongRightarrow`（LaTeX 里不存在、模型易拼出的混合词）→ `\Longrightarrow`；
 * - `\overparen` / `\underparen` → `\overbrace` / `\underbrace`（最近似的支持字形）；
 * - `\mathds` / `\mathbbm`（空心粗体的其他宏包写法）→ `\mathbb`。
 *
 * 不在清单里的：`\middle` 在 `\left...\right` 上下文中合法（裸用才会红字）；
 * `\xleftarrow` / `\mathclap` 等带参数即可正常渲染；`\sout` / `\mapsfrom` 等确实
 * 不支持但没有语义等价的可替换字形，硬换会歪曲含义 —— 宁可留红字提示内容问题。
 * 新增条目先渲染验证替换目标，再补进映射与测试。
 */

import { codeFenceMarker } from './math-fences'

interface CommandFix {
  pattern: RegExp
  replacement: string
}
/** 键须带 `(?![a-zA-Z])` 边界：`\mathbbm` 不能误伤 `\mathbbmss` 这类更长命令。 */
const COMMAND_FIXES: readonly CommandFix[] = [
  { pattern: /\\centernot(?![a-zA-Z])/g, replacement: '\\not' },
  { pattern: /\\nLongleftrightarrow(?![a-zA-Z])/g, replacement: '\\nLeftrightarrow' },
  { pattern: /\\nLongrightarrow(?![a-zA-Z])/g, replacement: '\\nRightarrow' },
  { pattern: /\\LongRightarrow(?![a-zA-Z])/g, replacement: '\\Longrightarrow' },
  { pattern: /\\overparen(?![a-zA-Z])/g, replacement: '\\overbrace' },
  { pattern: /\\underparen(?![a-zA-Z])/g, replacement: '\\underbrace' },
  { pattern: /\\mathds(?![a-zA-Z])/g, replacement: '\\mathbb' },
  { pattern: /\\mathbbm(?![a-zA-Z])/g, replacement: '\\mathbb' },
]

const INLINE_CODE = /`[^`]*`/g

/** 单行内做替换；行内代码 span（`` `…` ``）原样跳过 —— 代码示例里的命令是字面量。 */
function fixLine(line: string): string {
  if (!line.includes('\\')) return line
  const parts: string[] = []
  let last = 0
  for (const match of line.matchAll(INLINE_CODE)) {
    const start = match.index ?? 0
    parts.push(fixSegment(line.slice(last, start)))
    parts.push(match[0])
    last = start + match[0].length
  }
  parts.push(fixSegment(line.slice(last)))
  return parts.join('')
}

function fixSegment(segment: string): string {
  let result = segment
  for (const fix of COMMAND_FIXES) {
    result = result.replace(fix.pattern, fix.replacement)
  }
  return result
}

/**
 * 把 KaTeX 不支持的命令替换成支持的等价写法；代码围栏与行内代码原样输出（幂等）。
 * 输入输出都是整篇正文，与 normalizeDisplayMath 的组合顺序见 render-source.ts（应用唯一入口）。
 */
export function normalizeMathCommands(content: string): string {
  if (!content.includes('\\')) return content

  const output: string[] = []
  // 与 math-fences.ts 同一套围栏判定（含 `>` 引用前缀写法）：代码围栏内部一律不动
  let codeFence: { quote: string; char: string; size: number } | null = null

  for (const line of content.split('\n')) {
    if (codeFence) {
      const marker = codeFenceMarker(line)
      if (
        marker &&
        marker.quote === codeFence.quote &&
        marker.char === codeFence.char &&
        marker.size >= codeFence.size &&
        marker.info.trim() === ''
      ) {
        codeFence = null
      }
      output.push(line)
      continue
    }

    const marker = codeFenceMarker(line)
    if (marker) {
      codeFence = { quote: marker.quote, char: marker.char, size: marker.size }
      output.push(line)
      continue
    }

    output.push(fixLine(line))
  }

  return output.join('\n')
}
