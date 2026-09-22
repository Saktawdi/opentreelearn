/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * 与 `src/services/llm/proxy.ts` 和 `docker/nginx.conf` 必须一致的两处约定。
 *
 * 这里刻意写字面量而不 import 应用源码：vite.config.ts 是构建配置，不该依赖 src/；源码改坏时
 * 也不该连带把 dev server 拖下水。三处是否仍然一致由
 * `src/services/llm/proxy.contract.test.ts` 断言（它同时读这两个文件）。
 */
const LLM_PROXY_PATH = '/api-proxy'
const LLM_PROXY_TARGET_HEADER = 'x-llm-proxy-target'

/**
 * 开发/预览用的同源 LLM 代理：`/api-proxy` + 请求头 `x-llm-proxy-target: <绝对地址>` → 该地址。
 *
 * 契约与生产用的 `docker/nginx.conf` 里那段 `location = /api-proxy` 一致，前端只认这一个
 * 路径，开发与线上走同一条路（为什么用请求头而不是查询串见 src/services/llm/proxy.ts）。
 */
function apiProxyMiddleware(): (
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
) => void {
  const dropReqHeaders = new Set([
    'host',
    'connection',
    'content-length',
    'accept-encoding',
    'keep-alive',
    'upgrade',
    'origin',
    'referer',
    LLM_PROXY_TARGET_HEADER,
  ])

  const dropResHeaders = new Set([
    'content-encoding',
    'content-length',
    'transfer-encoding',
    'connection',
    'keep-alive',
  ])

  return async (req, res, next) => {
    const parsed = new URL(req.url ?? '', 'http://localhost')
    if (parsed.pathname !== LLM_PROXY_PATH) {
      return next()
    }

    const targetHeader = req.headers[LLM_PROXY_TARGET_HEADER]
    const target = Array.isArray(targetHeader) ? targetHeader[0] : targetHeader
    if (!target || !/^https?:\/\//i.test(target)) {
      res.statusCode = 400
      res.setHeader('content-type', 'application/json; charset=utf-8')
      res.end(
        JSON.stringify({ error: `api-proxy 需要 ${LLM_PROXY_TARGET_HEADER}: <http(s) 绝对地址>` }),
      )
      return
    }

    const headers: Record<string, string> = {}
    for (const [key, val] of Object.entries(req.headers)) {
      if (dropReqHeaders.has(key.toLowerCase())) continue
      if (typeof val === 'string') headers[key] = val
    }

    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const controller = new AbortController()
    res.on('close', () => {
      if (!res.writableFinished) {
        controller.abort()
      }
    })

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fetchOptions: any = {
        method: req.method,
        headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: hasBody ? 'half' : undefined,
        redirect: 'follow',
        signal: controller.signal,
      }
      const upstream = await fetch(target, fetchOptions)

      res.statusCode = upstream.status
      for (const [key, val] of upstream.headers) {
        if (dropResHeaders.has(key.toLowerCase())) continue
        res.setHeader(key, val)
      }

      // 注入 CORS 头以防同源或跨域端口访问
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Headers', '*')

      if (upstream.body) {
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          await pipeline(Readable.fromWeb(upstream.body as any), res)
        } catch (err) {
          if (
            res.writableFinished ||
            (err && typeof err === 'object' && 'code' in err && err.code === 'ERR_STREAM_PREMATURE_CLOSE')
          ) {
            return
          }
          throw err
        }
      } else {
        res.end()
      }
    } catch (err) {
      if (!res.headersSent) {
        res.statusCode = 502
        res.setHeader('content-type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ error: String(err) }))
      }
    }
  }
}

function apiProxyPlugin(): Plugin {
  const middleware = apiProxyMiddleware()
  return {
    name: 'api-proxy-plugin',
    configureServer(server) {
      server.middlewares.use(middleware)
    },
    // `vite preview` 不走 configureServer，补一处才能用产物在本地联调
    configurePreviewServer(server) {
      server.middlewares.use(middleware)
    },
  }
}

export default defineConfig({
  plugins: [react(), tailwindcss(), apiProxyPlugin()],
  server: {
    port: 6174,
    proxy: {
      // 同步服务（server/，默认 3901）。走同源代理，开发时不必依赖 CORS。
      // 生产部署同样把 /lern-api 反代到该服务即可（见 docs/design.md 第 13 节）。
      '/lern-api': {
        target: 'http://localhost:3901',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lern-api/, '/api'),
      },
    },
  },
  preview: {
    port: 6174,
    proxy: {
      '/lern-api': {
        target: 'http://localhost:3901',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/lern-api/, '/api'),
      },
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
