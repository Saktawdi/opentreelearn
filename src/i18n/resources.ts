import canvasEn from './locales/en/canvas.json'
import chatEn from './locales/en/chat.json'
import commonEn from './locales/en/common.json'
import componentsEn from './locales/en/components.json'
import meEn from './locales/en/me.json'
import projectsEn from './locales/en/projects.json'
import reviewEn from './locales/en/review.json'
import settingsEn from './locales/en/settings.json'
import canvasZh from './locales/zh-CN/canvas.json'
import chatZh from './locales/zh-CN/chat.json'
import commonZh from './locales/zh-CN/common.json'
import componentsZh from './locales/zh-CN/components.json'
import meZh from './locales/zh-CN/me.json'
import projectsZh from './locales/zh-CN/projects.json'
import reviewZh from './locales/zh-CN/review.json'
import settingsZh from './locales/zh-CN/settings.json'

/**
 * 语言资源静态打包：两份语言全量随 bundle 加载（体量小，不值得按语言做懒加载分包）。
 * zh-CN 是源语言（key 的类型声明以它为准），en 是第一门目标语言。
 * 命名空间与 feature 目录一一对应：common 是跨页面共用文案（导航/共享操作），
 * 其余见 docs/i18n.md。新增语言：加 locales/<code>/ 目录 + 在这里挂条目 + supportedLngs 放行。
 */
export const resources = {
  'zh-CN': {
    common: commonZh,
    components: componentsZh,
    projects: projectsZh,
    review: reviewZh,
    canvas: canvasZh,
    settings: settingsZh,
    me: meZh,
    chat: chatZh,
  },
  en: {
    common: commonEn,
    components: componentsEn,
    projects: projectsEn,
    review: reviewEn,
    canvas: canvasEn,
    settings: settingsEn,
    me: meEn,
    chat: chatEn,
  },
} as const

export type AppLocale = keyof typeof resources
export const SUPPORTED_LOCALES = Object.keys(resources) as AppLocale[]
