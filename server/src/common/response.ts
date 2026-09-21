export interface ApiEnvelope<T> {
  code: number
  msg: string
  data: T
}

/**
 * 成功响应统一包成 `{ code, msg, data }`，与账号系统、Blog BFF 保持同一形状 ——
 * 客户端只有一套信封解析逻辑（见 src/services/account/client.ts 的 interpretEnvelope）。
 */
export function ok<T>(data: T, msg = '操作成功'): ApiEnvelope<T> {
  return { code: 0, msg, data }
}