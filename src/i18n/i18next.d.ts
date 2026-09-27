import type canvas from './locales/zh-CN/canvas.json'
import type chat from './locales/zh-CN/chat.json'
import type common from './locales/zh-CN/common.json'
import type components from './locales/zh-CN/components.json'
import type me from './locales/zh-CN/me.json'
import type projects from './locales/zh-CN/projects.json'
import type review from './locales/zh-CN/review.json'
import type settings from './locales/zh-CN/settings.json'

/**
 * t() 的键类型来源（以 zh-CN 资源为准）：en 缺 key、t() 写错 key 都在编译期报错。
 *
 * ⚠️ 两条必须守住的前提，任一失效这份声明就是摆设（历史上都失效过）：
 *
 * 1. **文件名**。不能叫 `resources.d.ts` —— 同目录有 `resources.ts` 时，TS 会把它
 *    当成后者的声明文件静默丢弃，`declare module` 根本不加载，于是 `t('随便写')`
 *    畅通无阻，`branch.*` 这类裸键直接上屏。保持 `i18next.d.ts`，别与同目录
 *    `.ts` 同名。
 * 2. **strictKeyChecks**。i18next v26 默认 `false`，那只有 `enableSelector` 才校验键；
 *    显式打开后 t() 才真的要求键存在于 resources 里。
 *
 * 自测：故意 t() 一个资源里不存在的键（随便编一个），`pnpm typecheck` 必须报 TS2345。
 * 体检：`pnpm i18n:audit`（静态扫描 + 真 i18next 逐键渲染，覆盖模板串与动态键常量）。
 */
declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    strictKeyChecks: true
    resources: {
      common: typeof common
      components: typeof components
      projects: typeof projects
      review: typeof review
      canvas: typeof canvas
      settings: typeof settings
      me: typeof me
      chat: typeof chat
    }
  }
}
