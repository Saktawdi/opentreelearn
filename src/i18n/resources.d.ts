import type canvas from './locales/zh-CN/canvas.json'
import type chat from './locales/zh-CN/chat.json'
import type common from './locales/zh-CN/common.json'
import type components from './locales/zh-CN/components.json'
import type me from './locales/zh-CN/me.json'
import type projects from './locales/zh-CN/projects.json'
import type review from './locales/zh-CN/review.json'
import type settings from './locales/zh-CN/settings.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    // 以 zh-CN 资源为键的类型源头：en 缺 key、t() 写错 key 都会在编译期报错
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
