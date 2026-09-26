import i18n from '@/i18n'

/**
 * 账号系统、同步服务与 Blog BFF 共用的响应信封。
 *
 * 三处的成功响应都是 `{ code: 0, msg, data }`，失败时 `code` 为 HTTP 状态码、
 * `msg` 可直接展示给用户（`class-validator` 的校验失败会取第一条）。
 * 抽出来是为了让账号客户端与同步客户端共用同一套解析与错误类型 ——
 * 前端只学一种错误形状，401 的刷新重试也只有一条路径。
 */
export interface ApiEnvelope<T> {
  code: number
  msg?: string
  data?: T
  /** 登录与刷新 token 时位于响应根对象。 */
  token?: string
}

export class ApiError extends Error {
  readonly code: number

  constructor(message: string, code: number) {
    super(message)
    this.name = 'ApiError'
    this.code = code
  }
}

/** 解析信封：非 0 业务码一律转成带原始 `msg` 的错误。 */
export function interpretEnvelope<T>(payload: unknown, httpStatus: number): ApiEnvelope<T> {
  if (!payload || typeof payload !== 'object') {
    throw new ApiError(i18n.t('common:errors.envelopeUnparseable', { status: httpStatus }), httpStatus)
  }

  const envelope = payload as ApiEnvelope<T>
  const code = typeof envelope.code === 'number' ? envelope.code : httpStatus
  if (code !== 0) {
    throw new ApiError(
      envelope.msg?.trim() || i18n.t('common:errors.envelopeFailed', { code }),
      code,
    )
  }
  return envelope
}

/** 把响应体读成 JSON；不是 JSON（网关错误页等）就退回 null 交给 interpretEnvelope 报状态码。 */
export async function readJson(response: Response): Promise<unknown> {
  const raw = await response.text()
  if (!raw) return null
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}