import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

/**
 * KaTeX 从 0.17 起给布局辅助类加了 `katex-` 前缀（`.base` → `.katex-base`、
 * `.strut` → `.katex-strut`、`.root` → `.katex-root`、`.vbox` → `.katex-vbox`）。
 *
 * 这份 HTML 由 rehype-katex 用它**自己的** katex 依赖渲染，而应用只导入
 * `katex/dist/katex.min.css`；两个版本一旦错开，这些定位类就匹配不到任何规则：
 * 根号被推歪、大算子变宽、公式盒整体偏高 —— 全是静默的，控制台不会有任何报错。
 * 所以只能靠这条不变量在安装阶段把它拦住。
 */
const require = createRequire(import.meta.url)

/** 应用实际加载的样式表版本（node_modules/katex 即 `katex/dist/katex.min.css` 的来源）。 */
const styleVersion: string = require('katex/package.json').version
/** rehype-katex 内部渲染 HTML 所用的版本，从它自己的目录解析。 */
const rendererVersion: string = createRequire(require.resolve('rehype-katex'))(
  'katex/package.json',
).version

const minor = (version: string) => version.split('.').slice(0, 2).join('.')

describe('KaTeX 样式表与渲染器', () => {
  it('次版本一致，保证生成的类名都能匹配到样式', () => {
    expect(
      minor(styleVersion),
      `样式表 katex@${styleVersion} 与 rehype-katex 用的 katex@${rendererVersion} 不同次版本，` +
        '类名方案不一致会导致公式排版静默错位；请把 package.json 里的 katex 对齐到 rehype-katex 的版本。',
    ).toBe(minor(rendererVersion))
  })
})
