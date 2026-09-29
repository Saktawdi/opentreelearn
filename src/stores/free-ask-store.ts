import { create } from 'zustand'
import i18n from '@/i18n'
import { getRepositories } from '@/data'
import type { ContextMessage } from '@/domain/context/assemble'
import type { Asset, Id } from '@/domain/models'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { createImageAsset, assetToDataUrl } from '@/services/images'
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
 *
 * 输入框草稿（`draft`）也放在这里，与对话同一份生命周期：输入框本体复用对话页的
 * `ComposerShell`，但草稿不落 IndexedDB —— 会话页的对话是落库的，草稿才跟着落库；
 * 这里的问答刷新即清空，草稿随会话走内存才不会出现「问句还在、对话没了」的错位。
 */

export interface FreeAskMessage {
  id: Id
  role: 'user' | 'assistant'
  /** 展示文本：评分标记已剥掉（本项目约定：标记既不出现在正文，也不出现在预览里） */
  text: string
  createdAt: number
  /** 正文不完整（用户中断 / 请求失败后留下的部分内容） */
  incomplete?: boolean
  /** 随问附上的图片资产 id：展示用，模型侧走 dataUrl（见 historyParts） */
  imageIds?: Id[]
}

/** 待发图片：asset 已压缩登记（发送时才写进 assets 表），url 仅供预览。 */
export interface FreeAskPendingImage {
  asset: Asset
  url: string
}

interface FreeAskState {
  /** 当前对话所属项目；与传入项目不一致时整段丢弃 */
  projectId: Id | null
  messages: FreeAskMessage[]
  streaming: { text: string; tools: StreamingToolActivity[] } | null
  error: string | null
  /** 如实说明本次参考了多少个主题：清单会按上下文预算裁剪，用户有权知道 */
  contextNote: string | null
  /** 已发出问句的图片 dataUrl 缓存（assetId → dataUrl）：拼历史上下文时用，免得每轮重读 blob */
  imageUrlsByMessage: Record<Id, string>
  /** 输入框草稿：关掉面板再回来还在，随对话一起被项目切换/清空带走 */
  draft: string
  setDraft: (value: string) => void
  /** 待发图片：粘贴/拖放/选择进来，随下一次提问发出 */
  pendingImages: FreeAskPendingImage[]
  attachImages: (files: File[]) => Promise<void>
  removePendingImage: (assetId: Id) => void
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
  imageUrlsByMessage: {},
  draft: '',
  pendingImages: [],

  setDraft: (value) => set({ draft: value }),

  attachImages: async (files) => {
    if (files.length === 0) return
    const projectId = useWorkspaceStore.getState().projectId
    if (!projectId) return
    try {
      const created = await Promise.all(
        files.map(async (file) => {
          const asset = await createImageAsset(file, projectId)
          return { asset, url: URL.createObjectURL(asset.blob) }
        }),
      )
      set((state) => ({ pendingImages: [...state.pendingImages, ...created] }))
    } catch {
      // 压缩/解码失败不打断输入：图片是补充，不是提问的载体
      set({ error: i18n.t('review:freeAsk.imageReadFailed') })
    }
  },

  removePendingImage: (assetId) => {    set((state) => {
      const target = state.pendingImages.find((item) => item.asset.id === assetId)
      if (target) URL.revokeObjectURL(target.url)
      return { pendingImages: state.pendingImages.filter((item) => item.asset.id !== assetId) }
    })
  },

  ask: async (question) => {
    const trimmed = question.trim()
    const images = get().pendingImages
    // 纯图片提问合法（贴张板书拍照问一句）：正文与图片至少有一头
    if (!trimmed && images.length === 0) return

    const workspace = useWorkspaceStore.getState()
    const settings = useSettingsStore.getState().settings
    if (!workspace.projectId) return

    // 上一次还没回来就又问：旧请求作废，避免两段回答交叉着往同一条消息上追加
    stopStreaming()
    const controller = new AbortController()
    freeAskAbort = controller

    // 图片转存进 assets 表（发送时序与聊天一致：发出后才成为资产），模型侧吃 dataUrl。
    // 转存失败就当这张图没贴过：问句还在，不该被一张图整个挡住。
    // 待发预览使用的 objectURL 在此统一释放（无论成败预览均已退场，避免内存泄漏）。
    const savedIds: Id[] = []
    for (const pending of images) {
      try {
        await getRepositories().assets.create(pending.asset)
        savedIds.push(pending.asset.id)
      } catch {
        // 转存失败跳过该图
      }
    }
    for (const pending of images) URL.revokeObjectURL(pending.url)
    const imageDataUrls = await Promise.all(
      savedIds.map(async (id) => {
        const asset = images.find((item) => item.asset.id === id)?.asset
        return asset ? await assetToDataUrl(asset) : null
      }),
    ).then((list) => list.filter((item): item is string => item !== null))

    // 历史里的图片按「上一条用户问句带的图」补 dataUrl：模型每轮都能看到贴过的图
    const history: ContextMessage[] = get().messages.map((message) => ({
      role: message.role,
      parts: historyParts(message, get().imageUrlsByMessage),
    }))
    const asked: FreeAskMessage = {
      id: newId(),
      role: 'user',
      text: trimmed,
      createdAt: Date.now(),
      ...(savedIds.length > 0 ? { imageIds: savedIds } : {}),
    }
    set((state) => ({
      projectId: state.projectId ?? workspace.projectId,
      messages: [...state.messages, asked],
      streaming: { text: '', tools: [] },
      error: null,
      contextNote: null,
      // 问句已经进了对话，输入框与待发图片一并归零（与对话页发送后清草稿同一动作）
      draft: '',
      pendingImages: [],
      imageUrlsByMessage: {
        ...state.imageUrlsByMessage,
        ...Object.fromEntries(
          savedIds.map((id, index) => [id, imageDataUrls[index]] as const),
        ),
      },
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
      // 本轮贴的图以 dataUrl 附在提问上，与聊天同构
      imageDataUrls,
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
        text: output.clean || i18n.t('common:ask.emptyAnswer'),
        createdAt: Date.now(),
        incomplete: output.aborted ? true : undefined,
      }
      set((state) => ({
        messages: [...state.messages, answer],
        streaming: null,
        error: output.aborted ? i18n.t('common:ask.abortedError') : null,
        contextNote: i18n.t('common:ask.contextNote', {
          listed: output.listed,
          total: output.total,
          notes:
            output.notes > 0
              ? i18n.t('common:ask.contextNoteNotes', { count: output.notes })
              : '',
        }),
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
    set((state) => {
      for (const pending of state.pendingImages) URL.revokeObjectURL(pending.url)
      return { messages: [], streaming: null, error: null, contextNote: null, draft: '', pendingImages: [] }
    })
  },

  syncProject: (projectId) => {
    if (get().projectId === projectId) return
    stopStreaming()
    set((state) => {
      for (const pending of state.pendingImages) URL.revokeObjectURL(pending.url)
      return {
        projectId,
        messages: [],
        streaming: null,
        error: null,
        contextNote: null,
        draft: '',
        pendingImages: [],
        imageUrlsByMessage: {},
      }
    })
  },
}))

/** 历史消息 → 上下文 parts：文本必带，图片按资产 id 查现成的 dataUrl（没有就降级为文字占位）。 */
function historyParts(
  message: FreeAskMessage,
  urls: Record<Id, string>,
): ContextMessage['parts'] {
  const parts: ContextMessage['parts'] = [{ type: 'text', text: message.text }]
  for (const id of message.imageIds ?? []) {
    const dataUrl = urls[id]
    if (dataUrl) parts.push({ type: 'image', dataUrl })
    else parts.push({ type: 'text', text: '［图片］' })
  }
  return parts
}