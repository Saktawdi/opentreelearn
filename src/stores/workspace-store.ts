import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getRepositories } from '@/data'
import { assembleContext, collectHistorySegments } from '@/domain/context/assemble'
import {
  deriveTitle,
  messageImageIds,
  sameMessageParts,
} from '@/domain/messages'
import type {
  Id,
  MasterySnapshot,
  Message,
  MessagePart,
  Node,
  NodeReview,
  Note,
  NoteKind,
  Project,
  ProjectSettings,
  ReviewGrade,
} from '@/domain/models'
import {
  appendEntry,
  createEditVersion,
  openAnswerVersion,
  pruneEntry,
  pruneMissingEntries,
  setSlotVersion as applySlotVersion,
  type ThreadChange,
} from '@/domain/thread/mutations'
import { resolveThread } from '@/domain/thread/resolve'
import { sortNotes } from '@/domain/notes'
import {
  createNodeFromAction,
  nodeActionRequiresMessage,
  type NodeActionKind,
} from '@/domain/node-ops/actions'
import { buildTreeIndex, descendantsOf } from '@/domain/tree/tree'
import { createReviewCenterNode, findReviewCenter } from '@/domain/review/center'
import { buildReviewQueue, type ReviewQueueItem } from '@/domain/review/queue'
import { masteryAfterGrade, nextReview, seedReviewCard } from '@/domain/review/schedule'
import { newId } from '@/lib/id'
import { streamReply, toModelMessages } from '@/services/llm/chat'
import {
  buildTranscript,
  generateSummary,
  generateTitle,
  type SummaryAssessment,
} from '@/services/llm/derive'
import { describeLlmError, formatErrorMessage } from '@/services/llm/errors'
import { requireModel, resolveModel } from '@/services/llm/providers'
import { loadAssetUrls } from '@/services/images'
import { touchProject } from './projects-store'
import { useSettingsStore } from './settings-store'

export type WorkspaceViewMode = 'chat' | 'canvas'

export interface StreamingState {
  nodeId: Id
  messageId: Id
  text: string
  startedAt: number
  error?: string
}

/**
 * 某个节点是否正在生成。
 *
 * 带上 `error` 的那一轮其实已经结束了：失败且一个字都没吐出来时不会有消息落库，
 * 错误只能挂在这一轮上，此时输入框不该再锁着、重新生成也该可用。
 */
export function isStreamingIn(streaming: StreamingState | null, nodeId: Id): boolean {
  return streaming?.nodeId === nodeId && !streaming.error
}

/** 写了一次版本结构之后的结果：是否触发了 3 版上限淘汰（UI 据此 toast）。 */
export interface VersionWriteResult {
  pruned: boolean
}

/** 新建笔记的入参：锚点是「正文纯文本里的字符区间」，由框选那一刻算好传进来。 */
export interface NewNoteInput {
  nodeId: Id
  messageId: Id
  kind: NoteKind
  quote: string
  start: number
  end: number
  body?: string
}

/**
 * 一次复习会话：队列 + 走到第几题 + 每题的结果。
 *
 * 队列在开始时一次性算好（`buildReviewQueue`），会话中途不重排 ——
 * 复习到一半顺序突变比顺序不够优更让人困惑。会话本身不落库：
 * 它是「今天这一次动作」的临时状态，跨端同步没有意义（见工单的并发取舍）。
 */
export interface ReviewSession {
  items: ReviewQueueItem[]
  /** 当前第几题（0 基）；等于 items.length 表示已走完 */
  cursor: number
  /** 每题评到的档位，走完时给小结 */
  results: Record<Id, ReviewGrade>
  /**
   * 每题**首次评分前**的掌握度分数。
   *
   * 改判要「当作只评过新档位」来算分，就必须从这个基准重算 ——
   * 拿改判后的分数再算一次会叠加（again 把分数压到 35，再改 good 会变成 40）。
   */
  baseScores: Record<Id, number>
  /**
   * 每题**首次评分前**的复习卡片；`null` = 评之前没有卡（历史数据）。
   *
   * 与 `baseScores` 同理：改判必须从复习前的卡片重排。若在已排过的卡上再排一次，
   * 一次改判会被 FSRS 当成两次复习（reps 多算、again 的 lapses 留在卡上、
   * due 被推远），改判本身就成了惩罚。
   */
  baseCards: Record<Id, NodeReview | null>
  startedAt: number
  finishedAt?: number
}

/** 当前该复习的那一条；会话结束或没有会话时为 null。 */
export function currentReviewItem(session: ReviewSession | null): ReviewQueueItem | null {
  if (!session || session.finishedAt) return null
  return session.items[session.cursor] ?? null
}

interface WorkspaceState {
  projectId: Id | null
  project: Project | null
  projectSettings: ProjectSettings | null
  nodes: Node[]
  messagesByNode: Record<Id, Message[]>
  notesByMessage: Record<Id, Note[]>
  selectedNodeId: Id | null
  viewMode: WorkspaceViewMode
  loading: boolean
  error: string | null
  streaming: StreamingState | null
  /** 正在手动生成摘要的节点，用于在节点卡片上渲染骨架屏 */
  summarizingNodeIds: Id[]
  /** 当前项目的复习会话；不落库 */
  reviewSession: ReviewSession | null

  openProject: (projectId: Id) => Promise<void>
  reset: () => void
  selectNode: (id: Id | null) => void
  setViewMode: (mode: WorkspaceViewMode) => void
  toggleViewMode: () => void
  refreshNodes: () => Promise<void>
  startRootNode: (
    question: string,
    position?: { x: number; y: number } | null,
  ) => Promise<Node | null>
  applyAction: (
    kind: NodeActionKind,
    sourceNodeId: Id,
    sourceMessageId?: Id,
  ) => Promise<Node | null>
  setNodeTitle: (id: Id, title: string) => Promise<void>
  setNodePosition: (id: Id, position: { x: number; y: number } | null) => Promise<void>
  relayout: () => Promise<void>
  archiveNode: (id: Id) => Promise<void>
  deleteNode: (id: Id) => Promise<void>
  updateProjectSettings: (patch: Partial<ProjectSettings>) => Promise<void>
  addNote: (input: NewNoteInput) => Promise<Note | null>
  updateNote: (id: Id, patch: { body?: string }) => Promise<void>
  removeNote: (id: Id) => Promise<void>
  sendMessage: (nodeId: Id, parts: MessagePart[]) => Promise<void>
  stopStreaming: () => void
  regenerate: (nodeId: Id, messageId?: Id) => Promise<VersionWriteResult | null>
  /** 编辑用户消息并重发：从这条提问起整段换一版，旧的一段落成历史版本 */
  editUserMessage: (
    nodeId: Id,
    messageId: Id,
    parts: MessagePart[],
  ) => Promise<VersionWriteResult | null>
  /** 在历史版本间切换：只改 selection，一次节点更新 */
  setSlotVersion: (nodeId: Id, slotId: Id, version: number) => Promise<void>
  refreshSummary: (nodeId: Id) => Promise<void>
  /** 写入一次学习评估：摘要 + 掌握度（+ 首次评估时按档位种一张复习卡） */
  setNodeAssessment: (nodeId: Id, assessment: SummaryAssessment) => Promise<void>
  /** 复习评分回流：推进卡片、修正掌握度；会话进行中同时记录本题结果 */
  rateReview: (nodeId: Id, grade: ReviewGrade) => Promise<void>
  /** 打开（必要时创建）复习中心节点并选中它 */
  openReviewCenter: () => Promise<Node | null>
  /**
   * 开始一次复习会话；返回本次队列（空队列表示今天没有到期的）。
   * `fromNodeId` 用于「顺手复习」：从指定的到期节点切入队列。
   */
  startReviewSession: (fromNodeId?: Id) => Promise<ReviewQueueItem[]>
  /** 下一题；走完最后一题时结束会话（有复习中心就回到那里看小结） */
  advanceReviewSession: () => void
  endReviewSession: () => void
  clearError: () => void
}

let activeAbort: AbortController | null = null

function groupMessages(messages: Message[]): Record<Id, Message[]> {
  const grouped: Record<Id, Message[]> = {}
  for (const message of [...messages].sort((a, b) => a.createdAt - b.createdAt)) {
    const bucket = grouped[message.nodeId]
    if (bucket) {
      bucket.push(message)
    } else {
      grouped[message.nodeId] = [message]
    }
  }
  return grouped
}

/** 笔记按消息分组存放，改一条笔记要先知道它挂在哪条消息上。 */
function findNoteEntry(
  notesByMessage: Record<Id, Note[]>,
  id: Id,
): { messageId: Id; note: Note } | null {
  for (const [messageId, bucket] of Object.entries(notesByMessage)) {
    const note = bucket.find((item) => item.id === id)
    if (note) return { messageId, note }
  }
  return null
}

/** 按消息分组并按出现位置排序，气泡里的笔记条读起来就是顺着正文的。 */
function groupNotes(notes: Note[]): Record<Id, Note[]> {
  const grouped: Record<Id, Note[]> = {}
  for (const note of notes) {
    const bucket = grouped[note.messageId]
    if (bucket) {
      bucket.push(note)
    } else {
      grouped[note.messageId] = [note]
    }
  }
  for (const [messageId, bucket] of Object.entries(grouped)) {
    grouped[messageId] = sortNotes(bucket)
  }
  return grouped
}

export const useWorkspaceStore = create<WorkspaceState>()(
  immer((set, get) => ({
    projectId: null,
    project: null,
    projectSettings: null,
    nodes: [],
    messagesByNode: {},
    notesByMessage: {},
    selectedNodeId: null,
    viewMode: 'chat',
    loading: false,
    error: null,
    streaming: null,
    summarizingNodeIds: [],
    reviewSession: null,

    openProject: async (projectId) => {
      set((state) => {
        state.loading = true
        state.error = null
        state.projectId = projectId
        state.nodes = []
        state.messagesByNode = {}
        state.notesByMessage = {}
        state.selectedNodeId = null
        state.streaming = null
        state.summarizingNodeIds = []
        state.reviewSession = null
      })

      const repositories = getRepositories()
      const [project, projectSettings, nodes, messages, notes] = await Promise.all([
        repositories.projects.get(projectId),
        repositories.projectSettings.get(projectId),
        repositories.nodes.listByProject(projectId),
        repositories.messages.listByProject(projectId),
        repositories.notes.listByProject(projectId),
      ])

      if (!project) {
        set((state) => {
          state.loading = false
          state.error = '项目不存在或已被删除'
        })
        return
      }

      // 如果已有活跃节点，默认选中最新更新的节点并进入对话模式；若无节点则展示画布模式
      const activeNodes = nodes.filter((n) => n.status === 'active')
      const latestNode = [...activeNodes].sort((a, b) => b.updatedAt - a.updatedAt)[0]

      set((state) => {
        state.project = project
        state.projectSettings = projectSettings ?? { projectId }
        state.nodes = nodes
        state.messagesByNode = groupMessages(messages)
        state.notesByMessage = groupNotes(notes)
        state.selectedNodeId = latestNode?.id ?? null
        state.viewMode = latestNode ? 'chat' : 'canvas'
        state.loading = false
      })
    },

    reset: () => {
      activeAbort?.abort()
      activeAbort = null
      set((state) => {
        state.projectId = null
        state.project = null
        state.projectSettings = null
        state.nodes = []
        state.messagesByNode = {}
        state.notesByMessage = {}
        state.selectedNodeId = null
        state.viewMode = 'chat'
        state.streaming = null
        state.error = null
        state.summarizingNodeIds = []
        state.reviewSession = null
      })
    },

    selectNode: (id) => {
      set((state) => {
        state.selectedNodeId = id
        if (id) {
          state.viewMode = 'chat'
        }
      })
    },

    setViewMode: (mode) => {
      set((state) => {
        state.viewMode = mode
      })
    },

    toggleViewMode: () => {
      set((state) => {
        state.viewMode = state.viewMode === 'chat' ? 'canvas' : 'chat'
      })
    },

    refreshNodes: async () => {
      const projectId = get().projectId
      if (!projectId) return
      const nodes = await getRepositories().nodes.listByProject(projectId)
      set((state) => {
        state.nodes = nodes
      })
    },

    startRootNode: async (question, position = null) => {
      const projectId = get().projectId
      if (!projectId) return null

      const now = Date.now()
      const node: Node = {
        id: newId(),
        projectId,
        parentId: null,
        forkFrom: null,
        title: '新节点',
        position,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }

      await getRepositories().nodes.create(node)
      set((state) => {
        state.nodes.push(node)
        state.selectedNodeId = node.id
      })

      await get().sendMessage(node.id, [{ type: 'text', text: question }])
      touchProject(projectId)
      return node
    },

    applyAction: async (kind, sourceNodeId, sourceMessageId) => {
      const state = get()
      const projectId = state.projectId
      if (!projectId) return null

      const sourceNode = state.nodes.find((node) => node.id === sourceNodeId)
      if (!sourceNode) return null

      // fork 点只能落在显示路径上：隐藏的历史版本不参与上下文
      const visible = resolveThread(sourceNode, state.messagesByNode[sourceNodeId] ?? []).path
      const effectiveMessageId =
        sourceMessageId ?? (nodeActionRequiresMessage(kind) ? visible.at(-1)?.id : undefined)

      const node = createNodeFromAction({
        projectId,
        sourceNode,
        kind,
        sourceMessageId: effectiveMessageId,
      })

      await getRepositories().nodes.create(node)
      set((draft) => {
        draft.nodes.push(node)
        draft.selectedNodeId = node.id
      })
      return node
    },

    setNodeTitle: async (id, title) => {
      const trimmed = title.trim() || '新节点'
      await getRepositories().nodes.update(id, { title: trimmed, updatedAt: Date.now() })
      set((state) => {
        const node = state.nodes.find((item) => item.id === id)
        if (node) {
          node.title = trimmed
          node.updatedAt = Date.now()
        }
      })
    },

    setNodePosition: async (id, position) => {
      await getRepositories().nodes.update(id, { position })
      set((state) => {
        const node = state.nodes.find((item) => item.id === id)
        if (node) node.position = position
      })
    },

    relayout: async () => {
      const { nodes } = get()
      const repositories = getRepositories()
      await Promise.all(
        nodes
          .filter((node) => node.position !== null)
          .map((node) => repositories.nodes.update(node.id, { position: null })),
      )
      set((state) => {
        for (const node of state.nodes) {
          node.position = null
        }
      })
    },

    archiveNode: async (id) => {
      const { nodes } = get()
      const index = buildTreeIndex(nodes)
      const targets = [id, ...descendantsOf(index, id).map((node) => node.id)]
      const repositories = getRepositories()
      await Promise.all(
        targets.map((nodeId) =>
          repositories.nodes.update(nodeId, { status: 'archived', updatedAt: Date.now() }),
        ),
      )
      const targetSet = new Set(targets)
      set((state) => {
        for (const node of state.nodes) {
          if (targetSet.has(node.id)) node.status = 'archived'
        }
        if (state.selectedNodeId && targetSet.has(state.selectedNodeId)) {
          state.selectedNodeId = null
        }
      })
    },

    deleteNode: async (id) => {
      const { nodes, messagesByNode, projectId } = get()
      const index = buildTreeIndex(nodes)
      const targets = [id, ...descendantsOf(index, id).map((node) => node.id)]
      const targetSet = new Set(targets)
      const repositories = getRepositories()

      await Promise.all(
        [...targetSet].flatMap((nodeId) => {
          const messages = messagesByNode[nodeId] ?? []
          return [
            ...messages.map((message) => repositories.messages.remove(message.id)),
            repositories.notes.removeByNode(nodeId),
            repositories.nodes.remove(nodeId),
          ]
        }),
      )

      set((state) => {
        const remaining = state.nodes.filter((node) => !targetSet.has(node.id))
        const reparented = remaining.map((node) =>
          node.parentId && targetSet.has(node.parentId) ? { ...node, parentId: null } : node,
        )
        state.nodes = reparented
        for (const nodeId of targetSet) {
          delete state.messagesByNode[nodeId]
        }
        // 笔记挂在消息上，删节点时要连带把子树里每条消息的笔记一起摘掉
        for (const [messageId, bucket] of Object.entries(state.notesByMessage)) {
          if (bucket.some((note) => targetSet.has(note.nodeId))) delete state.notesByMessage[messageId]
        }
        if (state.selectedNodeId && targetSet.has(state.selectedNodeId)) {
          state.selectedNodeId = null
        }
      })

      if (projectId) touchProject(projectId)
    },

    updateProjectSettings: async (patch) => {
      const { projectId, projectSettings } = get()
      if (!projectId) return
      const next: ProjectSettings = {
        ...(projectSettings ?? { projectId }),
        ...patch,
        updatedAt: Date.now(),
      }
      await getRepositories().projectSettings.save(next)
      set((state) => {
        state.projectSettings = next
      })
    },

    addNote: async (input) => {
      const projectId = get().projectId
      if (!projectId) return null
      const quote = input.quote.trim()
      if (!quote) return null

      const body = input.body?.trim()
      const now = Date.now()
      const note: Note = {
        id: newId(),
        projectId,
        nodeId: input.nodeId,
        messageId: input.messageId,
        kind: input.kind,
        quote,
        start: input.start,
        end: input.end,
        ...(body ? { body } : {}),
        createdAt: now,
        updatedAt: now,
      }

      await getRepositories().notes.create(note)
      set((draft) => {
        const bucket = draft.notesByMessage[note.messageId] ?? []
        bucket.push(note)
        draft.notesByMessage[note.messageId] = sortNotes(bucket)
      })
      return note
    },

    updateNote: async (id, patch) => {
      const found = findNoteEntry(get().notesByMessage, id)
      if (!found) return

      const body = patch.body?.trim()
      const updated: Note = { ...found.note, updatedAt: Date.now() }
      if (body) {
        updated.body = body
      } else {
        delete updated.body
      }

      // 整条覆盖而不是 patch：清空批注时 body 键必须真的消失，否则「这条笔记还带批注」
      // 会被空字符串骗过去（`note.body` 有值但内容是空）。
      await getRepositories().notes.create(updated)
      set((draft) => {
        const bucket = draft.notesByMessage[found.messageId]
        if (!bucket) return
        draft.notesByMessage[found.messageId] = sortNotes(
          bucket.map((note) => (note.id === id ? updated : note)),
        )
      })
    },

    removeNote: async (id) => {
      const found = findNoteEntry(get().notesByMessage, id)
      if (!found) return

      await getRepositories().notes.remove(id)
      set((draft) => {
        const bucket = draft.notesByMessage[found.messageId]
        if (!bucket) return
        const remaining = bucket.filter((note) => note.id !== id)
        if (remaining.length > 0) {
          draft.notesByMessage[found.messageId] = remaining
        } else {
          delete draft.notesByMessage[found.messageId]
        }
      })
    },

    sendMessage: async (nodeId, parts) => {
      const state = get()
      const projectId = state.projectId
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!projectId || !node) return

      const hasContent = parts.some(
        (part) =>
          part.type === 'image' ||
          ((part.type === 'text' || part.type === 'quote') && part.text.trim().length > 0),
      )
      if (!hasContent) return

      const repositories = getRepositories()
      const userMessage: Message = {
        id: newId(),
        nodeId,
        projectId,
        role: 'user',
        parts,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      // 回答 id 预生成：新消息与回答一起占进 entries，落库顺序就不影响路径顺序
      const answerMessageId = newId()

      if (node.thread) {
        const thread = appendEntry(node.thread, [userMessage.id, answerMessageId])
        await repositories.nodes.update(nodeId, { thread })
        set((draft) => {
          const target = draft.nodes.find((item) => item.id === nodeId)
          if (target) target.thread = thread
        })
      }

      await repositories.messages.create(userMessage)
      await touchLastStudied(nodeId, userMessage.createdAt)
      set((draft) => {
        const bucket = draft.messagesByNode[nodeId] ?? []
        bucket.push(userMessage)
        draft.messagesByNode[nodeId] = bucket
      })

      const fresh = get().nodes.find((item) => item.id === nodeId)
      if (fresh) {
        const visible = resolveThread(fresh, get().messagesByNode[nodeId] ?? []).path
        const userMessages = visible.filter((message) => message.role === 'user')
        if (userMessages.length === 1 && userMessages[0].id === userMessage.id) {
          await get().setNodeTitle(nodeId, deriveTitle(userMessage))
          void refineTitle(nodeId, userMessage)
        }
      }

      await streamAssistant(nodeId, answerMessageId)
    },

    stopStreaming: () => {
      activeAbort?.abort()
      activeAbort = null
    },

    regenerate: async (nodeId, messageId) => {
      const state = get()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node) return null
      // 正在生成时不允许插入第二轮；已经失败收场的那一轮不算「正在生成」
      if (isStreamingIn(state.streaming, nodeId)) return null

      const messages = state.messagesByNode[nodeId] ?? []
      const path = resolveThread(node, messages).path
      const last = path.at(-1)
      const target = messageId
        ? path.find((message) => message.id === messageId)
        : last

      // 只有显示路径末条回答能换一版：中间那条回答后面还压着别的话，删掉它等于悄悄丢历史，
      // 想换答案应该从那里开分支/发散。用户消息也没有可重生成的对象。
      if (target?.role === 'assistant') {
        if (last?.id !== target.id) return null
        const newAnswerMessageId = newId()
        const change = openAnswerVersion({
          node,
          messages,
          messageId: target.id,
          newAnswerMessageId,
        })
        if (!change) return null
        await persistThreadChange(nodeId, change)
        await streamAssistant(nodeId, newAnswerMessageId)
        return { pruned: change.removedMessageIds.length > 0 }
      }

      if (messageId) return null
      // 末条不是回答：这一轮失败到没落库，把悬空 id 摘干净后原样重试，不新开版本
      const newAnswerMessageId = newId()
      if (node.thread) {
        const existing = new Set(messages.map((message) => message.id))
        const thread = appendEntry(pruneMissingEntries(node.thread, existing), [newAnswerMessageId])
        await persistThreadChange(nodeId, {
          thread,
          removedMessageIds: [],
          removedSlotIds: [],
        })
      }
      await streamAssistant(nodeId, newAnswerMessageId)
      return { pruned: false }
    },

    editUserMessage: async (nodeId, messageId, parts) => {
      const state = get()
      const projectId = state.projectId
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!projectId || !node) return null
      if (isStreamingIn(state.streaming, nodeId)) return null

      const messages = state.messagesByNode[nodeId] ?? []
      // 只能编辑显示路径上的消息：历史版本里的消息在屏幕上根本不存在
      const path = resolveThread(node, messages).path
      const original = path.find((message) => message.id === messageId)
      if (!original || original.role !== 'user') return null

      const hasContent = parts.some(
        (part) =>
          part.type === 'image' ||
          ((part.type === 'text' || part.type === 'quote') && part.text.trim().length > 0),
      )
      // 内容没改动或编辑成空 ⇒ 不建版本（UI 已禁用发送，这里兜底）
      if (!hasContent || sameMessageParts(original, { ...original, parts })) return null

      const newUserMessageId = newId()
      const newAnswerMessageId = newId()
      const change = createEditVersion({
        node,
        messages,
        messageId,
        newUserMessageId,
        newAnswerMessageId,
      })
      if (!change) return null

      const repositories = getRepositories()
      const newMessage: Message = {
        id: newUserMessageId,
        nodeId,
        projectId,
        role: 'user',
        parts,
        createdAt: Date.now(),
      }
      await repositories.messages.create(newMessage)
      await touchLastStudied(nodeId, newMessage.createdAt)
      await persistThreadChange(nodeId, change)
      set((draft) => {
        const bucket = draft.messagesByNode[nodeId] ?? []
        bucket.push(newMessage)
        draft.messagesByNode[nodeId] = bucket
      })

      // 编辑的是首条提问、且标题仍是它的自动标题 ⇒ 跟着更新并精修；
      // 手动改名或已被 AI 精修过就不动
      const isFirstQuestion = path.find((message) => message.role === 'user')?.id === messageId
      if (isFirstQuestion && node.title === deriveTitle(original)) {
        await get().setNodeTitle(nodeId, deriveTitle(newMessage))
        void refineTitle(nodeId, newMessage)
      }

      await streamAssistant(nodeId, newAnswerMessageId)
      return { pruned: change.removedMessageIds.length > 0 }
    },

    setSlotVersion: async (nodeId, slotId, version) => {
      const state = get()
      if (isStreamingIn(state.streaming, nodeId)) return
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node?.thread) return

      const thread = applySlotVersion(node.thread, slotId, version)
      if (thread === node.thread) return
      await getRepositories().nodes.update(nodeId, { thread })
      set((draft) => {
        const target = draft.nodes.find((item) => item.id === nodeId)
        if (target) target.thread = thread
      })
    },

    refreshSummary: async (nodeId) => {
      const node = get().nodes.find((item) => item.id === nodeId)
      if (!node) return
      // 复习中心是元数据节点，没有可评估的学习内容，不给它算掌握度
      if (node.kind === 'review') return

      // 摘要只总结当前显示的这一版（切版本后旧摘要描述的是另一版，等用户手动刷新）
      const messages = resolveThread(node, get().messagesByNode[nodeId] ?? []).path
      if (messages.length < 2) return

      const settings = useSettingsStore.getState().settings
      const model = await resolveModel(settings, settings.summaryModelRef)
      if (!model) return

      set((state) => {
        if (!state.summarizingNodeIds.includes(nodeId)) state.summarizingNodeIds.push(nodeId)
      })
      try {
        const assessment = await generateSummary(model, {
          title: node.title,
          transcript: buildTranscript(messages),
        }).catch(() => null)

        if (assessment) await get().setNodeAssessment(nodeId, assessment)
      } finally {
        set((state) => {
          state.summarizingNodeIds = state.summarizingNodeIds.filter((id) => id !== nodeId)
        })
      }
    },

    setNodeAssessment: async (nodeId, assessment) => {
      const node = get().nodes.find((item) => item.id === nodeId)
      if (!node || node.kind === 'review') return

      const now = Date.now()
      const patch: Partial<Node> = { summary: assessment.summary, updatedAt: now }

      // 结构化输出失败的 provider 只会给摘要：保留旧掌握度，只刷新摘要
      if (assessment.mastery !== null) {
        const mastery: MasterySnapshot = {
          score: assessment.mastery,
          ...(assessment.weakPoints.length > 0 ? { weakPoints: assessment.weakPoints } : {}),
          updatedAt: now,
        }
        patch.mastery = mastery
        // 第一次拿到掌握度：按档位种一张卡，节点从这一刻进入复习池。
        // 已经有卡的节点不动它的排期 —— 手动刷新摘要不该把复习进度清零。
        if (!node.review) patch.review = seedReviewCard(mastery.score, now)
      }

      await getRepositories().nodes.update(nodeId, patch)
      set((state) => {
        const target = state.nodes.find((item) => item.id === nodeId)
        if (!target) return
        Object.assign(target, patch)
      })
    },

    rateReview: async (nodeId, grade) => {
      const state = get()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node) return

      const now = Date.now()
      // 同一题已经评过再点，是「改判」而不是「又复习了一次」：
      // 卡片与掌握度都必须**从复习前的状态重算**，而不是在已评过的结果上再叠一层 ——
      // 叠一层会让一次改判被算成两次复习（reps 多算、again 的 lapses 留在卡上、
      // due 被推远），分数也会互相打脸（first=again 压到 35，改判 good 却停在 35）。
      const session = state.reviewSession
      const baseScore = session?.baseScores[nodeId] ?? node.mastery?.score ?? 50
      // `undefined` = 这道题还没评过（基准就是当前状态）；`null` = 评之前就没有卡
      const storedBaseCard = session?.baseCards[nodeId]
      const baseReview = storedBaseCard === undefined ? node.review : (storedBaseCard ?? undefined)

      // 分数只做展示：按档位给固定步长修正（保留 AI 给的薄弱点，它们仍是最近一次评估的结果）
      const mastery: MasterySnapshot = {
        ...(node.mastery ?? {}),
        score: masteryAfterGrade(baseScore, grade),
        updatedAt: now,
      }

      const patch: Partial<Node> = {
        review: nextReview(baseReview, grade, now),
        mastery,
        updatedAt: now,
      }

      await getRepositories().nodes.update(nodeId, patch)
      set((draft) => {
        const target = draft.nodes.find((item) => item.id === nodeId)
        if (target) Object.assign(target, patch)
        const current = draft.reviewSession
        if (!current || current.finishedAt) return
        current.results[nodeId] = grade
        // 首次评分时记下基准；改判不再覆盖它，保证重算始终从「没评过」出发
        if (current.baseScores[nodeId] === undefined) current.baseScores[nodeId] = baseScore
        if (current.baseCards[nodeId] === undefined) current.baseCards[nodeId] = baseReview ?? null
      })
    },

    openReviewCenter: async () => {
      const node = await ensureReviewCenter()
      if (!node) return null
      get().selectNode(node.id)
      return node
    },

    startReviewSession: async (fromNodeId) => {
      const projectId = get().projectId
      const nodes = get().nodes
      const built = buildReviewQueue(nodes, Date.now())
      // 「顺手复习」从指定节点切入：把它转到队首，其余保持原序 ——
      // 若直接跳到中间，前面的到期节点会被整场跳过，等于悄悄丢掉了它们
      const index = fromNodeId ? built.findIndex((item) => item.nodeId === fromNodeId) : 0
      const items = index > 0 ? [...built.slice(index), ...built.slice(0, index)] : built

      // 会话走完要回到复习中心看小结：从「顺手复习」进来时项目里可能还没有它，
      // 先补齐，否则最后一题评完就卡在节点上，既看不到小结也退不出去
      if (projectId && items.length > 0) await ensureReviewCenter()

      set((draft) => {
        draft.reviewSession =
          items.length > 0
            ? {
                items,
                cursor: 0,
                results: {},
                baseScores: {},
                baseCards: {},
                startedAt: Date.now(),
              }
            : null
        const first = items[0]
        if (first) {
          draft.selectedNodeId = first.nodeId
          draft.viewMode = 'chat'
        }
      })
      return items
    },

    advanceReviewSession: () => {
      set((draft) => {
        const session = draft.reviewSession
        if (!session || session.finishedAt) return
        session.cursor = Math.min(session.cursor + 1, session.items.length)
        if (session.cursor >= session.items.length) {
          session.finishedAt = Date.now()
          // 走完回到复习中心看小结：会话在队列里，回原节点会让人以为还没结束
          const center = draft.nodes.find(
            (node) => node.kind === 'review' && node.status === 'active',
          )
          if (center) {
            draft.selectedNodeId = center.id
            draft.viewMode = 'chat'
          } else {
            // 复习中心被删/归档了：直接收掉会话，别留下「已结束但关不掉」的僵尸
            draft.reviewSession = null
          }
          return
        }
        draft.selectedNodeId = session.items[session.cursor].nodeId
        draft.viewMode = 'chat'
      })
    },

    endReviewSession: () => {
      set((draft) => {
        draft.reviewSession = null
      })
    },

    clearError: () => {
      set((state) => {
        state.error = null
      })
    },
  })),
)

/**
 * 确保当前项目有复习中心，返回它（没有就建一个并落库）。
 *
 * 会话的结束落点就是复习中心，所以「开始复习」之前必须先备好 —— 从
 * 「顺手复习」进来的用户可能从没打开过复习中心，缺了它最后一题评完就
 * 无处可去。刻意不负责选中：调用方各自决定光标落在哪。
 */
async function ensureReviewCenter(): Promise<Node | null> {
  const state = useWorkspaceStore.getState()
  const projectId = state.projectId
  if (!projectId) return null

  const existing = findReviewCenter(state.nodes)
  if (existing) return existing

  const node = createReviewCenterNode({ projectId })
  await getRepositories().nodes.create(node)
  useWorkspaceStore.setState((draft) => {
    draft.nodes.push(node)
  })
  touchProject(projectId)
  return node
}

/**
 * 「最后学习时间」的唯一写入口：消息落库处调用。
 *
 * 取消息自己的 `createdAt`（新消息总是接在显示路径末尾），而不是 `node.updatedAt`
 * —— 重命名、拖拽、生成摘要都会改 updatedAt，用它会把整理动作误读成学习。
 * 只前进不后退：切到历史版本不改变「上次学习」的语义。
 */
async function touchLastStudied(nodeId: Id, at: number): Promise<void> {
  const node = useWorkspaceStore.getState().nodes.find((item) => item.id === nodeId)
  if (!node) return
  if (node.lastStudiedAt !== undefined && node.lastStudiedAt >= at) return

  await getRepositories().nodes.update(nodeId, { lastStudiedAt: at })
  useWorkspaceStore.setState((draft) => {
    const target = draft.nodes.find((item) => item.id === nodeId)
    if (target) target.lastStudiedAt = at
  })
}

async function refineTitle(nodeId: Id, message: Message): Promise<void> {
  const settings = useSettingsStore.getState().settings
  const model = await resolveModel(settings, settings.titleModelRef)
  if (!model) return

  const title = await generateTitle(model, message).catch(() => null)
  if (title) await useWorkspaceStore.getState().setNodeTitle(nodeId, title)
}

/**
 * 把 thread 变更落库：节点更新 + 淘汰版本的消息与笔记级联清理，再同步内存状态。
 */
async function persistThreadChange(nodeId: Id, change: ThreadChange): Promise<void> {
  const repositories = getRepositories()
  await repositories.nodes.update(nodeId, { thread: change.thread })
  if (change.removedMessageIds.length > 0) {
    await Promise.all(
      change.removedMessageIds.flatMap((messageId) => [
        repositories.messages.remove(messageId),
        repositories.notes.removeByMessage(messageId),
      ]),
    )
  }
  useWorkspaceStore.setState((draft) => {
    const node = draft.nodes.find((item) => item.id === nodeId)
    if (node) node.thread = change.thread
    if (change.removedMessageIds.length > 0) {
      const removed = new Set(change.removedMessageIds)
      draft.messagesByNode[nodeId] = (draft.messagesByNode[nodeId] ?? []).filter(
        (message) => !removed.has(message.id),
      )
      for (const messageId of change.removedMessageIds) delete draft.notesByMessage[messageId]
    }
  })
}

/** 这一轮失败到回答没落库时，把预生成的悬空 id 从 entries 里摘掉。 */
async function pruneDanglingMessage(nodeId: Id, messageId: Id): Promise<void> {
  const state = useWorkspaceStore.getState()
  const node = state.nodes.find((item) => item.id === nodeId)
  if (!node?.thread) return
  if (state.messagesByNode[nodeId]?.some((message) => message.id === messageId)) return

  const thread = pruneEntry(node.thread, messageId)
  await getRepositories().nodes.update(nodeId, { thread })
  useWorkspaceStore.setState((draft) => {
    const target = draft.nodes.find((item) => item.id === nodeId)
    if (target) target.thread = thread
  })
}

async function streamAssistant(nodeId: Id, messageId: Id = newId()): Promise<void> {
  const store = useWorkspaceStore
  const state = store.getState()
  const projectId = state.projectId
  const node = state.nodes.find((item) => item.id === nodeId)
  if (!projectId || !node) return

  const settings = useSettingsStore.getState().settings
  const projectSettings = state.projectSettings
  const modelRef = projectSettings?.chatModelRef ?? settings.defaultChatModelRef

  store.setState((draft) => {
    draft.streaming = { nodeId, messageId, text: '', startedAt: Date.now() }
  })

  let model
  try {
    model = await requireModel(settings, modelRef, '对话模型')
  } catch (error) {
    const info = describeLlmError(error)
    store.setState((draft) => {
      if (draft.streaming) draft.streaming.error = formatErrorMessage(info)
    })
    await pruneDanglingMessage(nodeId, messageId)
    return
  }

  const repositories = getRepositories()
  const nodes = state.nodes
  const messagesByNode = new Map(Object.entries(state.messagesByNode))
  const segments = collectHistorySegments(node, nodes, messagesByNode)
  const assetIds = segments.flatMap((segment) =>
    segment.messages.flatMap((message) => messageImageIds(message)),
  )
  const assetUrls =
    assetIds.length > 0 ? await loadAssetUrls(repositories.assets, assetIds) : new Map()

  // 这一轮是不是复习会话里的当前题：是的话导师走「回忆优先」的规则
  const sessionItem = currentReviewItem(store.getState().reviewSession)
  const context = assembleContext({
    node,
    nodes,
    messagesByNode,
    assetUrls,
    backgroundProfile: settings.backgroundProfile,
    projectBackground: projectSettings?.backgroundProfile,
    projectSystemPrompt: projectSettings?.systemPrompt,
    budgetTokens: settings.contextBudget,
    reviewMode: sessionItem?.nodeId === nodeId ? sessionItem.mode : undefined,
    now: Date.now(),
  })

  const abortController = new AbortController()
  activeAbort = abortController

  try {
    const result = await streamReply({
      model,
      system: context.system,
      messages: toModelMessages(context.messages),
      abortSignal: abortController.signal,
      onDelta: (delta) => {
        store.setState((draft) => {
          if (draft.streaming?.messageId === messageId) {
            draft.streaming.text += delta
          }
        })
      },
    })

    const assistantMessage: Message = {
      id: messageId,
      nodeId,
      projectId,
      role: 'assistant',
      parts: [{ type: 'text', text: result.text }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      meta: {
        providerId: modelRef?.providerId,
        modelId: modelRef?.modelId,
        usage: result.usage,
        incomplete: result.aborted,
      },
    }

    await repositories.messages.create(assistantMessage)
    await touchLastStudied(nodeId, assistantMessage.createdAt)
    store.setState((draft) => {
      const bucket = draft.messagesByNode[nodeId] ?? []
      bucket.push(assistantMessage)
      draft.messagesByNode[nodeId] = bucket
      draft.streaming = null
    })

    touchProject(projectId)
  } catch (error) {
    const partial = store.getState().streaming?.text ?? ''
    const info = describeLlmError(error)

    if (partial.trim()) {
      const partialMessage: Message = {
        id: messageId,
        nodeId,
        projectId,
        role: 'assistant',
        parts: [{ type: 'text', text: partial }],
        createdAt: Date.now(),
        updatedAt: Date.now(),
        meta: {
          providerId: modelRef?.providerId,
          modelId: modelRef?.modelId,
          error: info.message,
          errorHint: info.hint,
          incomplete: true,
        },
      }
      try {
        await repositories.messages.create(partialMessage)
        await touchLastStudied(nodeId, partialMessage.createdAt)
      } catch {
        // ignore storage errors on the error path
      }
      store.setState((draft) => {
        const bucket = draft.messagesByNode[nodeId] ?? []
        bucket.push(partialMessage)
        draft.messagesByNode[nodeId] = bucket
        draft.streaming = null
      })
    } else {
      store.setState((draft) => {
        if (draft.streaming) draft.streaming.error = formatErrorMessage(info)
      })
      // 回答没落库，留给这一版的那个 id 就成了悬空占位，摘掉
      await pruneDanglingMessage(nodeId, messageId)
    }
  } finally {
    activeAbort = null
  }
}