/**
 * 同源代理的契约散在三处：浏览器侧常量（src/services/llm/proxy.ts）、开发/预览中间件
 * （vite.config.ts）、生产 nginx（docker/nginx.conf）。任何一处单独改动都会静默失灵 ——
 * 开发一切正常、线上 404 或者反过来。这里把三处钉在一起。
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { LLM_PROXY_PATH, LLM_PROXY_TARGET_HEADER } from './proxy'

const viteConfig = readFileSync(new URL('../../../vite.config.ts', import.meta.url), 'utf8')
const nginxConf = readFileSync(new URL('../../../docker/nginx.conf', import.meta.url), 'utf8')

describe('同源代理契约', () => {
  it('路径在三处一致', () => {
    expect(LLM_PROXY_PATH).toBe('/api-proxy')
    expect(viteConfig).toContain(`const LLM_PROXY_PATH = '${LLM_PROXY_PATH}'`)
    expect(nginxConf).toContain(`location = ${LLM_PROXY_PATH} {`)
  })

  it('目标请求头在三处一致', () => {
    expect(LLM_PROXY_TARGET_HEADER).toBe('x-llm-proxy-target')
    expect(viteConfig).toContain(`const LLM_PROXY_TARGET_HEADER = '${LLM_PROXY_TARGET_HEADER}'`)
    // nginx 用下划线形式引用请求头变量
    expect(nginxConf).toContain(`$http_${LLM_PROXY_TARGET_HEADER.replaceAll('-', '_')}`)
  })

  it('nginx 侧保住流式与动态解析的关键指令', () => {
    // 变量形式的 proxy_pass 必须有 resolver，否则域名不解析
    expect(nginxConf).toMatch(/resolver\s+\S+/)
    // SSE 必须关缓冲，否则会攒满才吐字
    expect(nginxConf).toMatch(/proxy_buffering\s+off/)
    // 目标头的值不能用 $arg_ 传（nginx 不还原百分号编码）
    expect(nginxConf).not.toContain('$arg_url')
  })

  it('没有把内部目标头转发给上游', () => {
    expect(nginxConf).toMatch(/proxy_set_header\s+X-Llm-Proxy-Target\s+"";/)
  })
})
