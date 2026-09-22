/**
 * 浏览器侧的 LLM 同源代理：把送往厂商接口的请求改写成同源的 `/api-proxy`，由服务端（开发是
 * Vite 中间件，生产是 nginx）去访问上游。
 *
 * 为什么不直连：自建中转（new-api / one-api）常只在预检和错误响应上带
 * `Access-Control-Allow-Origin`，真正那条流式回答不带 —— 上游日志显示「成功且有输出」，
 * 浏览器却抛 `No 'Access-Control-Allow-Origin' header`，请求发出去了、响应被拦下来了。
 * 同源之后浏览器根本不参与跨域判定，流式 SSE 也不会再被拦。
 *
 * 目标地址放在请求头里（`x-llm-proxy-target`）而不是查询串：nginx 的 `$arg_*` 不还原百分号
 * 编码（见 ngx_http_arg 源码），地址里带 `%2F` 之类的转义就会原样送给上游而打不开；请求头是
 * 逐个字节原样透传的，没有这一层。
 */
export const LLM_PROXY_PATH = '/api-proxy'

/** 目标上游地址。值就是浏览器本来要请求的那个绝对地址，原样不编码。 */
export const LLM_PROXY_TARGET_HEADER = 'x-llm-proxy-target'

/** 只有 http(s) 页面才谈得上同源代理：`file://` 下 `window.location.origin` 是 "null"。 */
export function browserOrigin(): string | null {
  if (typeof window === 'undefined') return null
  const { protocol, origin } = window.location
  return protocol === 'http:' || protocol === 'https:' ? origin : null
}

/** 相对地址（本来就同源）与非 http(s) 地址原样放行；已同源的地址不再套一层，避免递归。 */
export function toProxyRequestUrl(requestUrl: string, origin: string | null): string {
  if (!origin) return requestUrl
  if (!/^https?:\/\//i.test(requestUrl)) return requestUrl
  if (requestUrl === origin || requestUrl.startsWith(`${origin}/`)) return requestUrl
  return `${origin}${LLM_PROXY_PATH}`
}

/**
 * 本机 / 局域网地址不走代理，交给浏览器直连。
 *
 * 两个原因：用户自建的推理服务（LM Studio、Ollama、局域网里的 one-api）就在本地，绕一圈到
 * 服务端反而更远；而服务端那一侧为了不变成内网探测跳板，本来就会拒掉环回与私网目标
 * （见 docker/nginx.conf）。走直连时行为与本改动之前完全一致。
 */
export function isLocalOrPrivateUrl(requestUrl: string): boolean {
  let host: string
  try {
    host = new URL(requestUrl).hostname.toLowerCase()
  } catch {
    return false
  }

  // URL 会把 IPv6 的主机名保留成 [::1] 这种带方括号的形式
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host

  if (bare === 'localhost' || bare === '::1' || bare === '0.0.0.0' || bare === '') return true
  if (bare.endsWith('.localhost') || bare.endsWith('.local') || bare.endsWith('.internal')) return true

  // IPv4 环回 / 私网 / 链路本地
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(bare)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 127 ||
      a === 10 ||
      (a === 192 && b === 168) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 169 && b === 254)
    )
  }

  // fd00::/8 与 fe80::/10（唯一本地地址、链路本地）
  if (/^f[cd][0-9a-f]{2}:/.test(bare) || /^fe[89ab][0-9a-f]:/.test(bare)) return true

  // 不带点的短主机名多是容器网络里的服务名，同样交给浏览器（它自己也解析不了）
  if (!bare.includes('.')) return true

  return false
}

/**
 * 解析请求地址和请求头，但保留 SDK 传进来的原始 body。
 *
 * 不要只从 `Request.body` 取 body 再交给下一次 fetch：在部分浏览器/开发代理组合里，这会把
 * 原本的 JSON 字符串变成一个已经被消费的空流，最终只剩下
 * `Content-Type: application/json`，上游 Fastify 就会报 FST_ERR_CTP_EMPTY_JSON_BODY。
 */
function makeRequest(
  input: RequestInfo | URL,
  init?: RequestInit,
): { request: Request; body: BodyInit | null | undefined } {
  if (input instanceof Request && !init) {
    return { request: input, body: input.body }
  }

  const merged: RequestInit & { duplex?: 'half' } = { ...init }
  // 流式请求体必须显式声明 half duplex；`duplex` 目前不在 TS 的 DOM 类型里（vite.config.ts 同样处理）
  if (merged.body && !merged.duplex) merged.duplex = 'half'

  return { request: new Request(input, merged), body: init?.body }
}

/**
 * 交给四个厂商适配包的自定义 fetch。
 *
 * 注意这里**不改 baseURL**：四家的 SDK 都接受 `fetch` 选项，而 openai 兼容系会直接在 baseURL
 * 后面拼路径（`new URL(`${baseURL}${path}`)`），把代理路径混进 baseURL 会拼出非法地址。改在
 * 请求出站这一层替换地址，就没有「谁负责拼串」的问题，也不影响 SDK 自己加的自定义头
 * （如 Google 的 `x-goog-api-key`）。
 *
 * 地址本来就同源时不改写：部署侧没配代理（例如把 dist 直接丢给静态托管）时行为与从前一致。
 */
export function createLlmProxyFetch(): typeof fetch {
  return async (input, init) => {
    const origin = browserOrigin()
    if (!origin) return fetch(input, init)

    const { request, body } = makeRequest(input, init)
    const proxyUrl = toProxyRequestUrl(request.url, origin)
    if (proxyUrl === request.url) return fetch(request)
    // 本机 / 局域网推理服务直连（服务端会拒掉私网目标，见 isLocalOrPrivateUrl）
    if (isLocalOrPrivateUrl(request.url)) return fetch(request)
    // 已经是代理地址（带上目标头）就别再套一层，否则会自己代理自己
    if (request.headers.has(LLM_PROXY_TARGET_HEADER)) return fetch(request)

    const headers = new Headers(request.headers)
    headers.set(LLM_PROXY_TARGET_HEADER, request.url)

    return fetch(proxyUrl, {
      method: request.method,
      headers,
      // 保留 SDK 原始的 JSON body；request.body 是一次性流，不能作为可靠的中转源。
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : body,
      // 请求体走流式透传，需要 half duplex（同上：类型里还没有这个字段）
      duplex: body ? 'half' : undefined,
      signal: request.signal,
    } as RequestInit & { duplex: 'half' })
  }
}
