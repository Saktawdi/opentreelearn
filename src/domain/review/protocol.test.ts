import { describe, expect, it } from 'vitest'
import { parseReviewRating, stripReviewRating, stripStreamingReviewRating } from './protocol'

describe('parseReviewRating', () => {
  it('reads the last judgement when several markers exist', () => {
    expect(parseReviewRating('先猜 [[rating:hard]]，但答得不错 [[rating:good]]')).toBe('good')
  })

  it('is tolerant about spacing and case', () => {
    expect(parseReviewRating('[[ Rating : EASY ]]')).toBe('easy')
    expect(parseReviewRating('[[rating:again]]')).toBe('again')
  })

  it('returns null without a marker', () => {
    expect(parseReviewRating('答得不错，继续保持')).toBeNull()
    expect(parseReviewRating('[[rating:unknown]]')).toBeNull()
  })
})

describe('stripReviewRating', () => {
  it('removes the marker and the blank line it leaves behind', () => {
    const text = '先复述定义，再想反例。\n\n[[rating:good]]'
    expect(stripReviewRating(text)).toBe('先复述定义，再想反例。')
  })

  it('keeps the rest of the answer intact', () => {
    expect(stripReviewRating('a\n[[rating:hard]]\nb')).toBe('a\nb')
  })

  it('leaves plain text untouched', () => {
    expect(stripReviewRating('没有标记的回答')).toBe('没有标记的回答')
  })
})

describe('stripStreamingReviewRating', () => {
  it('hides a half-written marker while the answer streams', () => {
    expect(stripStreamingReviewRating('答得不错。\n\n[[')).toBe('答得不错。')
    expect(stripStreamingReviewRating('答得不错。\n\n[[rating:go')).toBe('答得不错。')
  })

  it('does not eat ordinary text with double brackets', () => {
    expect(stripStreamingReviewRating('区间写作 [[0, 1]]，闭区间')).toBe('区间写作 [[0, 1]]，闭区间')
  })
})