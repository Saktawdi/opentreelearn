#!/usr/bin/env node
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const port = Number(process.env.PORT ?? process.argv[2] ?? 8787)

const DROP_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'content-length',
  'accept-encoding',
  'keep-alive',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'origin',
  'referer',
])

const DROP_RESPONSE_HEADERS = new Set([
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
])

function applyCorsHeaders(response) {
  response.setHeader('Access-Control-Allow-Origin', '*')
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS')
  response.setHeader('Access-Control-Allow-Headers', '*')
  response.setHeader('Access-Control-Expose-Headers', '*')
  response.setHeader('Access-Control-Max-Age', '86400')
}

function fail(response, status, message) {
  if (response.headersSent) {
    response.end()
    return
  }
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify({ error: { message, type: 'proxy_error' } }))
}

const server = createServer(async (request, response) => {
  applyCorsHeaders(response)

  if (request.method === 'OPTIONS') {
    response.writeHead(204)
    response.end()
    return
  }

  if (request.url === '/__ping' || request.url === '/') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
    response.end(
      JSON.stringify({ ok: true, service: 'opentreelearn-cors-proxy', port }),
    )
    return
  }

  const target = request.url.slice(1)
  if (!/^https?:\/\//i.test(target)) {
    fail(
      response,
      400,
      '目标地址格式不正确。请使用 http://localhost:' +
        port +
        '/https://your-endpoint/v1/chat/completions 这种形式。',
    )
    return
  }

  const controller = new AbortController()
  request.on('close', () => controller.abort())

  const headers = {}
  for (const [key, value] of Object.entries(request.headers)) {
    if (DROP_REQUEST_HEADERS.has(key.toLowerCase())) continue
    if (typeof value === 'string') headers[key] = value
  }

  const hasBody = request.method !== 'GET' && request.method !== 'HEAD'

  try {
    const upstream = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? Readable.toWeb(request) : undefined,
      duplex: hasBody ? 'half' : undefined,
      redirect: 'follow',
      signal: controller.signal,
    })

    const responseHeaders = {}
    for (const [key, value] of upstream.headers) {
      if (DROP_RESPONSE_HEADERS.has(key.toLowerCase())) continue
      responseHeaders[key] = value
    }

    response.writeHead(upstream.status, responseHeaders)

    if (upstream.body) {
      await pipeline(Readable.fromWeb(upstream.body), response)
    } else {
      response.end()
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      fail(response, 499, '客户端已取消请求')
      return
    }
    fail(response, 502, `代理转发失败：${error instanceof Error ? error.message : String(error)}`)
  }
})

server.listen(port, () => {
  console.log(`[cors-proxy] 监听 http://localhost:${port}`)
  console.log(`[cors-proxy] 用法：把 Base URL 设为 http://localhost:${port}/<原始 Base URL>`)
  console.log(`[cors-proxy] 例如：http://localhost:${port}/https://api.deepseek.com/v1`)
})