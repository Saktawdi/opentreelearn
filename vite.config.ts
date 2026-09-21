/// <reference types="vitest/config" />
import { fileURLToPath, URL } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

function apiProxyPlugin(): Plugin {
  return {
    name: 'api-proxy-plugin',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        if (!req.url?.startsWith('/api-proxy/')) {
          return next()
        }

        const rawTarget = req.url.slice('/api-proxy/'.length)
        if (!/^https?:\/\//i.test(rawTarget)) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'Invalid target URL' }))
          return
        }

        const dropReqHeaders = new Set([
          'host',
          'connection',
          'content-length',
          'accept-encoding',
          'keep-alive',
          'upgrade',
          'origin',
          'referer',
        ])

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
          const upstream = await fetch(rawTarget, fetchOptions)

          const dropResHeaders = new Set([
            'content-encoding',
            'content-length',
            'transfer-encoding',
            'connection',
            'keep-alive',
          ])

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
      })
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