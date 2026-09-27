/**
 * remark 插件表：应用渲染与测试共用同一份配置，避免两边悄悄漂移。
 *
 * `singleTilde: false` 是有意为之：remark-gfm 默认把**单个** `~` 也当删除线分隔符，
 * 而学习笔记里单个 `~` 几乎全是范围连接号（`Day 1~7`、`第 3~5 章`）。默认行为会把
 * `**…（Day 1~7）**以及…（Day 8~10）**` 里从第一个 `~` 到下一个 `~` 的整段划进
 * <del>，顺带吃掉中间所有粗体边界。删除线仍保留标准的 `~~…~~` 双波浪线写法。
 */
import type { Options } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export const REMARK_PLUGINS: NonNullable<Options['remarkPlugins']> = [
  [remarkGfm, { singleTilde: false }],
  remarkMath,
]
