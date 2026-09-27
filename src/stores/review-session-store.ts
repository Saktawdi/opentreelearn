import type { ParseKeys } from 'i18next'
import { create } from 'zustand'
import i18n from '@/i18n'
import { getRepositories } from '@/data'
import type { Id, Node, Note, ReviewGrade } from '@/domain/models'
import {
  advanceAfter,
  canConfirm,
  createReviewSession,
  currentItem,
  endSessionWithPending,
  isReadableSession,
  patchItem,
  pauseSession,
  recoverSession,
  resumeSession,
  seedsFromQueue,
  settlePendingItems,
  undoableItem,
  type ReviewItemPhase,
  type ReviewRequestPurpose,
  type ReviewReturnTarget,
  type ReviewSessionItem,
  type ReviewSessionMessage,
  type ReviewSessionRecord,
} from '@/domain/review/session'
import {
  canGiveHint,
  canPoseQuestion,
  canSubmitFeedback,
  canTeachKeyPoints,
  phaseFromTranscript,
} from '@/domain/review/delivery'
import { buildReviewQueue, type ReviewQueueItem } from '@/domain/review/queue'
import { suggestionFromMessages } from '@/domain/review/protocol'
import { noteOrigin } from '@/domain/notes'
import { loadAssetUrls } from '@/services/images'
import { threadPathFingerprint, resolveThread } from '@/domain/thread/resolve'
import { ancestorsOf, buildTreeIndex } from '@/domain/tree/tree'
import { runReviewRequest } from '@/services/llm/review'
import { buildReadOnlyTools } from '@/services/llm/tools/registry'
import type { ReviewDeliveryHandlers } from '@/services/llm/tools/review-delivery'
import { newId } from '@/lib/id'
import { useSettingsStore } from './settings-store'

/**
 * 复习会话的 UI 状态与请求生命周期。
 *
 * **与普通聊天彻底隔离**：普通聊天在 `workspace-store`，复习在这里。
 * 离开复习、切换模式、切账号时这里的请求与 streaming 会被彻底清理，
 * 绝不会污染普通对话的可见路径与历史版本。
 *
 * 状态分两层：
 * - `session`：持久化在 Dexie 里的领域文档（包含每个主题的题目、回答、草稿与确认结果）；
 * - `streaming`：内存里的流式状态，刷新与跨端不落库。
 */

export interface ReviewStreamingState {
  itemId: Id
  requestId: Id
  purpose: ReviewRequestPurpose
  text: string
  startedAt: number
  /** 本轮产物已通过交付工具落库：旁白可以停了，卡片已经就位 */
  delivered?: boolean
  /** 本轮发生过的只读检索（活动行）；交付工具不计入 —— 卡片本身就是它的展示 */
  activities?: Array<{ name: string; label: string }>
}

interface ReviewSessionStoreState {
  projectId: Id | null
  session: ReviewSessionRecord | null
  loading: boolean
  error: string | null
  /** 资料面板是否展开（桌面右侧抽屉，窄屏覆盖） */
  sourceOpen: boolean
  /** 笔记历史面板是否展开；与资料面板互斥 —— 同时开两块抽屉会把主舞台挤没 */
  noteHistoryOpen: boolean
  streaming: ReviewStreamingState | null
  /** 撤销评分后的短暂持久条；用户可以随时点撤销，不是自动消失的 toast */
  lastUndoneNotice: string | null

  /** 进入复习模式：载入未完成会话或指定会话 */
  loadForProject: (projectId: Id, targetSessionId?: Id) => Promise<ReviewSessionRecord | null>
  /** 开始一批新的复习（概览页点击「开始这 N 个」） */
  startBatch: (params: {
    projectId: Id
    items: ReviewQueueItem[]
    nodes: Node[]
    returnTo?: ReviewReturnTarget
  }) => Promise<ReviewSessionRecord | null>
  /** 单主题切入（从节点详情页点「复习这个主题」）：严格创建单主题会话 */
  startSingle: (params: {
    projectId: Id
    nodeId: Id
    nodes: Node[]
    returnTo?: ReviewReturnTarget
  }) => Promise<ReviewSessionRecord | null>
  /** 自动推进当前项：没有题目则自动出题，处在补学则进入补学出题 */
  ensureCurrentItemContent: () => Promise<void>
  /** 保存输入草稿（输入时防抖调用） */
  saveDraft: (text: string) => Promise<void>
  /** 提交回答并请求反馈；作答图片已在 UI 侧落成 assets，这里只带 id */
  submitAnswer: (answer: string, imageIds?: Id[]) => Promise<void>
  /** 要提示 */
  requestHint: () => Promise<void>
  /** 换个问法 */
  requestRephrase: () => Promise<void>
  /** 暂时想不起来：请求讲解并直接切入自评 */
  requestGiveUp: () => Promise<void>
  /** 补学准备好了：出一道复述题 */
  confirmRelearnReady: () => Promise<void>
  /** 追问反馈 */
  askFollowup: (question: string) => Promise<void>
  /** 选择档位（只改预览与暂存，不写入排期） */
  selectGrade: (grade: ReviewGrade) => void
  /** 明确点击「确认并继续」：原子写入排期、推进到下一主题 */
  confirmCurrentGrade: () => Promise<boolean>
  /** 跳过当前项：不改掌握度、不推进排期 */
  skipCurrent: (reason?: string) => Promise<void>
  /** 撤销最近一次评分 */
  undoLastConfirmed: () => Promise<boolean>
  /** 恢复暂停中的会话 */
  resumeSession: () => Promise<void>
  /** 稍后继续：保存当前进度并回到学习 */
  pauseAndLeave: () => Promise<void>
  /** 结束本次：保留已确认结果，剩余项记为未完成 */
  endSession: () => Promise<void>
  /** 停止当前正在生成的模型请求 */
  stopStreaming: () => void
  /** 打开/关闭资料面板 */
  toggleSource: () => void
  setSourceOpen: (open: boolean) => void
  /** 打开/关闭笔记历史面板 */
  toggleNoteHistory: () => void
  setNoteHistoryOpen: (open: boolean) => void
  clearError: () => void
  clearNotice: () => void
  reset: () => void
}

let reviewAbort: AbortController | null = null

/** 补学确认后请求复述题的固定触发语：确认与失败重试必须走同一句；锚定刚讲的关键点，防止模型另起一题。 */
const RELEARN_QUESTION_TRIGGER = '我已经看完讲解，请针对刚才讲的关键点出一道复述题考我。'

function cloneForPublish(session: ReviewSessionRecord | null): ReviewSessionRecord | null {
  if (!session) return null
  return {
    ...session,
    items: session.items.map((item) => ({
      ...item,
      messages: [...item.messages],
    })),
  }
}

export const useReviewSessionStore = create<ReviewSessionStoreState>()((set, get) => ({
    projectId: null,
    session: null,
    loading: false,
    error: null,
    sourceOpen: false,
    noteHistoryOpen: false,
    streaming: null,
    lastUndoneNotice: null,

    loadForProject: async (projectId, targetSessionId) => {
      set({ loading: true, error: null, projectId })
      const repo = getRepositories().reviewSessions
      let record: ReviewSessionRecord | undefined
      if (targetSessionId) {
        record = await repo.get(targetSessionId)
      }
      if (!record) {
        record = await repo.findOpen(projectId)
      }

      if (record && isReadableSession(record)) {
        recoverSession(record, Date.now())
        await repo.save(record)
      } else {
        record = undefined
      }

      set({ session: record ?? null, loading: false })

      // 已载入且停在未出题阶段 ⇒ 自动开始第一题，不用用户到处找「出题」按钮
      if (record && record.status === 'active') {
        const item = currentItem(record)
        if (item && item.messages.length === 0 && (item.phase === 'preparing' || item.phase === 'relearning')) {
          void get().ensureCurrentItemContent()
        }
      }
      return record ?? null
    },

    startBatch: async ({ projectId, items, nodes, returnTo }) => {
      const repo = getRepositories().reviewSessions
      const existing = await repo.findOpen(projectId)
      if (existing) {
        set({ session: existing })
        return existing
      }

      const titleOf = (id: Id) =>
        nodes.find((n) => n.id === id)?.title ?? i18n.t('common:fallback.newTopicTitle')
      const versionOf = (id: Id) => {
        const target = nodes.find((n) => n.id === id)
        if (!target) return undefined
        return threadPathFingerprint(resolveThread(target, []).path)
      }

      const seeds = seedsFromQueue(items, titleOf, versionOf)
      if (seeds.length === 0) return null

      const created = createReviewSession({
        projectId,
        items: seeds,
        origin: 'overview',
        returnTo,
        now: Date.now(),
      })
      const saved = await repo.save(created)
      set({ session: saved, projectId, error: null })

      void get().ensureCurrentItemContent()
      return saved
    },

    startSingle: async ({ projectId, nodeId, nodes, returnTo }) => {
      const repo = getRepositories().reviewSessions
      const node = nodes.find((n) => n.id === nodeId)
      if (!node) return null

      // 单主题复习严格创建单主题会话：即使队列里有别的到期项也不追加
      const queue = buildReviewQueue(nodes, Date.now())
      const found = queue.find((item) => item.nodeId === nodeId)
      const mode = found?.mode ?? 'review'

      const created = createReviewSession({
        projectId,
        items: [
          {
            nodeId,
            title: node.title,
            mode,
            sourceVersion: threadPathFingerprint(resolveThread(node, []).path),
          },
        ],
        origin: 'node',
        returnTo: returnTo ?? { nodeId, viewMode: 'chat' },
        now: Date.now(),
      })

      const saved = await repo.save(created)
      set({ session: saved, projectId, error: null })

      void get().ensureCurrentItemContent()
      return saved
    },

    saveDraft: async (text) => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      const now = Date.now()
      patchItem(session, item.itemId, { draft: text }, now)
      set({ session: cloneForPublish(session)! })
      await getRepositories().reviewSessions.save(session)
    },

    ensureCurrentItemContent: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item || session.status !== 'active') return
      // 已经有内容就不重复生成
      if (item.messages.length > 0 && item.phase !== 'preparing') {
        // 补学确认后复述题还没落下来（请求失败 / 刷新中断）：重发确认请求就是重试。
        // 题目没到不算「已有内容」，否则错误条上的重试在这个窗口里永远是空操作。
        if (
          item.mode === 'relearn' &&
          item.phase === 'answering' &&
          !item.messages.some((message) => message.role === 'assistant' && message.purpose === 'question')
        ) {
          await executeModelTurn('question', RELEARN_QUESTION_TRIGGER)
        }
        return
      }

      const purpose: ReviewRequestPurpose = item.mode === 'relearn' ? 'relearn' : 'question'
      await executeModelTurn(purpose, '')
    },

    submitAnswer: async (answer, imageIds) => {
      const trimmed = answer.trim()
      const images = [...new Set(imageIds ?? [])]
      // 纯图片作答（如手写过程的拍照）合法：正文为空但图片非空也放行
      if (!trimmed && images.length === 0) return
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return

      const now = Date.now()
      // 回答先落库成用户消息，阶段转 evaluating。
      // `answer` 刻意不为空（图片-only 时给占位句）：它是确认评分的门槛（canConfirm），
      // 也是模型侧「这一项回答过」的判据 —— 不让一张图绕过这两个不变量。
      const message: ReviewSessionMessage = {
        id: newId(),
        role: 'user',
        text: trimmed,
        purpose: 'answer',
        ...(images.length > 0 ? { imageIds: images } : {}),
        createdAt: now,
      }
      const messages = [...item.messages, message]
      patchItem(
        session,
        item.itemId,
        {
          answer: trimmed || i18n.t('common:session.imageAnswer'),
          draft: '',
          phase: 'evaluating',
          interacted: true,
          messages,
        },
        now,
      )
      set({ session: cloneForPublish(session)! })
      await getRepositories().reviewSessions.save(session)

      await executeModelTurn('answer', trimmed)
    },

    requestHint: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      patchItem(session, item.itemId, { usedHint: true, interacted: true }, Date.now())
      set({ session: cloneForPublish(session)! })
      await executeModelTurn('hint', '')
    },

    requestRephrase: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      patchItem(session, item.itemId, { interacted: true }, Date.now())
      set({ session: cloneForPublish(session)! })
      await executeModelTurn('rephrase', '')
    },

    requestGiveUp: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return

      const now = Date.now()
      // 「暂时想不起来」算一次回答，自动建议 again，但仍需用户明确确认
      const giveUpText = i18n.t('common:session.cantRecall')
      const messages = [
        ...item.messages,
        {
          id: newId(),
          role: 'user' as const,
          text: giveUpText,
          purpose: 'answer' as const,
          createdAt: now,
        },
      ]
      patchItem(
        session,
        item.itemId,
        {
          answer: giveUpText,
          draft: '',
          phase: 'evaluating',
          interacted: true,
          selectedGrade: 'again',
          messages,
        },
        now,
      )
      set({ session: cloneForPublish(session)! })
      await getRepositories().reviewSessions.save(session)
      await executeModelTurn('answer', giveUpText)
    },

    confirmRelearnReady: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      patchItem(session, item.itemId, { phase: 'answering', interacted: true }, Date.now())
      set({ session: cloneForPublish(session)! })
      await executeModelTurn('question', RELEARN_QUESTION_TRIGGER)
    },

    askFollowup: async (question) => {
      const trimmed = question.trim()
      if (!trimmed) return
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return

      const now = Date.now()
      const messages = [
        ...item.messages,
        {
          id: newId(),
          role: 'user' as const,
          text: trimmed,
          purpose: 'followup' as const,
          createdAt: now,
        },
      ]
      patchItem(session, item.itemId, { phase: 'evaluating', messages }, now)
      set({ session: cloneForPublish(session)! })
      await getRepositories().reviewSessions.save(session)
      await executeModelTurn('followup', trimmed)
    },

    selectGrade: (grade) => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      patchItem(session, item.itemId, { selectedGrade: grade }, Date.now())
      set({ session: cloneForPublish(session)! })
      void getRepositories().reviewSessions.save(session)
    },

    confirmCurrentGrade: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item || !canConfirm(item)) return false

      // 选档优先：手选 > AI 建议；都没有时必须由用户选，不默认记 good
      const grade = item.selectedGrade ?? suggestionFromMessages(item.messages)
      if (!grade) {
        set({ error: i18n.t('common:session.gradeRequired') })
        return false
      }

      const operationId = item.pendingOperationId ?? newId()
      const expectedVersion = session.version
      const snapshotTitle = item.title
      const now = Date.now()

      patchItem(session, item.itemId, { phase: 'saving', pendingOperationId: operationId }, now)
      set({ session: cloneForPublish(session)! })
      await getRepositories().reviewSessions.save(session)

      const outcome = await getRepositories().reviewSessions.grade({
        sessionId: session.id,
        itemId: item.itemId,
        operationId,
        projectId: session.projectId,
        nodeId: item.nodeId,
        grade,
        expectedVersion,
        now,
      })

      if (outcome.status === 'applied' || outcome.status === 'duplicate') {
        set({
          session: outcome.session,
          error: null,
          lastUndoneNotice: i18n.t('common:session.recordedNotice', { title: snapshotTitle }),
        })
        // 自动出下一题
        void get().ensureCurrentItemContent()
        return true
      }

      if (outcome.status === 'unavailable') {
        set({
          session: outcome.session,
          error: outcome.message,
        })
        void get().ensureCurrentItemContent()
        return false
      }

      if ('session' in outcome && outcome.session) {
        set({ error: outcome.message, session: outcome.session })
        return false
      }
      const rollbackNow = Date.now()
      patchItem(session, item.itemId, { phase: 'feedback', pendingOperationId: operationId, error: outcome.message }, rollbackNow)
      await getRepositories().reviewSessions.save(session)
      set({ error: outcome.message, session: cloneForPublish(session)! })
      return false
    },

    skipCurrent: async (reason = i18n.t('common:session.skippedByUser')) => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      const now = Date.now()
      patchItem(session, item.itemId, { phase: 'skipped', skipReason: reason }, now)
      advanceAfter(session, item.itemId, now)
      set({ session: cloneForPublish(session)!, error: null })
      await getRepositories().reviewSessions.save(session)
      void get().ensureCurrentItemContent()
    },

    undoLastConfirmed: async () => {
      const session = get().session
      const item = undoableItem(session)
      if (!session || !item) return false

      const outcome = await getRepositories().reviewSessions.undo({
        sessionId: session.id,
        itemId: item.itemId,
        projectId: session.projectId,
        nodeId: item.nodeId,
        now: Date.now(),
      })

      if (outcome.status === 'applied') {
        set({
          session: outcome.session,
          lastUndoneNotice: null,
          error: null,
        })
        return true
      }

      set({
        error: outcome.message,
        session: 'session' in outcome && outcome.session ? (outcome.session as ReviewSessionRecord) : session,
      })
      return false
    },

    resumeSession: async () => {
      const session = get().session
      if (!session || session.status !== 'paused') return
      const now = Date.now()
      resumeSession(session, now)
      await getRepositories().reviewSessions.save(session)
      set({ session: cloneForPublish(session)!, error: null })
      void get().ensureCurrentItemContent()
    },

    pauseAndLeave: async () => {
      const session = get().session
      if (!session) return
      reviewAbort?.abort()
      reviewAbort = null
      const now = Date.now()
      settlePendingItems(session, now)
      pauseSession(session, now)
      await getRepositories().reviewSessions.save(session)
      set({
        session: cloneForPublish(session),
        streaming: null,
      })
    },

    endSession: async () => {
      const session = get().session
      if (!session) return
      reviewAbort?.abort()
      reviewAbort = null
      const now = Date.now()
      settlePendingItems(session, now)
      endSessionWithPending(session, now)
      await getRepositories().reviewSessions.save(session)
      set({
        session: cloneForPublish(session),
        streaming: null,
      })
    },

    stopStreaming: () => {
      reviewAbort?.abort()
      reviewAbort = null
      set({ streaming: null })
    },

    toggleSource: () => {
      set((state) => ({ sourceOpen: !state.sourceOpen, noteHistoryOpen: false }))
    },

    setSourceOpen: (open) => {
      set({ sourceOpen: open, ...(open ? { noteHistoryOpen: false } : {}) })
    },

    toggleNoteHistory: () => {
      set((state) => ({ noteHistoryOpen: !state.noteHistoryOpen, sourceOpen: false }))
    },

    setNoteHistoryOpen: (open) => {
      set({ noteHistoryOpen: open, ...(open ? { sourceOpen: false } : {}) })
    },

    clearError: () => {
      set({ error: null })
    },

    clearNotice: () => {
      set({ lastUndoneNotice: null })
    },

    reset: () => {
      reviewAbort?.abort()
      reviewAbort = null
      set({
        projectId: null,
        session: null,
        loading: false,
        error: null,
        sourceOpen: false,
        streaming: null,
        lastUndoneNotice: null,
      })
    },
}))

/**
 * 实际跑一轮模型请求（出题、提示、换问法、反馈、追问共用）。
 *
 * 封装在这里是为了统一处理：流式进度、abort、超时、失败回滚到稳定态，
 * 以及最重要的**请求归属判断** —— 产生这条消息时的请求 ID 必须记在消息上，
 * 迟到返回的回调才会被识别并安全丢弃。
 */
/**
 * 本轮交付 handler：守卫（domain 纯函数，对**活会话**校验）→ 原子落库
 * （消息 + 阶段 + 副作用）→ 标记已交付。
 *
 * 交付即持久化：流中断时已交付的卡片保留，只有未完成部分需要重试 —— 这比
 * 散文路径「中断即全丢」更好。工具执行发生在流中途，必须解析 store 里**当前**
 * 的会话对象来改（turn 开始时发布的 clone），不能抓旧的局部引用。
 */
function createDeliveryHandlers(
  purpose: ReviewRequestPurpose,
  item: ReviewSessionItem,
  requestId: Id,
): { handlers: ReviewDeliveryHandlers; state: { delivered: boolean } } {
  const store = useReviewSessionStore
  const state = { delivered: false }

  // 反馈轮（answer / followup）允许点评中的补讲（阶段 3 的合并轮次）
  const afterFeedback = purpose === 'answer' || purpose === 'followup'

  const liveItem = (): ReviewSessionItem | null => {
    const live = store.getState().session
    return live?.items.find((entry) => entry.itemId === item.itemId) ?? null
  }

  const markDelivered = () => {
    state.delivered = true
    const current = store.getState().streaming
    if (current && current.requestId === requestId) {
      store.setState({ streaming: { ...current, delivered: true } })
    }
  }

  const commit = async (patch: Parameters<typeof patchItem>[2]) => {
    // 每轮限交付一次：第二个交付调用只会造成两张卡打架（多开放题守卫在
    // domain 层管跨轮，这里管同轮）—— 模型要在一条交付里表达多小问
    if (state.delivered) {
      return { ok: false, error: '本轮已经交付过产物，不要重复交付；多个小问合并进同一条交付' }
    }
    const live = store.getState().session
    if (!live) return { ok: false, error: '会话已不可用' }
    patchItem(live, item.itemId, patch, Date.now())
    await getRepositories().reviewSessions.save(live)
    markDelivered()
    return { ok: true }
  }

  const append = (message: ReviewSessionMessage) => {
    const messages = [...(liveItem()?.messages ?? item.messages), message]
    // 阶段从**整条转录**推导：合并轮次里一条交付可能跟着另一条（点评 → 补讲 →
    // 再问），固定的 kind→phase 映射不再成立
    return { messages, phase: phaseFromTranscript(messages) }
  }

  const handlers: ReviewDeliveryHandlers = {
    deliverTeach: async (input) => {
      const live = liveItem()
      if (!live) return { ok: false, error: '会话已不可用' }
      const check = canTeachKeyPoints(live, { afterFeedback })
      if (!check.ok) return { ok: false, error: check.reason }
      const keyPointLines = input.keyPoints.map((point) => `- ${point}`).join('\n')
      const message: ReviewSessionMessage = {
        id: newId(),
        role: 'assistant',
        text: i18n.t('common:session.teachMessage', {
          keyPoints: keyPointLines,
          explanation: input.explanation,
        }),
        purpose: 'relearn',
        createdAt: Date.now(),
      }
      return commit(append(message))
    },

    deliverQuestion: async (input) => {
      const live = liveItem()
      if (!live) return { ok: false, error: '会话已不可用' }
      const check = canPoseQuestion(live, input.rephraseOf)
      if (!check.ok) return { ok: false, error: check.reason }
      const message: ReviewSessionMessage = {
        id: newId(),
        role: 'assistant',
        text: input.question,
        purpose: 'question',
        createdAt: Date.now(),
      }
      return commit(append(message))
    },

    deliverHint: async (input) => {
      const live = liveItem()
      if (!live) return { ok: false, error: '会话已不可用' }
      const check = canGiveHint(live)
      if (!check.ok) return { ok: false, error: check.reason }
      const message: ReviewSessionMessage = {
        id: newId(),
        role: 'assistant',
        text: input.hint,
        purpose: 'hint',
        createdAt: Date.now(),
      }
      return commit(append(message))
    },

    deliverFeedback: async (input) => {
      const live = liveItem()
      if (!live) return { ok: false, error: '会话已不可用' }
      const check = canSubmitFeedback(live)
      if (!check.ok) return { ok: false, error: check.reason }
      const message: ReviewSessionMessage = {
        id: newId(),
        role: 'assistant',
        text: i18n.t('common:session.feedbackMessage', {
          strengths: input.strengths,
          gaps: input.gaps,
        }),
        purpose,
        createdAt: Date.now(),
      }
      // 档位建议：已有手选/预选（含「暂时想不起来」预置的 again）时不覆盖 ——
      // followup 改判链路依赖这一点，与散文路径的 suggestion 规则同口径
      const gradePatch =
        live.selectedGrade === undefined ? { selectedGrade: input.suggestedGrade } : {}
      const messages = [...live.messages, message]
      return commit({
        messages,
        phase: phaseFromTranscript(messages),
        ...gradePatch,
      })
    },
  }

  return { handlers, state }
}

/**
 * 一轮失败后的回滚：退回可重试的稳定态并留下错误说明。
 * 阶段以**turn 开始时**的状态为基准（正在评估的退回作答，正在准备的留在准备）。
 */
async function rollbackTurn(
  session: ReviewSessionRecord,
  item: ReviewSessionItem,
  message: string,
  now: number,
): Promise<void> {
  const fallbackPhase =
    item.phase === 'evaluating' ? 'answering' : item.phase === 'preparing' ? 'preparing' : item.phase
  patchItem(
    session,
    item.itemId,
    {
      phase: fallbackPhase,
      pendingRequestId: undefined,
      pendingPurpose: undefined,
      error: message,
    },
    now,
  )
  await getRepositories().reviewSessions.save(session)
  useReviewSessionStore.setState({
    session: cloneForPublish(session)!,
    streaming: null,
    error: message,
  })
}

const REVIEW_DELIVERY_TOOL_NAMES = new Set([
  'teach_key_points',
  'pose_question',
  'give_hint',
  'submit_feedback',
])

/**
 * 活动行文案的键：模型查了什么，用户一行看得懂。
 *
 * 存键不存译文 —— 模块加载时还没有语言可用，取值时（onToolCall）才解析。
 */
const TOOL_ACTIVITY_LABEL_KEY: Record<string, `common:${ParseKeys<'common'>}`> = {
  search_notes: 'common:session.activity.searchNotes',
  search_nodes: 'common:session.activity.searchNodes',
  get_node: 'common:session.activity.getNode',
  get_tree_outline: 'common:session.activity.getTreeOutline',
  list_note_labels: 'common:session.activity.listNoteLabels',
  get_review_history: 'common:session.activity.getReviewHistory',
}

/**
 * 复习会话的检索作用域：**框选的主题集合 + 各自的祖先路径**。
 *
 * 这是「考与判只发生在框选节点上」契约的结构化表达 —— 默认拿不到的数据，
 * agent 想考也考不了；跨出必须显式 widen 且结果带来源标注。祖先每次请求现算，
 * 树中途被挪动也不会用到过期快照。
 */
function reviewScope(nodes: Node[], session: ReviewSessionRecord): { nodeIds: Id[] } {
  const index = buildTreeIndex(nodes)
  const nodeIds = new Set<Id>()
  for (const entry of session.items) {
    nodeIds.add(entry.nodeId)
    for (const ancestor of ancestorsOf(index, entry.nodeId)) nodeIds.add(ancestor.id)
  }
  return { nodeIds: [...nodeIds] }
}

async function executeModelTurn(
  purpose: ReviewRequestPurpose,
  text: string,
  options: { forceLegacy?: boolean } = {},
): Promise<void> {
  const store = useReviewSessionStore
  const state = store.getState()
  const session = state.session
  const item = currentItem(session)
  const projectId = state.projectId
  if (!session || !item || !projectId) return

  // 同一主题同一用途的请求已在途：这次触发是重复点击，直接忽略。
  // 再进来只会 abort 掉上一个同样的请求重发一遍 —— 白付一次调用，用户还以为点了没用。
  const inFlight = state.streaming
  if (inFlight && inFlight.itemId === item.itemId && inFlight.purpose === purpose) return

  reviewAbort?.abort()
  const controller = new AbortController()
  reviewAbort = controller

  const requestId = newId()
  store.setState({
    streaming: {
      itemId: item.itemId,
      requestId,
      purpose,
      text: '',
      startedAt: Date.now(),
    },
    error: null,
  })

  patchItem(
    session,
    item.itemId,
    { pendingRequestId: requestId, pendingPurpose: purpose },
    Date.now(),
  )
  store.setState({ session: cloneForPublish(session)! })
  await getRepositories().reviewSessions.save(session)

  // 读取当前需要的节点和前置消息
  const [project, nodes, messages, notes, projectSettings] = await Promise.all([
    getRepositories().projects.get(projectId),
    getRepositories().nodes.listByProject(projectId),
    getRepositories().messages.listByProject(projectId),
    // 标注随材料一起给模型：用户标的错题 / 没懂是他本人的判断，出题与点评要优先照顾
    getRepositories().notes.listByProject(projectId),
    getRepositories().projectSettings.get(projectId),
  ])
  const node = nodes.find((n) => n.id === item.nodeId)
  if (!node) {
    store.setState({
      streaming: null,
      error: i18n.t('common:session.nodeDeleted'),
    })
    return
  }

  const messagesByNode = new Map<Id, typeof messages>()
  for (const msg of messages) {
    const bucket = messagesByNode.get(msg.nodeId)
    if (bucket) bucket.push(msg)
    else messagesByNode.set(msg.nodeId, [msg])
  }

  // 标注按**消息**分组（与 workspace-store.notesByMessage 同口径）：
  // 旧实现拿 nodeId 去查这张表，导致复习材料里的「笔记」那段从未生效过
  const notesByMessage = new Map<Id, Note[]>()
  // 复习期标注走独立通道：它们锚在复习消息上，按消息索引查不到；投喂口径也不同
  // （只送标签与备注，不回送上一轮讲解原文 —— 见 domain/context/review.ts）
  const reviewNotes: Note[] = []
  for (const note of notes) {
    if (noteOrigin(note) === 'review') {
      if (note.nodeId === item.nodeId) reviewNotes.push(note)
      continue
    }
    const bucket = notesByMessage.get(note.messageId)
    if (bucket) bucket.push(note)
    else notesByMessage.set(note.messageId, [note])
  }

  const settings = useSettingsStore.getState().settings

  const total = session.items.length
  const currentIdx = session.cursor + 1
  const progressNote = i18n.t('common:session.progressNote', {
    current: currentIdx,
    total,
    title: item.title,
  })

  // Agent 主路径：handler 负责守卫与交付即落库。forceLegacy（能力降级重试）时
  // 不给 handler —— 服务层走散文协议，行为与工具化之前一致。
  const delivery = options.forceLegacy
    ? null
    : createDeliveryHandlers(purpose, item, requestId)

  // 只读检索工具（阶段 2）：绑定框选作用域 + 历史复习查询；对话/自由答的调用点
  // 不传 retrievalScope，行为保持全项目不变。
  const readOnlyTools = delivery
    ? buildReadOnlyTools({
        nodes,
        messagesByNode,
        notes,
        currentNodeId: item.nodeId,
        retrievalScope: reviewScope(nodes, session),
        reviewHistory: () => getRepositories().reviewSessions.listByProject(projectId),
      })
    : undefined

  // 作答图片 → dataUrl：模型上下文里图片以数据 URL 附在用户消息上（与聊天同一套资产解析）
  const imageIds = [
    ...new Set(item.messages.flatMap((message) => (message.role === 'user' ? (message.imageIds ?? []) : []))),
  ]
  const imageUrls =
    imageIds.length > 0 ? await loadAssetUrls(getRepositories().assets, imageIds) : undefined

  const result = await runReviewRequest({
    settings,
    projectSettings,
    projectName: project?.name,
    projectDescription: project?.description,
    node,
    nodes,
    messagesByNode,
    notesByMessage,
    reviewNotes,
    imageUrls,
    item,
    purpose,
    text,
    signal: controller.signal,
    progressNote,
    handlers: delivery?.handlers,
    readOnlyTools,
    onToolCall: (activity) => {
      if (REVIEW_DELIVERY_TOOL_NAMES.has(activity.name)) return
      const cur = store.getState().streaming
      if (cur && cur.requestId === requestId) {
        store.setState({
          streaming: {
            ...cur,
            activities: [
              ...(cur.activities ?? []),
              {
                name: activity.name,
                label: TOOL_ACTIVITY_LABEL_KEY[activity.name]
                  ? i18n.t(TOOL_ACTIVITY_LABEL_KEY[activity.name])
                  : activity.name,
              },
            ],
          },
        })
      }
    },
    onDelta: (delta) => {
      const cur = store.getState().streaming
      if (cur && cur.requestId === requestId) {
        store.setState({
          streaming: {
            ...cur,
            text: cur.text + delta,
          },
        })
      }
    },
  })

  // 请求被中断（用户点了暂停 / 停止）或已被换掉 ⇒ 不再落库
  if (reviewAbort !== controller) return
  reviewAbort = null

  const now = Date.now()
  const currentSession = store.getState().session
  if (!currentSession) return

  if (result.ok) {
    const output = result.output

    // Agent 路径：产物只能来自交付工具。没交付 = 模型失职，按失败处理，可重试。
    if (output.usedDelivery) {
      if (!delivery?.state.delivered) {
        await rollbackTurn(currentSession, item, i18n.t('common:session.undelivered'), now)
        return
      }
      // 交付成功：消息与阶段已由 handler 原子落库，这里补材料快照、清在途标记
      patchItem(
        currentSession,
        item.itemId,
        {
          sourceText: output.materialText,
          sourceVersion: output.materialVersion,
          modelRef: output.modelRef,
          pendingRequestId: undefined,
          pendingPurpose: undefined,
          error: undefined,
        },
        now,
      )
      await getRepositories().reviewSessions.save(currentSession)
      store.setState({ session: cloneForPublish(currentSession)!, streaming: null })
      return
    }

    const assistantMessage = {
      id: newId(),
      role: 'assistant' as const,
      text: output.text,
      purpose,
      requestId: output.requestId,
      incomplete: output.aborted,
      createdAt: now,
    }

    // 决定下一个稳定阶段
    let nextPhase: ReviewItemPhase = item.phase
    if (purpose === 'question') {
      nextPhase = 'answering'
    } else if (purpose === 'relearn') {
      nextPhase = 'relearning'
    } else if (purpose === 'answer' || purpose === 'followup') {
      nextPhase = 'feedback'
    }

    const liveItem = currentSession.items.find((entry) => entry.itemId === item.itemId)
    const baseMessages = liveItem ? liveItem.messages : item.messages
    const messagesList = [...baseMessages, assistantMessage]
    const patch: Parameters<typeof patchItem>[2] = {
      phase: nextPhase,
      messages: messagesList,
      sourceText: output.materialText,
      sourceVersion: output.materialVersion,
      modelRef: output.modelRef,
      pendingRequestId: undefined,
      pendingPurpose: undefined,
      error: undefined,
    }
    const liveSelectedGrade = liveItem?.selectedGrade
    if ((purpose === 'answer' || purpose === 'followup') && !liveSelectedGrade && !item.selectedGrade) {
      const suggested = suggestionFromMessages(messagesList)
      if (suggested) patch.selectedGrade = suggested
    } else if (liveSelectedGrade) {
      patch.selectedGrade = liveSelectedGrade
    } else if (item.selectedGrade) {
      patch.selectedGrade = item.selectedGrade
    }

    patchItem(currentSession, item.itemId, patch, now)
    await getRepositories().reviewSessions.save(currentSession)

    store.setState({
      session: cloneForPublish(currentSession)!,
      streaming: null,
    })
  } else {
    const failure = result.failure

    // 能力未探测 + 工具路径请求异常 ⇒ 降级重试一次散文路径（与学习对话同一模式）；
    // 用户主动中断不算失败，不重试。
    if (failure.capabilityUnknown && delivery !== null && !failure.aborted && !options.forceLegacy) {
      await executeModelTurn(purpose, text, { forceLegacy: true })
      return
    }

    // 交付已发生、请求在其后失败：产物有效，按成功收尾（材料快照缺失可接受）
    if (delivery?.state.delivered) {
      patchItem(
        currentSession,
        item.itemId,
        {
          pendingRequestId: undefined,
          pendingPurpose: undefined,
          error: undefined,
        },
        now,
      )
      await getRepositories().reviewSessions.save(currentSession)
      store.setState({ session: cloneForPublish(currentSession)!, streaming: null })
      return
    }

    await rollbackTurn(currentSession, item, failure.message, now)
  }
}