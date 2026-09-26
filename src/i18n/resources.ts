import commonEn from './locales/en/common.json'
import commonZh from './locales/zh-CN/common.json'

/**
 * 语言资源静态打包：两份语言全量随 bundle 加载（体量小，不值得按语言做懒加载分包）。
 * zh-CN 是源语言（key 的类型声明以它为准），en 是第一门目标语言。
 * 新增语言：加 locales/<code>/ 目录 + 在这里挂一个条目 + supportedLngs 放行，见 docs/i18n.md。
 */
export const resources = {
  'zh-CN': { common: commonZh },
  en: { common: commonEn },
} as const

export type AppLocale = keyof typeof resources
export const SUPPORTED_LOCALES = Object.keys(resources) as AppLocale[]
