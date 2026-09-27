/**
 * i18n 键位体检：把 src 下所有 t('…') 调用解析到命名空间，
 * 与 locales 下的 JSON 逐个比对，报告「代码里有、资源里缺」的裸键
 * （裸键会在界面上直接显示成 branch.title 这种原文假文案），
 * 以及 zh/en 之间的键位漂移。
 *
 * 两层检查：
 *   1. 静态层：src 下的 t('…') 调用 ↔ 资源文件逐个比对（含复数键与动态键常量）
 *   2. 运行时层：用真 i18next + 真资源把**每一个键**在每一门语言下渲染一遍，
 *      凡是渲染回裸键的都算漏译 —— 这层能直接抓住「branch.* 上屏」这类事故
 *
 * 用法：node scripts/audit-i18n.mjs [--used]
 *   --used  额外列出「资源里有、代码里没静态引用到」的键（死键排查，需人工复核）
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import i18next from 'i18next'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
const LOCALES = join(SRC, 'i18n', 'locales')
const FALLBACK_NS = 'common'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

function flatKeys(obj, prefix = '', out = new Set()) {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k
    if (v && typeof v === 'object' && !Array.isArray(v)) flatKeys(v, key, out)
    else out.add(key)
  }
  return out
}

const locales = {}
const rawResources = {}
for (const lang of readdirSync(LOCALES)) {
  locales[lang] = {}
  rawResources[lang] = {}
  for (const file of readdirSync(join(LOCALES, lang))) {
    const ns = file.replace(/\.json$/, '')
    const raw = JSON.parse(readFileSync(join(LOCALES, lang, file), 'utf8'))
    rawResources[lang][ns] = raw
    locales[lang][ns] = flatKeys(raw)
  }
}
const NS_LIST = Object.keys(locales[Object.keys(locales)[0]])

/** 文件里声明过的命名空间（useTranslation/getFixedT/i18n.t 的第二参等），缺省落 common */
function namespacesOf(src) {
  const found = new Set()
  for (const m of src.matchAll(/useTranslation\(\s*(\[[^\]]*\]|['"`][^'"`]+['"`])/g)) {
    for (const lit of m[1].matchAll(/['"`]([^'"`]+)['"`]/g)) found.add(lit[1])
  }
  for (const m of src.matchAll(/getFixedT\(\s*[^,)]*,\s*['"`]([^'"`]+)['"`]/g)) found.add(m[1])
  // 类型注解：t: TFunction<'projects'> / labelKey: ParseKeys<'common'> / ParseKeys<['a','b']>
  for (const m of src.matchAll(/(?:TFunction|ParseKeys)<\s*(\[[^\]]*\]|'[^']+'|"[^"]+")/g)) {
    for (const lit of m[1].matchAll(/['"]([^'"]+)['"]/g)) found.add(lit[1])
  }
  return found.size ? found : new Set([FALLBACK_NS])
}

/** 提取「只存键名」的常量值：labelKey/hintKey 字段、*_KEY 记录、NAV_ITEMS 之类。 */
function declaredKeyLiterals(src) {
  const out = new Set()
  // 属性名以 Key/key 结尾的赋值
  for (const m of src.matchAll(/\b[A-Za-z_$]*[Kk]ey\s*:\s*'([^']*)'/g)) out.add(m[1])
  // const XXX_KEY: Record<...> = { a: 'x.y', b: 'x.y' } 里的值
  for (const m of src.matchAll(/const\s+[A-Za-z_$]*_?(?:KEY|Key)\b[^=]*=\s*\{([\s\S]*?)\n\}/g)) {
    for (const v of m[1].matchAll(/['"]([a-zA-Z][\w]*(?:\.[\w]+)+)['"]/g)) out.add(v[1])
  }
  // 带显式命名空间前缀的常量值（如 'chat:branch.title'）
  for (const m of src.matchAll(/['"]([a-zA-Z][\w]*:[\w.]+)['"]/g)) out.add(m[1])
  return out
}

function nsFromPrefix(lit) {
  return lit.includes(':') ? lit.slice(0, lit.indexOf(':')) : FALLBACK_NS
}

/**
 * 键是否可解析：i18next 在找不到 `key_other` 时会退回裸键 `key`，
 * 反过来裸键在也不会自动展开成复数形式 —— 两种情况都算「有译文」。
 */
function resolved(nsKeys, key) {
  if (!nsKeys) return false
  if (nsKeys.has(key)) return true
  for (const suffix of ['zero', 'one', 'two', 'few', 'many', 'other']) {
    if (nsKeys.has(`${key}_${suffix}`)) return true
  }
  return false
}

let missing = 0
let drift = 0
const problems = []
const dynamicMissing = []
const referenced = new Map() // ns -> Set(key)
const referencedLoose = new Set() // 仅用于死键排除的宽松引用集（键名，不含 ns）
const dynamicPrefixes = new Set() // 模板拼接键的静态前缀，如 'learning.source.'
const dynamicFiles = new Set()

// 测试文件不在 i18n 迁移范围内（docs/dev/i18n.md），跳过以免噪声
const files = walk(SRC).filter((f) => !/\.test\.tsx?$/.test(f))

for (const file of files) {
  const src = readFileSync(file, 'utf8')
  const rel = relative(ROOT, file)
  const namespaces = namespacesOf(src)

  // t('ns:key') / t('ns:key.deep') 显式命名空间；否则用文件声明的命名空间
  for (const m of src.matchAll(/\bt\(\s*['"`]([^'"`$]+?)['"`]/g)) {
    const raw = m[1]
    let ns = null
    let key = raw
    if (/^[a-zA-Z][\w-]*:/.test(raw)) {
      ns = raw.slice(0, raw.indexOf(':'))
      key = raw.slice(raw.indexOf(':') + 1)
      if (!NS_LIST.includes(ns)) {
        problems.push(`[NS 不存在] ${rel}: t('${raw}') 的命名空间 ${ns} 未在 locales 里定义`)
        missing++
        continue
      }
    }
    // 含 CJK 的"键"来自注释/文档示例，不是真调用
    if (!key || /[\u4e00-\u9fff]/.test(key)) continue
    const candidates = ns ? [ns] : [...namespaces]
    const hit = candidates.find((c) => resolved(locales['zh-CN'][c], key))
    if (!hit) {
      problems.push(
        `[缺键] ${rel}: ${candidates.join('|')} → ${key}  （运行时会显示成「${key}」）`,
      )
      missing++
      continue
    }
    if (!referenced.has(hit)) referenced.set(hit, new Set())
    referenced.get(hit).add(key)
    for (const lang of Object.keys(locales)) {
      if (lang === 'zh-CN') continue
      if (!resolved(locales[lang]?.[hit], key)) {
        problems.push(`[缺 ${lang}] ${rel}: ${hit}.${key}`)
        drift++
      }
    }
  }

  if (/t\(\s*`/.test(src)) dynamicFiles.add(rel)

  // 死键判定用的「宽松引用集」：只要某个字面量出现在 t( ... ) 的同一行、
  // 或者出现在 *KEYS 常量里（可能跨行），就算被引用（宁可漏报死键，不误报）。
  for (const line of src.split('\n')) {
    if (!/\bt\(/.test(line)) continue
    for (const lit of line.matchAll(/['"]([^'"]+)['"]/g)) {
      if (lit[1].includes('.')) referencedLoose.add(lit[1])
    }
  }
  for (const block of src.matchAll(/const\s+[A-Za-z_$]*KEYS\b[^=]*=\s*\[([\s\S]*?)\]/g)) {
    for (const lit of block[1].matchAll(/['"]([^'"]+)['"]/g)) referencedLoose.add(lit[1])
  }
  // 模板拼接的键：t(`learning.source.${kind}`) → 登记前缀 learning.source.，
  // 该前缀下的键都不算死键（具体分支由 kind 的联合类型保证）
  for (const m of src.matchAll(/t\(\s*`([^`$]*)\$\{/g)) {
    if (m[1].includes('.')) dynamicPrefixes.add(m[1].replace(/:$/, ':'))
  }

  // 动态键：模块级常量只存键名，t(`ns:${X}`) / t(item.labelKey) 静态扫描看不到。
  // 这些键一律落 common（见 docs/dev/i18n.md 的「跨命名空间共享词表」）。
  const candidateNs = new Set([...namespaces, FALLBACK_NS])
  for (const lit of declaredKeyLiterals(src)) {
    const prefixed = lit.includes(':')
    const ns = prefixed ? nsFromPrefix(lit) : null
    const key = prefixed ? lit.slice(lit.indexOf(':') + 1) : lit
    if (!key.includes('.')) continue
    const scope = ns ? [ns] : [...candidateNs]
    if (!scope.some((c) => resolved(locales['zh-CN'][c], key))) {
      dynamicMissing.push(`${rel}: 键常量 '${lit}' 在 ${scope.join('|')} 里找不到`)
    } else {
      const hit = scope.find((c) => resolved(locales['zh-CN'][c], key))
      if (!referenced.has(hit)) referenced.set(hit, new Set())
      referenced.get(hit).add(key)
    }
  }
}

console.log('=== 代码引用但资源缺失 / 漂移 ===')
console.log(problems.length ? [...problems].sort().join('\n') : '（无）')
console.log(`\n缺键 ${missing} 条，语言漂移 ${drift} 条`)
if (dynamicFiles.size) {
  console.log(`\n注意：以下文件用了模板串 t(\`…\`)，静态扫描覆盖不到，需人工确认`)
  for (const f of dynamicFiles) console.log(`  ${f}`)
}

// 键位集合层面的漂移：某一语言缺的键（不依赖代码引用，能发现资源文件本身没对齐）
const langs = Object.keys(locales)

/**
 * 各语言的复数类别（i18next 按 Intl.PluralRules 挑后缀：count=1 → `_one`，其余 → `_other`）。
 *
 * 中文只有 other 一类，写裸键就够（任何 count 都能渲染）；英文 one/other 都得写全 ——
 * 少了 `_one` 时 count=1 会静默回退到 fallbackLng（中文），是一类不报错但可见的漏译。
 * 所以比较键集时要按「本语言的类别」判完整，而不是把 `daysAgo` 与 `daysAgo_other`
 * 当成两个不同的键互相报缺（那是形态差异，不是漂移）。
 */
const pluralCategories = new Map(
  langs.map((lang) => [lang, new Intl.PluralRules(lang).resolvedOptions().pluralCategories]),
)

/** 把某语言的键集合归一到 `裸键 → 写了的复数类别集合`（写了裸键则为 null）。 */
function keyIndex(lang, ns) {
  const index = new Map()
  for (const key of locales[lang][ns] ?? []) {
    const match = key.match(/^(.*)_(zero|one|two|few|many|other)$/)
    if (match) {
      const categories = index.get(match[1])
      if (categories instanceof Set) categories.add(match[2])
      else index.set(match[1], new Set([match[2]]))
      continue
    }
    if (!index.has(key)) index.set(key, null)
  }
  return index
}

/** 目标语言能否把这门语言的每个复数类别都渲染出来；返回还缺的类别。 */
function missingCategories(lang, categories) {
  if (categories === null) return [] // 裸键：任何 count 都落得到它
  return (pluralCategories.get(lang) ?? ['other']).filter((c) => !categories.has(c))
}

console.log('\n=== 语言间键位集合漂移（资源文件层面） ===')
let setDrift = 0
const pluralShapes = []
for (const lang of langs) {
  for (const base of langs) {
    if (lang === base) continue
    const lines = []
    for (const ns of NS_LIST) {
      const other = keyIndex(lang, ns)
      for (const [key, categories] of keyIndex(base, ns)) {
        const target = other.get(key)
        const missing =
          target === undefined ? pluralCategories.get(lang) ?? ['other'] : missingCategories(lang, target)
        if (missing.length) {
          lines.push(`${ns}.${key}${target === undefined ? '' : `（缺 _${missing.join('、_')}）`}`)
          continue
        }
        // 一侧裸键、一侧复数形式：都能渲染全，只是形态不同 —— 记录但不计漂移
        if (categories !== null && target === null) {
          pluralShapes.push(`${ns}.${key}：${base} 用复数形式 / ${lang} 用裸键`)
        }
        if (categories === null && target instanceof Set) {
          pluralShapes.push(`${ns}.${key}：${base} 用裸键 / ${lang} 用 _${[...target].sort().join('、_')}`)
        }
      }
    }
    if (lines.length) {
      setDrift += lines.length
      console.log(`\n${lang} 缺少（${base} 有）：`)
      console.log(lines.sort().join('\n'))
    }
  }
}
if (!setDrift) console.log('（无）')
if (pluralShapes.length) {
  console.log('\n复数形态差异（两种写法都能渲染全，不计漂移）：')
  console.log([...new Set(pluralShapes)].sort().join('\n'))
}

console.log('\n=== 动态拼接的键常量 ===')
console.log(dynamicMissing.length ? [...new Set(dynamicMissing)].sort().join('\n') : '（无）')

console.log('\n=== 键位数量概览 ===')
for (const ns of NS_LIST) {
  const zh = locales['zh-CN'][ns]?.size ?? 0
  const en = locales['en'][ns]?.size ?? 0
  const used = referenced.get(ns)?.size ?? 0
  // 原始条数会因复数形式（en 多一个 _one）天然不等：按「裸键」归一后再判是否真不一致
  const zhBase = keyIndex('zh-CN', ns).size
  const enBase = keyIndex('en', ns).size
  console.log(
    `${ns.padEnd(12)} zh=${String(zh).padStart(4)} en=${String(en).padStart(4)} 基础键 zh=${String(zhBase).padStart(4)} en=${String(enBase).padStart(4)} 静态引用=${String(used).padStart(4)}${zhBase === enBase ? '' : '  <-- 中英基础键位数量不一致'}`,
  )
}

// ---------------------------------------------------------------------------
// 运行时层：真 i18next 渲染每一个键，抓裸键
// ---------------------------------------------------------------------------
await i18next.init({
  resources: rawResources,
  fallbackLng: 'zh-CN',
  defaultNS: FALLBACK_NS,
  interpolation: { escapeValue: false },
})

const bareKeys = []
for (const lang of Object.keys(locales)) {
  await i18next.changeLanguage(lang)
  for (const ns of NS_LIST) {
    for (const key of locales[lang][ns]) {
      // 复数键（key_other…）以分隔符存在资源里，真正的调用入口是裸键 + count；
      // 同时也把带后缀的形式直接当键渲染一次（覆盖 _other 本身漏译的情况）
      for (const probe of [key.replace(/_(zero|one|two|few|many|other)$/, ''), key]) {
        const out = i18next.t(`${ns}:${probe}`, {
          count: 1,
          total: 1,
          percent: 1,
          done: 1,
          name: 'x',
          error: 'x',
          date: 'x',
          reason: 'x',
          source: 'x',
          title: 'x',
          time: 'x',
          message: 'x',
          cards: 'x',
          messages: 'x',
          labels: 'x',
          label: 'x',
          preview: 'x',
          index: 1,
          step: 1,
          max: 1,
          removed: 'x',
          notes: 'x',
          notesPart: 'x',
          score: 1,
          band: 'x',
          grade: 'x',
          seconds: 1,
          current: 1,
        })
        if (out === probe || out === `${ns}:${probe}`) bareKeys.push(`${lang} ${ns}:${probe}`)
      }
    }
  }
}
const uniqueBare = [...new Set(bareKeys)]
console.log('\n=== 运行时渲染检查（每个键在每门语言下都不能回吐键名） ===')
console.log(uniqueBare.length ? uniqueBare.sort().join('\n') : '（无裸键）')
console.log(`裸键 ${uniqueBare.length} 处`)

if (process.argv.includes('--used')) {
  console.log('\n=== 资源里有、代码里没引用到（疑似死键，需人工复核） ===')
  const dead = []
  for (const ns of NS_LIST) {
    for (const key of locales['zh-CN'][ns]) {
      // 复数变体（_one/_other…）归到裸键上一起判定
      const base = key.replace(/_(zero|one|two|few|many|other)$/, '')
      if (referenced.get(ns)?.has(key) || referenced.get(ns)?.has(base)) continue
      if (referencedLoose.has(key) || referencedLoose.has(base)) continue
      if ([...dynamicPrefixes].some((p) => key.startsWith(p.replace(/^[\w-]+:/, '')))) continue
      dead.push(`${ns}.${key}`)
    }
  }
  console.log(dead.sort().join('\n'))
}
