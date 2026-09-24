import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getRepositories } from '@/data'
import { assembleContext, collectHistorySegments } from '@/domain/context/assemble'
import {
  deriveTitle,
  messageImageIds,
  messageText,
  sameMessageParts,
} from '@/domain/messages'
import type {
  Id,
  MasterySnapshot,
  Message,
  MessagePart,
  Node,
  Note,
  NoteLabel,
  Project,
  ProjectSettings,
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
import { sortNotes, normalizeNoteBody, normalizeNoteLabels, formatNoteLabels } from '@/domain/notes'
import { createNodeFromAction, nodeActionRequiresMessage, type NodeActionKind } from '@/domain/node-ops/actions'
import { buildTreeIndex, descendantsOf } from '@/domain/tree/tree'
import { seedReviewCard } from '@/domain/review/schedule'
import { threadPathFingerprint } from '@/domain/thread/resolve'
import { newId } from '@/lib/id'
import { streamReply, toModelMessages } from '@/services/llm/chat'
import { findProvider } from '@/services/llm/catalog'
import { clampAgentMaxSteps } from '@/domain/defaults'
import {
  TOOLS_SYSTEM,
  WRITE_TOOLS_SYSTEM,
  buildReadOnlyTools,
  buildWriteTools,
  type ToolRuntime,
  type WriteToolHandlers,
} from '@/services/llm/tools/registry'
import {
  buildTranscript,
  generateSummary,
  generateTitle,
  type SummaryAssessment,
} from '@/services/llm/derive'
import { describeLlmError, formatErrorMessage } from '@/services/llm/errors'
import { requireModel, resolveModel } from '@/services/llm/providers'
import { loadAssetUrls } from '@/services/images'
import {
  clearLastOpenedNodeId,
  getLastOpenedNodeId,
  setLastOpenedNodeId,
} from '@/lib/last-opened-node'
import { touchProject } from './projects-store'
import { useSettingsStore } from './settings-store'

export type WorkspaceViewMode = 'chat' | 'canvas'

/** 本轮发生的一次只读工具调用（P-A 只在流式期间可见，不落库）。 */
export interface StreamingToolActivity {
  callId: string
  name: string
  /** 模型给的参数（已过 zod 校验） */
  input: unknown
  status: 'running' | 'done' | 'error'
  /** 工具返回值（已限长）；展开卡片时展示 */
  output?: string
  error?: string
}

export interface StreamingState {
  nodeId: Id
  messageId: Id
  text: string
  /**
   * 本轮的只读工具调用，按发生顺序。
   *
   * P-A 阶段**不落库**：工具过程只在流式期间可见，落库仍然只有正文 —— 于是历史里
   * 不存在半截的「举手记录」，配对撕裂的风险在这一期不存在（见设计文档 §9 一期 A）。
   */
  tools: StreamingToolActivity[]
  /** 步数用尽就停下（最后一步还在调工具）：答案可能不完整，界面要如实提示 */
  hitStepLimit?: boolean
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

/** 新建标注的入参：锚点是「正文纯文本里的字符区间」，由框选那一刻算好传进来。 */
export interface NewNoteInput {
  nodeId: Id
  messageId: Id
  /** 标签；缺省或空数组 = 纯高亮（书签，默认不进 AI 上下文） */
  labels?: NoteLabel[]
  quote: string
  start: number
  end: number
  body?: string
}

/** 一次由 Agent 完成的改动：给用户看的一句话 + 撤销它的动作。 */
export interface AgentChange {
  label: string
  undo: () => Promise<void>
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
  /**
   * Agent 刚做完的改动（可撤销）。只留最近一条：撤销入口是「后悔药」，
   * 不是操作历史；堆一长串既难懂也难用（真正的历史是画布本身）。
   */
  agentChange: AgentChange | null

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
  updateNote: (id: Id, patch: { body?: string; labels?: NoteLabel[] }) => Promise<void>
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
  /** 写入一次学习评估：只写摘要与掌握度；**绝不自动种卡、不自动加入复习计划** */
  setNodeAssessment: (nodeId: Id, assessment: SummaryAssessment) => Promise<void>
  /** 用户明确点击「加入复习计划」：以当前时间初始化卡片并打上 enabled 开关 */
  enrollInReview: (nodeId: Id) => Promise<void>
  /** 移出复习计划：停止到期提醒，保留历史卡片与掌握度 */
  unenrollFromReview: (nodeId: Id) => Promise<void>
  /** 撤销 Agent 刚做的改动（建节点 / 改标题 / 打标签） */
  undoAgentChange: () => Promise<void>
  dismissAgentChange: () => void
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
    agentChange: null,

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

      // 优先恢复用户上次在本项目中打开的节点；若未记录或节点已失效（删除/归档），降级到最新活跃节点
      const activeNodes = nodes.filter((n) => n.status === 'active')
      const lastOpenedId = getLastOpenedNodeId(projectId)
      const rememberedNode = lastOpenedId ? activeNodes.find((n) => n.id === lastOpenedId) : null
      const latestNode = [...activeNodes].sort((a, b) => b.updatedAt - a.updatedAt)[0]
      const defaultNode = rememberedNode ?? latestNode

      // 如果记录的节点已失效，清理无效记录以保持存储整洁
      if (lastOpenedId && !rememberedNode) {
        clearLastOpenedNodeId(projectId)
      }

      set((state) => {
        state.project = project
        state.projectSettings = projectSettings ?? { projectId }
        state.nodes = nodes
        state.messagesByNode = groupMessages(messages)
        state.notesByMessage = groupNotes(notes)
        state.selectedNodeId = defaultNode?.id ?? null
        state.viewMode = defaultNode ? 'chat' : 'canvas'
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
      })
    },

    selectNode: (id) => {
      const projectId = get().projectId
      if (projectId) {
        if (id) {
          setLastOpenedNodeId(projectId, id)
        } else {
          clearLastOpenedNodeId(projectId)
        }
      }
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
      setLastOpenedNodeId(projectId, node.id)
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
      setLastOpenedNodeId(projectId, node.id)
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
      const currentProjectId = get().projectId
      if (currentProjectId) {
        const lastOpened = getLastOpenedNodeId(currentProjectId)
        if (lastOpened && targetSet.has(lastOpened)) {
          clearLastOpenedNodeId(currentProjectId)
        }
      }
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

      if (projectId) {
        touchProject(projectId)
        const lastOpened = getLastOpenedNodeId(projectId)
        if (lastOpened && targetSet.has(lastOpened)) {
          clearLastOpenedNodeId(projectId)
        }
      }
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

      const labels = normalizeNoteLabels(input.labels)
      const body = normalizeNoteBody(input.body)
      const now = Date.now()
      const note: Note = {
        id: newId(),
        projectId,
        nodeId: input.nodeId,
        messageId: input.messageId,
        labels,
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

      const body = normalizeNoteBody(patch.body)
      const updated: Note = {
        ...found.note,
        // 只改传进来的那部分：改备注不该把标签抹掉，改标签也不该丢备注
        labels: patch.labels === undefined ? found.note.labels : normalizeNoteLabels(patch.labels),
        updatedAt: Date.now(),
      }
      if (body) {
        updated.body = body
      } else {
        delete updated.body
      }

      // 整条覆盖而不是 patch：清空备注时 body 键必须真的消失，否则「这条标注还带备注」
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
        // 记录本次评估依据的学习时间与对话路径指纹，来源标为 'ai'
        const visible = resolveThread(node, get().messagesByNode[nodeId] ?? []).path
        const basedOnPath = threadPathFingerprint(visible)
        patch.assessmentMeta = {
          assessedAt: now,
          basedOnStudiedAt: node.lastStudiedAt,
          basedOnPath,
          source: 'ai',
        }
        // D10：生成摘要与加入复习计划彻底分开！
        // 新生成评估的主题默认保持 disabled，已有计划的节点保留其原排期。
        // 绝不偷偷调用 seedReviewCard() 把未确认的主题加入复习池。
      }

      await getRepositories().nodes.update(nodeId, patch)
      set((state) => {
        const target = state.nodes.find((item) => item.id === nodeId)
        if (!target) return
        Object.assign(target, patch)
      })
    },

    enrollInReview: async (nodeId) => {
      const node = get().nodes.find((item) => item.id === nodeId)
      if (!node || !node.mastery) return

      const now = Date.now()
      const patch: Partial<Node> = {
        reviewEnrollment: 'enabled',
        // 首次加入时种卡（按当前时间，不使用历史时间，防止刚加入就堆积虚假逾期）
        review: node.review ?? seedReviewCard(node.mastery.score, now),
        updatedAt: now,
      }
      await getRepositories().nodes.update(nodeId, patch)
      set((state) => {
        const target = state.nodes.find((item) => item.id === nodeId)
        if (target) Object.assign(target, patch)
      })
    },

    unenrollFromReview: async (nodeId) => {
      const node = get().nodes.find((item) => item.id === nodeId)
      if (!node) return

      const now = Date.now()
      // 移出计划停止到期提醒，保留历史卡片与掌握度
      const patch: Partial<Node> = {
        reviewEnrollment: 'disabled',
        updatedAt: now,
      }
      await getRepositories().nodes.update(nodeId, patch)
      set((state) => {
        const target = state.nodes.find((item) => item.id === nodeId)
        if (target) Object.assign(target, patch)
      })
    },

    clearError: () => {
      set((state) => {
        state.error = null
      })
    },

    undoAgentChange: async () => {
      const change = get().agentChange
      if (!change) return
      set((state) => {
        state.agentChange = null
      })
      await change.undo()
    },

    dismissAgentChange: () => {
      set((state) => {
        state.agentChange = null
      })
    },
  })),
)

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

/**
 * 把本轮流式期间的完成型工具活动转成可落库的 parts。
 *
 * 只收 `done` / `error`：`running` 是「举手了但没等到结果」——
 * 半截记录落库会破坏 provider 要求的配对（见设计文档 §6.2），一律丢弃。
 */
function collectToolParts(
  activities: StreamingToolActivity[] | undefined,
): MessagePart[] {
  return (activities ?? [])
    .filter((tool) => tool.status !== 'running')
    .map((tool) => ({
      type: 'tool' as const,
      callId: tool.callId,
      name: tool.name,
      input: tool.input,
      ...(tool.output !== undefined ? { output: tool.output } : {}),
      ...(tool.error !== undefined ? { error: tool.error } : {}),
    }))
}

/**
 * 一条 assistant 消息的 parts：工具记录在前、正文在后。
 *
 * 这是一个刻意的简化：模型分步时通常是「先查、再答」，正文只出现在最后一步，
 * 所以「工具 → 正文」与真实时序一致；中间步骤若也有正文，会被排到工具之后 ——
 * 配对仍然完整、语义仍然成立，只是步骤边界被抹平了。
 */
function assistantParts(text: string, tools: MessagePart[]): MessagePart[] {
  return [...tools, { type: 'text', text }]
}

/**
 * Agent 的写操作落点：只做**可逆**的三件事，每件都留一条可撤销记录。
 *
 * 放在 store 里而不是工具里：写操作必须走既有 action（版本结构、台账、级联都在
 * 那些函数里），工具只负责「把模型的意图翻译成一次 action 调用」。
 */
function createWriteHandlers(
  store: typeof useWorkspaceStore,
  nodeId: Id,
): WriteToolHandlers {
  const remember = (change: AgentChange) => {
    store.setState((draft) => {
      draft.agentChange = change
    })
  }

  return {
    createNode: async ({ kind, title, seed, fromMessageId }) => {
      const state = store.getState()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node) return null

      // 从某条消息分出来才需要 fork 点；child 永远是空白上下文
      const forkPoint =
        kind === 'child'
          ? undefined
          : (fromMessageId ??
            resolveThread(node, state.messagesByNode[nodeId] ?? []).path.at(-1)?.id)

      const created = await store.getState().applyAction(kind, nodeId, forkPoint)
      if (!created) return null

      const trimmed = title.trim() || '新节点'
      await store.getState().setNodeTitle(created.id, trimmed)

      // seed 只落成这个节点的第一条提问，**不触发新一轮对话** ——
      // 在一个工具步里再发一次完整请求，成本与耗时都不可控；用户点进去继续即可
      if (seed?.trim()) {
        const projectId = store.getState().projectId
        if (projectId) {
          const message: Message = {
            id: newId(),
            nodeId: created.id,
            projectId,
            role: 'user',
            parts: [{ type: 'text', text: seed.trim() }],
            createdAt: Date.now(),
            updatedAt: Date.now(),
          }
          await getRepositories().messages.create(message)
          store.setState((draft) => {
            const bucket = draft.messagesByNode[created.id] ?? []
            bucket.push(message)
            draft.messagesByNode[created.id] = bucket
          })
        }
      }

      remember({
        label: `新建了节点《${trimmed}》`,
        undo: async () => {
          await store.getState().deleteNode(created.id)
        },
      })
      return { label: `新建了节点《${trimmed}》`, nodeId: created.id }
    },

    renameNode: async ({ nodeId: target, title }) => {
      const state = store.getState()
      const node = state.nodes.find((item) => item.id === target)
      if (!node) return null
      const previous = node.title
      const trimmed = title.trim()
      if (!trimmed || trimmed === previous) return null

      await store.getState().setNodeTitle(target, trimmed)
      remember({
        label: `把《${previous}》改名为《${trimmed}》`,
        undo: async () => {
          await store.getState().setNodeTitle(target, previous)
        },
      })
      return { label: `《${previous}》改名为《${trimmed}》`, nodeId: target }
    },

    tagSpan: async ({ messageId, quote, labels, body }) => {
      const state = store.getState()
      const node = state.nodes.find((item) => item.id === nodeId)
      if (!node) return null

      const text = messageText(
        (state.messagesByNode[nodeId] ?? []).find((message) => message.id === messageId) ?? {
          parts: [],
        } as unknown as Message,
      )
      const start = text.indexOf(quote)
      if (start < 0) return null

      const note = await store.getState().addNote({
        nodeId,
        messageId,
        labels,
        quote,
        start,
        end: start + quote.length,
        ...(body !== undefined ? { body } : {}),
      })
      if (!note) return null

      const label = formatNoteLabels(note.labels)
      remember({
        label: `给一段原文打了标签 ${label}`,
        undo: async () => {
          await store.getState().removeNote(note.id)
        },
      })
      return { label: `已打标签 ${label}`, noteId: note.id }
    },
  }
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
    draft.streaming = {
      nodeId,
      messageId,
      text: '',
      tools: [],
      startedAt: Date.now(),
    }
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

  const context = assembleContext({
    node,
    nodes,
    messagesByNode,
    assetUrls,
    projectName: state.project?.name,
    projectDescription: state.project?.description,
    backgroundProfile: settings.backgroundProfile,
    projectBackground: projectSettings?.backgroundProfile,
    projectSystemPrompt: projectSettings?.systemPrompt,
    budgetTokens: settings.contextBudget,
    now: Date.now(),
  })

  // 能力位：false = 明确不支持（完全不带工具，请求体与今天逐字节一致）；
  // undefined = 还没探过 —— 先按支持试一次，失败再退回无工具重试（见下方 catch）。
  const writeRuntime: ToolRuntime = {
    nodes,
    messagesByNode,
    notes: Object.values(state.notesByMessage).flat(),
    currentNodeId: nodeId,
  }
  const provider = findProvider(settings.providers, modelRef)
  const capabilityUnknown = provider?.capabilities?.tools === undefined
  const toolsAllowed = provider?.capabilities?.tools !== false
  const writeEnabled = projectSettings?.agentWriteEnabled === true
  const tools = toolsAllowed
    ? {
        ...buildReadOnlyTools({
          nodes,
          messagesByNode,
          notes: Object.values(state.notesByMessage).flat(),
          currentNodeId: nodeId,
        }),
        // 写工具跟着项目开关走：默认关闭（见 ProjectSettings.agentWriteEnabled）
        ...(writeEnabled ? buildWriteTools(writeRuntime, createWriteHandlers(store, nodeId)) : {}),
      }
    : undefined
  // 写工具只在真带上时才向模型承诺「你能改树」
  const toolSystem = writeEnabled ? `${TOOLS_SYSTEM}\n\n${WRITE_TOOLS_SYSTEM}` : TOOLS_SYSTEM

  const abortController = new AbortController()
  activeAbort = abortController

  const run = (withTools: boolean) =>
    streamReply({
      model,
      system: withTools ? `${context.system}\n\n${toolSystem}` : context.system,
      messages: toModelMessages(context.messages),
      abortSignal: abortController.signal,
      ...(withTools && tools ? { tools, maxSteps: clampAgentMaxSteps(settings.agentMaxSteps) } : {}),
      onDelta: (delta) => {
        store.setState((draft) => {
          if (draft.streaming?.messageId === messageId) {
            draft.streaming.text += delta
          }
        })
      },
      onToolCall: (activity) => {
        store.setState((draft) => {
          if (draft.streaming?.messageId !== messageId) return
          draft.streaming.tools.push({
            callId: activity.callId,
            name: activity.name,
            input: activity.input,
            status: 'running',
          })
        })
      },
      onToolResult: (outcome) => {
        store.setState((draft) => {
          if (draft.streaming?.messageId !== messageId) return
          const entry = draft.streaming.tools.find((item) => item.callId === outcome.callId)
          if (!entry) return
          if (outcome.error !== undefined) {
            entry.status = 'error'
            entry.error = outcome.error
          } else {
            entry.status = 'done'
            entry.output = outcome.output
          }
        })
      },
    })

  try {
    let result: Awaited<ReturnType<typeof run>>
    let usedTools = tools !== undefined

    try {
      result = await run(usedTools)
    } catch (error) {
      // 能力未知时的静默降级：带工具失败就退回无工具重试一次，并把结论记下来。
      // 探过一次之后不再重试（capabilities.tools 会被写成 false）。
      const canRetry = usedTools && capabilityUnknown && !abortController.signal.aborted
      if (!canRetry) throw error
      usedTools = false
      store.setState((draft) => {
        if (draft.streaming?.messageId === messageId) {
          draft.streaming.tools = []
          draft.streaming.text = ''
        }
      })
      result = await run(false)
      // 不带工具能成功 ⇒ 问题出在工具这一路，把这个结论落进 provider 能力位
      void rememberToolCapability(provider?.id, false)
    }

    // 真的调过工具 ⇒ 这个提供商支持工具调用，把结论记下来（省掉下次的探测）
    if (result.toolCalls > 0 && provider?.capabilities?.tools !== true) {
      void rememberToolCapability(provider?.id, true)
    }

    const assistantMessage: Message = {
      id: messageId,
      nodeId,
      projectId,
      role: 'assistant',
      parts: assistantParts(result.text, collectToolParts(store.getState().streaming?.tools)),
      createdAt: Date.now(),
      updatedAt: Date.now(),
      meta: {
        providerId: modelRef?.providerId,
        modelId: modelRef?.modelId,
        usage: result.usage,
        incomplete: result.aborted,
      },
    }
    if (result.hitStepLimit) {
      store.setState((draft) => {
        if (draft.streaming?.messageId === messageId) draft.streaming.hitStepLimit = true
      })
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
        // 中断也保留**已完成**的工具记录：那是真实发生过的检索，只有半截的才丢
        parts: assistantParts(partial, collectToolParts(store.getState().streaming?.tools)),
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

/**
 * 把探测结论写进 provider 的能力位（失败忽略：能力位是优化，不是必需）。
 *
 * 写在对话流程里而不是只在连接测试时探：真实对话里「调没调过工具」是最硬的证据，
 * 顺手记下来，用户就不必为了能力位专门去点一次「测试连接」。
 */
async function rememberToolCapability(
  providerId: Id | undefined,
  tools: boolean,
): Promise<void> {
  if (!providerId) return
  try {
    await useSettingsStore.getState().updateProvider(providerId, { capabilities: { tools } })
  } catch {
    // ignore：能力位写失败不影响这一轮对话
  }
}