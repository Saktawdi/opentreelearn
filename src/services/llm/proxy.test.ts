import { describe, expect, it } from 'vitest'
import {
  LLM_PROXY_PATH,
  LLM_PROXY_TARGET_HEADER,
  isLocalOrPrivateUrl,
  toProxyRequestUrl,
} from './proxy'

const ORIGIN = 'https://learn.sakta.top'

describe('toProxyRequestUrl', () => {
  it('把跨域的绝对地址改写成同源代理', () => {
    expect(toProxyRequestUrl('https://newapi.sakta.top/v1/chat/completions', ORIGIN)).toBe(
      `${ORIGIN}${LLM_PROXY_PATH}`,
    )
  })

  it('带查询串与转义字符的地址也照改（目标另放请求头，不参与 URL 编码）', () => {
    const target = 'https://newapi.sakta.top/v1beta/models/gemini:streamGenerateContent?alt=sse&x=a%2Fb'
    expect(toProxyRequestUrl(target, ORIGIN)).toBe(`${ORIGIN}${LLM_PROXY_PATH}`)
  })

  it('同源地址原样放行，避免自己代理自己', () => {
    expect(toProxyRequestUrl(`${ORIGIN}/api-proxy`, ORIGIN)).toBe(`${ORIGIN}/api-proxy`)
    expect(toProxyRequestUrl(`${ORIGIN}/lern-api/sync/pull`, ORIGIN)).toBe(
      `${ORIGIN}/lern-api/sync/pull`,
    )
  })

  it('相对地址与非 http(s) 地址原样放行', () => {
    expect(toProxyRequestUrl('/lern-api/health', ORIGIN)).toBe('/lern-api/health')
    expect(toProxyRequestUrl('data:text/plain,hi', ORIGIN)).toBe('data:text/plain,hi')
  })

  it('拿不到 origin（file:// 等）时不做改写', () => {
    expect(toProxyRequestUrl('https://newapi.sakta.top/v1/chat/completions', null)).toBe(
      'https://newapi.sakta.top/v1/chat/completions',
    )
  })

  it('只把「同源 + 路径」当同源，前缀相同但不同主机不算', () => {
    expect(toProxyRequestUrl('https://learn.sakta.top.evil.com/v1', ORIGIN)).toBe(
      `${ORIGIN}${LLM_PROXY_PATH}`,
    )
  })
})

describe('isLocalOrPrivateUrl', () => {
  it('环回、私网、链路本地与容器内短名都算本机/内网', () => {
    for (const url of [
      'http://localhost:1234/v1/chat/completions',
      'http://127.0.0.1:11434/v1/chat/completions',
      'http://[::1]:8080/v1',
      'http://0.0.0.0:8000/v1',
      'http://10.1.2.3/v1',
      'http://192.168.1.50:1234/v1',
      'http://172.16.0.9/v1',
      'http://172.31.255.1/v1',
      'http://169.254.169.254/latest/meta-data',
      'http://api:3901/api/health',
      'http://ollama/v1',
      'http://box.local:1234/v1',
    ]) {
      expect(isLocalOrPrivateUrl(url), url).toBe(true)
    }
  })

  it('公网域名与公网 IP 照常走代理', () => {
    for (const url of [
      'https://newapi.sakta.top/v1/chat/completions',
      'https://api.openai.com/v1/chat/completions',
      'https://generativelanguage.googleapis.com/v1beta/models',
      'http://8.8.8.8/v1',
      'http://172.32.0.1/v1', // 172.16–172.31 之外是公网
      'http://11.0.0.1/v1',
      'http://localhost.evil.com/v1', // 只是域名里带 localhost，不属于本机
    ]) {
      expect(isLocalOrPrivateUrl(url), url).toBe(false)
    }
  })
})

describe('createLlmProxyFetch', () => {
  it('本机推理服务直连，不改写地址', async () => {
    const calls: string[] = []
    const originalWindow = globalThis.window
    const originalFetch = globalThis.fetch
    Object.defineProperty(globalThis, 'window', {
      value: { location: { protocol: 'https:', origin: ORIGIN } },
      configurable: true,
    })
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      calls.push(input instanceof Request ? input.url : String(input))
      return new Response('ok')
    }) as unknown as typeof fetch

    try {
      const { createLlmProxyFetch } = await import('./proxy')
      await createLlmProxyFetch()('http://localhost:1234/v1/chat/completions')

      expect(calls).toHaveLength(1)
      expect(calls[0]).toBe('http://localhost:1234/v1/chat/completions')
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    }
  })

  it('改写地址并把真实目标放进请求头，请求体流式透传', async () => {
    const calls: { url: string; init: RequestInit }[] = []
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response('ok')
    }) as unknown as typeof fetch

    const originalWindow = globalThis.window
    const originalFetch = globalThis.fetch
    // 只 stub 出被读到的字段，避免为了一个纯函数去搭 DOM 环境
    Object.defineProperty(globalThis, 'window', {
      value: { location: { protocol: 'https:', origin: ORIGIN } },
      configurable: true,
    })
    globalThis.fetch = fakeFetch

    try {
      const { createLlmProxyFetch } = await import('./proxy')
      const proxyFetch = createLlmProxyFetch()
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{}'))
          controller.close()
        },
      })

      await proxyFetch('https://newapi.sakta.top/v1/chat/completions', {
        method: 'POST',
        headers: { authorization: 'Bearer sk-test', 'content-type': 'application/json' },
        body,
      })

      expect(calls).toHaveLength(1)
      expect(calls[0].url).toBe(`${ORIGIN}${LLM_PROXY_PATH}`)
      const headers = new Headers(calls[0].init.headers)
      expect(headers.get(LLM_PROXY_TARGET_HEADER)).toBe(
        'https://newapi.sakta.top/v1/chat/completions',
      )
      // 密钥等原始头必须原样保留，上游就是靠它鉴权的
      expect(headers.get('authorization')).toBe('Bearer sk-test')
      expect(calls[0].init.method).toBe('POST')
      // 流式请求体要带 half duplex，否则浏览器拒绝发送
      expect((calls[0].init as { duplex?: string }).duplex).toBe('half')
    } finally {
      globalThis.fetch = originalFetch
      Object.defineProperty(globalThis, 'window', { value: originalWindow, configurable: true })
    }
  })
})
