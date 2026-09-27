/**
 * 残留中文文案扫描：找出组件/共享层里还没走 i18n 的用户可见中文
 * （排除注释、console、测试，以及 docs/dev/i18n.md 声明「不迁」的 LLM prompt 目录）。
 * 用法：node scripts/scan-hardcoded-cjk.mjs
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SRC = join(ROOT, 'src')
// 按 docs/dev/i18n.md：这些目录的中文是发给 LLM 的提示词/上下文，保持原样
const SKIP_DIRS = ['src/domain/context/', 'src/services/llm/']
const SKIP_FILES = new Set(['src/domain/notes.ts']) // 双轨字段：中文口径喂 AI + 导出

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx)$/.test(n)) out.push(p)
  }
  return out
}

/** 粗略剥掉注释，保留字符串字面量 */
function stripComments(src) {
  let out = ''
  let i = 0
  let quote = null
  while (i < src.length) {
    const c = src[i]
    const next = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') {
        out += src[i + 1] ?? ''
        i += 2
        continue
      }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c
      out += c
      i++
      continue
    }
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') {
        out += ' '
        i++
      }
      continue
    }
    if (c === '/' && next === '*') {
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        out += src[i] === '\n' ? '\n' : ' '
        i++
      }
      out += '  '
      i += 2
      continue
    }
    out += c
    i++
  }
  return out
}

const CJK = /[\u4e00-\u9fff]/
const hits = []
for (const f of walk(SRC)) {
  const rel = relative(ROOT, f).replace(/\\/g, '/')
  if (rel.startsWith('src/i18n/')) continue
  if (/\.test\./.test(rel)) continue
  if (SKIP_DIRS.some((d) => rel.startsWith(d))) continue
  if (SKIP_FILES.has(rel)) continue
  const src = stripComments(readFileSync(f, 'utf8'))
  src.split('\n').forEach((line, i) => {
    if (!CJK.test(line)) return
    if (/console\.(log|warn|error|info|debug)/.test(line)) return
    hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 150)}`)
  })
}

console.log(`候选残留中文（需人工判断是 UI 文案还是数据结构/标识符）：${hits.length} 处\n`)
console.log(hits.join('\n'))
