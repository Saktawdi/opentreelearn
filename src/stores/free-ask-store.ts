import { create } from 'zustand'
import type { ContextMessage } from '@/domain/context/assemble'
import type { Id } from '@/domain/models'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { runFreeAskRequest } from '@/services/llm/free-ask'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore, type StreamingToolActivity } from './workspace-store'

/**
 * 复习工作区「自由问答」的会话状态。
 *
 * **只在内存里**：问答是「睡前问一句进度」的临时内容，既不写节点对话（会污染
 * 可见路径、分支继承与版本结构），也不进复习会话（那里记的是评分与草稿）。
 * 代价是刷新即清空，换来的是零迁移、零同步语义 —— 这份内容的生命周期就该只是一次对话。
 *
 * 项目切走时必须清空（`syncProject`）：答疑内容带着上一个项目的主题标题，
 * 留在面板里比丢掉更糟。
 */

export interface FreeAskMessage {
  id: Id
  role: 'user' | 'assistant'
  /** 展示文本：评分标记已剥掉（本项目约定：标记既不出现在正文，也不出现在预览里） */
  text: string
  createdAt: number
  /** 正文不完整（用户中断 / 请求失败后留下的部分内容） */
  incomplete?: boolean
}

interface FreeAskState {
  /** 当前对话所属项目；与传入项目不一致时整段丢弃 */
  projectId: Id | null
  messages: FreeAskMessage[]
  streaming: { text: string; tools: StreamingToolActivity[] } | null
  error: string | null
  /** 如实说明本次参考了多少个主题：清单会按上下文预算裁剪，用户有权知道 */
  contextNote: string | null
  ask: (question: string) => Promise<void>
  cancel: () => void
  reset: () => void
  syncProject: (projectId: Id | null) => void
}

let freeAskAbort: AbortController | null = null

function stopStreaming(): void {
  freeAskAbort?.abort()
  freeAskAbort = null
}

export const useFreeAskStore = create<FreeAskState>()((set, get) => ({
  projectId: null,
  messages: [],
  streaming: null,
  error: null,
  contextNote: null,

  ask: async (question) => {
    const trimmed = question.trim()
    if (!trimmed) return

    const workspace = useWorkspaceStore.getState()
    const settings = useSettingsStore.getState().settings
    if (!workspace.projectId) return

    // 上一次还没回来就又问：旧请求作废，避免两段回答交叉着往同一条消息上追加
    stopStreaming()
    const controller = new AbortController()
    freeAskAbort = controller

    const history: ContextMessage[] = get().messages.map((message) => ({
      role: message.role,
      parts: [{ type: 'text', text: message.text }],
    }))
    const asked: FreeAskMessage = {
      id: newId(),
      role: 'user',
      text: trimmed,
      createdAt: Date.now(),
    }
    set((state) => ({
      projectId: state.projectId ?? workspace.projectId,
      messages: [...state.messages, asked],
      streaming: { text: '', tools: [] },
      error: null,
      contextNote: null,
    }))

    const result = await runFreeAskRequest({
      settings,
      projectSettings: workspace.projectSettings,
      projectName: workspace.project?.name,
      projectDescription: workspace.project?.description,
      nodes: workspace.nodes,
      // 标注带标签的那些会随上下文一起给模型（「我有哪些还没搞懂的」全靠它）
      notes: Object.values(workspace.notesByMessage).flat(),
      history,
      text: trimmed,
      signal: controller.signal,
      onToolCall: (activity) => {
        if (freeAskAbort !== controller) return
        const current = get().streaming
        if (!current) return
        set({
          streaming: {
            ...current,
            tools: [
              ...current.tools,
              {
                callId: activity.callId,
                name: activity.name,
                input: activity.input,
                status: 'running' as const,
              },
            ],
          },
        })
      },
      onToolResult: (outcome) => {
        if (freeAskAbort !== controller) return
        const current = get().streaming
        if (!current) return
        set({
          streaming: {
            ...current,
            tools: current.tools.map((tool) =>
              tool.callId !== outcome.callId
                ? tool
                : outcome.error !== undefined
                  ? { ...tool, status: 'error' as const, error: outcome.error }
                  : { ...tool, status: 'done' as const, output: outcome.output },
            ),
          },
        })
      },
      onDelta: (delta) => {
        // 迟到的回调（已被取消 / 已被新请求替换）直接丢弃
        if (freeAskAbort !== controller) return
        const current = get().streaming
        if (current) set({ streaming: { ...current, text: current.text + delta } })
      },
    })

    if (freeAskAbort !== controller) return
    freeAskAbort = null

    if (result.ok) {
      const output = result.output
      const answer: FreeAskMessage = {
        id: newId(),
        role: 'assistant',
        text: output.clean || '（模型没有返回内容）',
        createdAt: Date.now(),
        incomplete: output.aborted ? true : undefined,
      }
      set((state) => ({
        messages: [...state.messages, answer],
        streaming: null,
        error: output.aborted ? '回答被中断，内容不完整。' : null,
        contextNote: `本次参考了 ${output.listed} / ${output.total} 个主题${
          output.notes > 0 ? `、${output.notes} 条用户标注` : ''
        }`,
      }))
      return
    }

    // 失败：保住已经生成的部分（那是用户看得见的内容），错误另置一处，可再问一次
    const partial = stripReviewRating(result.failure.partial)
    set((state) => ({
      messages: partial.trim()
        ? [
            ...state.messages,
            {
              id: newId(),
              role: 'assistant' as const,
              text: partial,
              createdAt: Date.now(),
              incomplete: true,
            },
          ]
        : state.messages,
      streaming: null,
      error: result.failure.message,
    }))
  },

  cancel: () => {
    const partial = get().streaming?.text ?? ''
    stopStreaming()
    set((state) => ({
      messages: partial.trim()
        ? [
            ...state.messages,
            {
              id: newId(),
              role: 'assistant' as const,
              text: stripReviewRating(partial),
              createdAt: Date.now(),
              incomplete: true,
            },
          ]
        : state.messages,
      streaming: null,
    }))
  },

  reset: () => {
    stopStreaming()
    set({ messages: [], streaming: null, error: null, contextNote: null })
  },

  syncProject: (projectId) => {
    if (get().projectId === projectId) return
    stopStreaming()
    set({ projectId, messages: [], streaming: null, error: null, contextNote: null })
  },
}))