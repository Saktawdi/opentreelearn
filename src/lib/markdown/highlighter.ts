import {
  createHighlighterCore,
  type HighlighterCore,
  type LanguageRegistration,
} from 'shiki/core'
import { createOnigurumaEngine } from 'shiki/engine/oniguruma'
import githubDarkDefault from 'shiki/themes/github-dark-default.mjs'

export const CODE_THEME = 'github-dark-default'

type LanguageModule = { default: LanguageRegistration[] }

const LANGUAGE_LOADERS: Record<string, () => Promise<LanguageModule>> = {
  javascript: () => import('shiki/langs/javascript.mjs'),
  typescript: () => import('shiki/langs/typescript.mjs'),
  tsx: () => import('shiki/langs/tsx.mjs'),
  jsx: () => import('shiki/langs/jsx.mjs'),
  python: () => import('shiki/langs/python.mjs'),
  java: () => import('shiki/langs/java.mjs'),
  c: () => import('shiki/langs/c.mjs'),
  cpp: () => import('shiki/langs/cpp.mjs'),
  csharp: () => import('shiki/langs/csharp.mjs'),
  go: () => import('shiki/langs/go.mjs'),
  rust: () => import('shiki/langs/rust.mjs'),
  sql: () => import('shiki/langs/sql.mjs'),
  bash: () => import('shiki/langs/bash.mjs'),
  shell: () => import('shiki/langs/shell.mjs'),
  json: () => import('shiki/langs/json.mjs'),
  yaml: () => import('shiki/langs/yaml.mjs'),
  toml: () => import('shiki/langs/toml.mjs'),
  markdown: () => import('shiki/langs/markdown.mjs'),
  html: () => import('shiki/langs/html.mjs'),
  css: () => import('shiki/langs/css.mjs'),
  r: () => import('shiki/langs/r.mjs'),
  php: () => import('shiki/langs/php.mjs'),
  ruby: () => import('shiki/langs/ruby.mjs'),
  kotlin: () => import('shiki/langs/kotlin.mjs'),
  swift: () => import('shiki/langs/swift.mjs'),
  scala: () => import('shiki/langs/scala.mjs'),
  lua: () => import('shiki/langs/lua.mjs'),
  matlab: () => import('shiki/langs/matlab.mjs'),
  julia: () => import('shiki/langs/julia.mjs'),
  haskell: () => import('shiki/langs/haskell.mjs'),
  elixir: () => import('shiki/langs/elixir.mjs'),
  dart: () => import('shiki/langs/dart.mjs'),
  latex: () => import('shiki/langs/latex.mjs'),
  tex: () => import('shiki/langs/tex.mjs'),
  diff: () => import('shiki/langs/diff.mjs'),
  dockerfile: () => import('shiki/langs/dockerfile.mjs'),
  xml: () => import('shiki/langs/xml.mjs'),
  graphql: () => import('shiki/langs/graphql.mjs'),
  powershell: () => import('shiki/langs/powershell.mjs'),
  makefile: () => import('shiki/langs/makefile.mjs'),
}

let highlighterPromise: Promise<HighlighterCore> | null = null

export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [githubDarkDefault],
      langs: Object.values(LANGUAGE_LOADERS).map((load) => load()),
      engine: createOnigurumaEngine(import('shiki/wasm')),
    }).catch((error: unknown) => {
      highlighterPromise = null
      throw error
    })
  }
  return highlighterPromise
}

export async function highlightCode(code: string, language?: string): Promise<string> {
  const highlighter = await getHighlighter()
  const normalized = (language ?? '').toLowerCase()
  const loaded = highlighter.getLoadedLanguages()
  const resolved = loaded.includes(normalized) ? normalized : 'text'

  return highlighter.codeToHtml(code, { lang: resolved, theme: CODE_THEME })
}