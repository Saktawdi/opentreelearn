import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PULL_LIMIT,
  MAX_PULL_LIMIT,
  clampPullLimit,
  decideWrite,
  parseRecordData,
  recordByteLength,
  slicePage,
} from './sync-rules'

describe('clampPullLimit', () => {
  it('缺省与非法值都退回默认页大小', () => {
    expect(clampPullLimit()).toBe(DEFAULT_PULL_LIMIT)
    expect(clampPullLimit(0)).toBe(DEFAULT_PULL_LIMIT)
    expect(clampPullLimit(Number.NaN)).toBe(DEFAULT_PULL_LIMIT)
  })

  it('超过上限时收敛到上限，小于 1 时收敛到 1', () => {
    expect(clampPullLimit(5000)).toBe(MAX_PULL_LIMIT)
    expect(clampPullLimit(-10)).toBe(1)
    expect(clampPullLimit(250.7)).toBe(250)
  })
})

describe('decideWrite', () => {
  it('没有旧记录时接受', () => {
    expect(decideWrite(null, 1000)).toBe('applied')
    expect(decideWrite(undefined, 1000)).toBe('applied')
  })

  it('新记录时间更晚才接受', () => {
    expect(decideWrite(1000, 1001)).toBe('applied')
  })

  it('相等或更旧都判 stale，保证重推幂等', () => {
    expect(decideWrite(1000, 1000)).toBe('stale')
    expect(decideWrite(1000, 999)).toBe('stale')
  })
})

describe('parseRecordData', () => {
  it('正常 JSON 对象原样返回', () => {
    expect(parseRecordData('{"title":"极限"}')).toEqual({ title: '极限' })
  })

  it('损坏的 JSON 与非对象退回空对象', () => {
    expect(parseRecordData('{oops')).toEqual({})
    expect(parseRecordData('null')).toEqual({})
    expect(parseRecordData('"text"')).toEqual({})
  })
})

describe('recordByteLength', () => {
  it('空载荷算 0 字节，中文按 UTF-8 计 3 字节', () => {
    expect(recordByteLength(undefined)).toBe(0)
    expect(recordByteLength({ a: '中' })).toBe(Buffer.byteLength('{"a":"中"}', 'utf8'))
  })
})

describe('slicePage', () => {
  it('多取到的那条只用来判断 hasMore，不进结果', () => {
    expect(slicePage([1, 2, 3], 2)).toEqual({ items: [1, 2], hasMore: true })
    expect(slicePage([1, 2], 2)).toEqual({ items: [1, 2], hasMore: false })
  })
})