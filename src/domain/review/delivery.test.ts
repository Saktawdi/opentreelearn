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
  phaseFromTranscript,
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

  it('复习主题起点拒绝；已交付过拒绝', () => {
    expect(canTeachKeyPoints(makeItem('review', [])).ok).toBe(false)
    expect(canTeachKeyPoints(makeItem('relearn', [message('assistant', 'relearn')])).ok).toBe(false)
  })

  it('反馈轮补讲：有回答就允许，复习主题同样成立', () => {
    const answered = makeItem('review', [
      message('assistant', 'question'),
      message('user', 'answer'),
    ])
    expect(canTeachKeyPoints(answered, { afterFeedback: true })).toEqual({ ok: true })
    const relearnAnswered = makeItem('relearn', [
      message('assistant', 'relearn'),
      message('assistant', 'question'),
      message('user', 'answer'),
    ])
    expect(canTeachKeyPoints(relearnAnswered, { afterFeedback: true }).ok).toBe(true)
  })

  it('反馈轮补讲：没有回答时拒绝', () => {
    const noAnswer = makeItem('review', [message('assistant', 'question')])
    expect(canTeachKeyPoints(noAnswer, { afterFeedback: true }).ok).toBe(false)
  })
})

describe('canPoseQuestion 反馈后重问（阶段 3）', () => {
  function answeredItem(selectedGrade?: 'again' | 'hard' | 'good' | 'easy', reasks = 0) {
    const messages = [message('assistant', 'question'), message('user', 'answer')]
    for (let i = 0; i < reasks; i += 1) {
      messages.push(message('assistant', 'question'), message('user', 'answer'))
    }
    const item = makeItem('review', messages)
    return { ...item, ...(selectedGrade ? { selectedGrade } : {}) }
  }

  it('先有点评（selectedGrade）才允许再问', () => {
    expect(canPoseQuestion(answeredItem(undefined)).ok).toBe(false)
  })

  it('只有答得吃力才值得再问', () => {
    expect(canPoseQuestion(answeredItem('again'))).toEqual({ ok: true })
    expect(canPoseQuestion(answeredItem('hard')).ok).toBe(true)
    expect(canPoseQuestion(answeredItem('good')).ok).toBe(false)
    expect(canPoseQuestion(answeredItem('easy')).ok).toBe(false)
  })

  it('重问次数到上限后拒绝', () => {
    expect(canPoseQuestion(answeredItem('again', 1)).ok).toBe(true)
    expect(canPoseQuestion(answeredItem('again', 2)).ok).toBe(false)
  })

  it('首次出题（无回答）不受重问节流影响', () => {
    expect(canPoseQuestion(makeItem('review', []))).toEqual({ ok: true })
  })
})

describe('phaseFromTranscript', () => {
  it('复刻旧管线的阶段流转', () => {
    expect(phaseFromTranscript([message('assistant', 'relearn')])).toBe('relearning')
    expect(
      phaseFromTranscript([message('assistant', 'relearn'), message('assistant', 'question')]),
    ).toBe('answering')
    expect(
      phaseFromTranscript([
        message('assistant', 'question'),
        message('user', 'answer'),
      ]),
    ).toBe('evaluating')
    expect(
      phaseFromTranscript([
        message('assistant', 'question'),
        message('user', 'answer'),
        message('assistant', 'answer'),
      ]),
    ).toBe('feedback')
    expect(
      phaseFromTranscript([message('assistant', 'question'), message('assistant', 'hint')]),
    ).toBe('answering')
  })

  it('反馈轮合并：点评 → 补讲 → 再问 的阶段链', () => {
    const messages = [
      message('assistant', 'question'),
      message('user', 'answer'),
      message('assistant', 'answer'),
      message('assistant', 'relearn'),
    ]
    expect(phaseFromTranscript(messages)).toBe('feedback')
    messages.push(message('assistant', 'question'))
    expect(phaseFromTranscript(messages)).toBe('answering')
  })

  it('用户 followup 不把阶段从 feedback 推走', () => {
    const messages = [
      message('assistant', 'question'),
      message('user', 'answer'),
      message('assistant', 'answer'),
      message('user', 'followup'),
    ]
    expect(phaseFromTranscript(messages)).toBe('feedback')
  })

  it('空转录是 preparing', () => {
    expect(phaseFromTranscript([])).toBe('preparing')
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

