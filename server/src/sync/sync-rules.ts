/**
 * 同步协议里可单独测试的纯规则。放这里而不是散在 service 里，
 * 是因为这几条（LWW 判定、分页、载荷上限）是协议正确性的核心。
 */

export const DEFAULT_PULL_LIMIT = 200
export const MAX_PULL_LIMIT = 1000
export const MAX_PUSH_CHANGES = 200
/** 单条记录的 JSON 载荷上限；消息正文 + 图片引用远小于它 */
export const MAX_RECORD_JSON_BYTES = 256 * 1024

export function clampPullLimit(limit?: number): number {
  if (!limit || !Number.isFinite(limit)) return DEFAULT_PULL_LIMIT
  return Math.min(Math.max(Math.trunc(limit), 1), MAX_PULL_LIMIT)
}

/**
 * last-write-wins 判定。
 *
 * 相等也判旧（stale）：客户端重推同一批数据时（上一次响应丢了）会拿到同一个结论，
 * 不会把同一条记录反复写成新 rev —— push 因此是幂等的。
 */
export function decideWrite(
  storedUpdatedAt: number | null | undefined,
  incomingUpdatedAt: number,
): 'applied' | 'stale' {
  if (storedUpdatedAt === null || storedUpdatedAt === undefined) return 'applied'
  return incomingUpdatedAt > storedUpdatedAt ? 'applied' : 'stale'
}

/** 读载荷；损坏的 JSON 退回空对象，不让一条坏数据打断整次 pull。 */
export function parseRecordData(raw: string): unknown {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed && typeof parsed === 'object') return parsed
    return {}
  } catch {
    return {}
  }
}

/** 记录载荷的 UTF-8 字节数（用于上限校验）。 */
export function recordByteLength(data: unknown): number {
  if (data === undefined || data === null) return 0
  return Buffer.byteLength(JSON.stringify(data) ?? '', 'utf8')
}

/** 多取一条来判断还有没有下一页。 */
export function slicePage<T>(rows: T[], limit: number): { items: T[]; hasMore: boolean } {
  const hasMore = rows.length > limit
  return { items: hasMore ? rows.slice(0, limit) : rows, hasMore }
}