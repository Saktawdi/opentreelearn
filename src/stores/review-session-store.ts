import { create } from 'zustand'
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
  type ReviewSessionRecord,
} from '@/domain/review/session'
import { buildReviewQueue, type ReviewQueueItem } from '@/domain/review/queue'
import { suggestionFromMessages } from '@/domain/review/protocol'
import { threadPathFingerprint, resolveThread } from '@/domain/thread/resolve'
import { runReviewRequest } from '@/services/llm/review'
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
}

interface ReviewSessionStoreState {
  projectId: Id | null
  session: ReviewSessionRecord | null
  loading: boolean
  error: string | null
  /** 资料面板是否展开（桌面右侧抽屉，窄屏覆盖） */
  sourceOpen: boolean
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
  /** 提交回答并请求反馈 */
  submitAnswer: (answer: string) => Promise<void>
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
  clearError: () => void
  clearNotice: () => void
  reset: () => void
}

let reviewAbort: AbortController | null = null

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

      const titleOf = (id: Id) => nodes.find((n) => n.id === id)?.title ?? '新主题'
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
      if (item.messages.length > 0 && item.phase !== 'preparing') return

      const purpose: ReviewRequestPurpose = item.mode === 'relearn' ? 'relearn' : 'question'
      await executeModelTurn(purpose, '')
    },

    submitAnswer: async (answer) => {
      const trimmed = answer.trim()
      if (!trimmed) return
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return

      const now = Date.now()
      // 回答先落库成用户消息，阶段转 evaluating
      const messages = [
        ...item.messages,
        {
          id: newId(),
          role: 'user' as const,
          text: trimmed,
          purpose: 'answer' as const,
          createdAt: now,
        },
      ]
      patchItem(
        session,
        item.itemId,
        {
          answer: trimmed,
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
      const messages = [
        ...item.messages,
        {
          id: newId(),
          role: 'user' as const,
          text: '暂时想不起来。',
          purpose: 'answer' as const,
          createdAt: now,
        },
      ]
      patchItem(
        session,
        item.itemId,
        {
          answer: '暂时想不起来。',
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
      await executeModelTurn('answer', '暂时想不起来。')
    },

    confirmRelearnReady: async () => {
      const session = get().session
      const item = currentItem(session)
      if (!session || !item) return
      patchItem(session, item.itemId, { phase: 'answering', interacted: true }, Date.now())
      set({ session: cloneForPublish(session)! })
      await executeModelTurn('question', '我已经看完讲解，请出一道复述题考我。')
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
        set({ error: '请先选择一个掌握档位' })
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
          lastUndoneNotice: `已记录「${snapshotTitle}」的掌握情况`,
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

    skipCurrent: async (reason = '用户跳过') => {
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
      set((state) => ({ sourceOpen: !state.sourceOpen }))
    },

    setSourceOpen: (open) => {
      set({ sourceOpen: open })
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
async function executeModelTurn(purpose: ReviewRequestPurpose, text: string): Promise<void> {
  const store = useReviewSessionStore
  const state = store.getState()
  const session = state.session
  const item = currentItem(session)
  const projectId = state.projectId
  if (!session || !item || !projectId) return

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
      error: '主题节点已被删除',
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
  for (const note of notes) {
    const bucket = notesByMessage.get(note.messageId)
    if (bucket) bucket.push(note)
    else notesByMessage.set(note.messageId, [note])
  }

  const settings = useSettingsStore.getState().settings

  const total = session.items.length
  const currentIdx = session.cursor + 1
  const progressNote = `第 ${currentIdx} / ${total} 个主题（《${item.title}》）`

  const result = await runReviewRequest({
    settings,
    projectSettings,
    projectName: project?.name,
    projectDescription: project?.description,
    node,
    nodes,
    messagesByNode,
    notesByMessage,
    item,
    purpose,
    text,
    signal: controller.signal,
    progressNote,
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
    const fallbackPhase =
      item.phase === 'evaluating' ? 'answering' : item.phase === 'preparing' ? 'preparing' : item.phase

    patchItem(
      currentSession,
      item.itemId,
      {
        phase: fallbackPhase,
        pendingRequestId: undefined,
        pendingPurpose: undefined,
        error: failure.message,
      },
      now,
    )
    await getRepositories().reviewSessions.save(currentSession)

    store.setState({
      session: cloneForPublish(currentSession)!,
      streaming: null,
      error: failure.message,
    })
  }
}