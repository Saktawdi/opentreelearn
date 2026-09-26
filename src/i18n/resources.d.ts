import type common from './locales/zh-CN/common.json'

declare module 'i18next' {
  interface CustomTypeOptions {
    defaultNS: 'common'
    // 以 zh-CN 资源为键的类型源头：en 缺 key、t() 写错 key 都会在编译期报错
    resources: {
      common: typeof common
    }
  }
}
