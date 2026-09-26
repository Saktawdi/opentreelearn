import i18n from 'i18next'
import LanguageDetector from 'i18next-browser-languagedetector'
import { initReactI18next } from 'react-i18next'
import { resources } from './resources'

// 资源是静态打包内联的：v26 对内联 resources 直接同步完成 init，
// <Suspense> 与翻译闪烁（FOUC）都不存在；检测（localStorage/navigator）也是同步的。
i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    supportedLngs: ['zh-CN', 'en'],
    // 'en-US' 之类的地区变体折叠到 'en'；'zh' 之类的裸语言码落不中就交给 fallbackLng
    nonExplicitSupportedLngs: true,
    fallbackLng: 'zh-CN',
    detection: {
      // 用户显式选过的语言存 localStorage，优先于浏览器偏好
      order: ['localStorage', 'navigator'],
      lookupLocalStorage: 'ootl.lang',
      caches: ['localStorage'],
    },
    interpolation: {
      // React 自带转义，交给它
      escapeValue: false,
    },
  })

export default i18n
