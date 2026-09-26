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
    // 不设 supportedLngs：靠资源包层级回退即可——'en-US'→en，'zh'/'zh-TW'→zh-CN，
    // 其余语言全部落 fallbackLng。（实测 v26 里 supportedLngs+nonExplicitSupportedLngs
    // 组合会让 t() 解析失效，返回裸键。）
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

// <html lang> 跟随当前语言（可访问性/拼写检查依赖它）；
// node 测试环境没有 document，跳过
if (typeof document !== 'undefined') {
  const syncDocLang = (lng: string) => {
    document.documentElement.lang = lng
  }
  i18n.on('languageChanged', syncDocLang)
  syncDocLang(i18n.language)
}

export default i18n
