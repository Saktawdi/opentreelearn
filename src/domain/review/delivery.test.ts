import { describe, expect, it } from 'vitest'
import type { Id } from '@/domain/models'
import type { ReviewSessionItem, ReviewSessionMessage } from './session'
import {
  canGiveHint,
  canPoseQuestion,
  canSubmitFeedback,
  canTeachKeyPoints,
  currentOpenQuestion,
  latestQuestion,
  phaseAfterDelivery,
  reAskCount,
} from './delivery'

let seq = 0

function message(
  role: 'user' | 'assistant',
  purpose: ReviewSessionMessage['purpose'],
): ReviewSessionMessage {
  seq += 1
  return { id: `m${seq}` as Id, role, text: `t${seq}`, purpose, createdAt: seq }
}

function makeItem(
  mode: 'review' | 'relearn',
  messages: ReviewSessionMessage[],
): ReviewSessionItem {
  seq += 1
  return {
    itemId: `i${seq}` as Id,
    nodeId: `n${seq}` as Id,
    title: '主题',
    mode,
    phase: 'answering',
    messages,
    updatedAt: seq,
  }
}

describe('currentOpenQuestion', () => {
  it('没有题目时为 null', () => {
    const item = makeItem('review', [])
    expect(currentOpenQuestion(item)).toBeNull()
  })

  it('题目未回答时开放', () => {
    const q = message('assistant', 'question')
    const item = makeItem('review', [q, message('assistant', 'hint')])
    expect(currentOpenQuestion(item)?.id).toBe(q.id)
  })

  it('回答之后闭合；hint 不影响开放性', () => {
    const q = message('assistant', 'question')
    const item = makeItem('review', [
      q,
      message('assistant', 'hint'),
      message('user', 'answer'),
    ])
    expect(currentOpenQuestion(item)).toBeNull()
  })

  it('多道题时取最后一道未被回答的', () => {
    const q1 = message('assistant', 'question')
    const q2 = message('assistant', 'question')
    const item = makeItem('review', [
      q1,
      message('user', 'answer'),
      q2,
      message('assistant', 'hint'),
    ])
    expect(currentOpenQuestion(item)?.id).toBe(q2.id)
  })

  it('followup 用户消息不闭合开放题', () => {
    const q = message('assistant', 'question')
    const item = makeItem('review', [q, message('user', 'followup')])
    expect(currentOpenQuestion(item)?.id).toBe(q.id)
  })
})

describe('latestQuestion', () => {
  it('取最后一道 question，无论是否已回答', () => {
    const q1 = message('assistant', 'question')
    const q2 = message('assistant', 'question')
    const item = makeItem('review', [q1, message('user', 'answer'), q2])
    expect(latestQuestion(item)?.id).toBe(q2.id)
  })
})

describe('canPoseQuestion', () => {
  it('没有开放题时允许新出题', () => {
    const item = makeItem('review', [])
    expect(canPoseQuestion(item)).toEqual({ ok: true })
  })

  it('已有开放题时拒绝新出题', () => {
    const q = message('assistant', 'question')
    const item = makeItem('review', [q])
    expect(canPoseQuestion(item).ok).toBe(false)
  })

  it('换问法必须指向当前开放题', () => {
    const q1 = message('assistant', 'question')
    const q2 = message('assistant', 'question')
    const item = makeItem('review', [q1, message('user', 'answer'), q2])
    expect(canPoseQuestion(item, q2.id)).toEqual({ ok: true })
    expect(canPoseQuestion(item, q1.id).ok).toBe(false)
    expect(canPoseQuestion(makeItem('review', []), q1.id).ok).toBe(false)
  })

  it('补学主题没有讲解之前不允许出题（确认闸门）', () => {
    const item = makeItem('relearn', [])
    expect(canPoseQuestion(item).ok).toBe(false)
    const taught = makeItem('relearn', [message('assistant', 'relearn')])
    expect(canPoseQuestion(taught)).toEqual({ ok: true })
  })
})

describe('canGiveHint', () => {
  it('有开放题才允许提示', () => {
    const open = makeItem('review', [message('assistant', 'question')])
    expect(canGiveHint(open)).toEqual({ ok: true })
    const closed = makeItem('review', [
      message('assistant', 'question'),
      message('user', 'answer'),
    ])
    expect(canGiveHint(closed).ok).toBe(false)
  })
})

describe('canSubmitFeedback', () => {
  it('最后一条用户消息是回答时允许', () => {
    const item = makeItem('review', [
      message('assistant', 'question'),
      message('user', 'answer'),
    ])
    expect(canSubmitFeedback(item)).toEqual({ ok: true })
  })

  it('追问也允许判定（followup 链路）', () => {
    const item = makeItem('review', [
      message('assistant', 'question'),
      message('user', 'answer'),
      message('assistant', 'answer'),
      message('user', 'followup'),
    ])
    expect(canSubmitFeedback(item)).toEqual({ ok: true })
  })

  it('没有回答时拒绝', () => {
    expect(canSubmitFeedback(makeItem('review', [message('assistant', 'question')])).ok).toBe(false)
    expect(canSubmitFeedback(makeItem('review', [])).ok).toBe(false)
  })
})

describe('canTeachKeyPoints', () => {
  it('补学主题、转录为空时允许', () => {
    expect(canTeachKeyPoints(makeItem('relearn', []))).toEqual({ ok: true })
  })

  it('复习主题拒绝；已交付过拒绝', () => {
    expect(canTeachKeyPoints(makeItem('review', [])).ok).toBe(false)
    expect(canTeachKeyPoints(makeItem('relearn', [message('assistant', 'relearn')])).ok).toBe(false)
  })
})

describe('reAskCount', () => {
  it('只数回答之后出现的题目', () => {
    const item = makeItem('review', [
      message('assistant', 'question'),
      message('user', 'answer'),
      message('assistant', 'question'),
      message('user', 'answer'),
      message('assistant', 'question'),
    ])
    expect(reAskCount(item)).toBe(2)
  })

  it('首次出题不计入', () => {
    const item = makeItem('review', [message('assistant', 'question')])
    expect(reAskCount(item)).toBe(0)
  })
})

describe('phaseAfterDelivery', () => {
  it('各交付类型映射到对应阶段', () => {
    expect(phaseAfterDelivery('relearn')).toBe('relearning')
    expect(phaseAfterDelivery('question')).toBe('answering')
    expect(phaseAfterDelivery('hint')).toBe('answering')
    expect(phaseAfterDelivery('feedback')).toBe('feedback')
  })
})
