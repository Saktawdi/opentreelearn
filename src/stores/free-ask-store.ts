import { create } from 'zustand'
import i18n from '@/i18n'
import { currentDatabaseName, getRepositories } from '@/data'
import type { Repositories } from '@/data/repository'
import type { ContextMessage } from '@/domain/context/assemble'
import type { Asset, Id } from '@/domain/models'
import type { FreeAskConversation, FreeAskMessage } from '@/domain/review/free-ask'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { createImageAsset, assetToDataUrl, loadAssetUrls } from '@/services/images'
import { runFreeAskRequest } from '@/services/llm/free-ask'
import { useSettingsStore } from './settings-store'
import { useWorkspaceStore, type StreamingToolActivity } from './workspace-store'

export type { FreeAskMessage } from '@/domain/review/free-ask'
export interface FreeAskPendingImage { asset: Asset; url: string }

interface FreeAskState {
  projectId: Id | null
  conversationId: Id | null
  conversations: FreeAskConversation[]
  messages: FreeAskMessage[]
  loading: boolean
  streaming: { text: string; tools: StreamingToolActivity[] } | null
  error: string | null
  contextNote: string | null
  imageUrlsByMessage: Record<Id, string>
  draft: string
  pendingImages: FreeAskPendingImage[]
  setDraft: (value: string) => void
  attachImages: (files: File[]) => Promise<void>
  removePendingImage: (assetId: Id) => void
  ask: (question: string) => Promise<void>
  cancel: () => Promise<void>
  /** Reset memory on account changes, preserving saved history. */
  reset: () => void
  syncProject: (projectId: Id | null) => Promise<void>
  reload: () => Promise<void>
  newConversation: () => Promise<void>
  selectConversation: (id: Id) => Promise<void>
}

let epoch = 0
let boundDatabase: string | null = null
let loadingTask: Promise<void> | null = null
let draftQueue: Promise<void> = Promise.resolve()

interface ActiveRequest {
  controller: AbortController
  repositories: Repositories
  answer: FreeAskMessage
  text: string
  writes: Promise<void>
  timer?: ReturnType<typeof setTimeout>
}
let activeRequest: ActiveRequest | null = null
const projectLocalId = (id: Id) => 'project:' + id

function releaseImages(images: FreeAskPendingImage[]) {
  for (const image of images) URL.revokeObjectURL(image.url)
}

function persistDraft() {
  const state = useFreeAskStore.getState()
  if (!state.projectId || state.loading) return draftQueue
  const repositories = getRepositories()
  const id = state.conversationId ?? projectLocalId(state.projectId)
  const snapshot = { id, projectId: state.projectId, draft: state.draft, pendingImages: state.pendingImages.map((image) => image.asset) }
  const owner = epoch
  draftQueue = draftQueue.then(async () => {
    const previous = await repositories.freeAsk.getLocal(id)
    await repositories.freeAsk.saveLocal({ ...previous, ...snapshot })
  }).catch(() => {
    if (epoch === owner) useFreeAskStore.setState({ error: i18n.t('review:freeAsk.saveFailed') })
  })
  return draftQueue
}

/** Serialize partial and final replies so an older chunk cannot replace a completed answer. */
function persistAnswer(request: ActiveRequest, final = false) {
  if (request.timer) clearTimeout(request.timer)
  request.timer = undefined
  const snapshot = { ...request.answer, text: stripReviewRating(request.text), incomplete: !final }
  request.writes = request.writes.catch(() => undefined).then(() => request.repositories.freeAsk.saveMessage(snapshot))
  return request.writes
}

function initialView() {
  return { conversationId: null, conversations: [], messages: [], loading: false, streaming: null, error: null, contextNote: null, imageUrlsByMessage: {}, draft: '', pendingImages: [] }
}

async function loadConversation(id: Id | null, projectId: Id, repositories: Repositories, owner: number) {
  const [messages, local] = await Promise.all([
    id ? repositories.freeAsk.listMessages(id) : Promise.resolve([]),
    repositories.freeAsk.getLocal(id ?? projectLocalId(projectId)),
  ])
  const urls = await loadAssetUrls(repositories.assets, messages.flatMap((message) => message.imageIds ?? []))
  if (epoch !== owner) return
  releaseImages(useFreeAskStore.getState().pendingImages)
  useFreeAskStore.setState({
    conversationId: id, messages: messages.filter((message) => message.text.trim() || message.imageIds?.length),
    draft: local?.draft ?? '', pendingImages: (local?.pendingImages ?? []).map((asset) => ({ asset, url: URL.createObjectURL(asset.blob) })),
    imageUrlsByMessage: Object.fromEntries(urls), loading: false, error: null, contextNote: null,
  })
}

async function loadProject(projectId: Id, force = false) {
  const state = useFreeAskStore.getState()
  if (!force && state.projectId === projectId && boundDatabase === currentDatabaseName()) {
    await loadingTask
    return
  }
  const owner = ++epoch
  const repositories = getRepositories()
  const cancellation = useFreeAskStore.getState().cancel()
  const draft = persistDraft()
  boundDatabase = currentDatabaseName()
  useFreeAskStore.setState({ loading: true })
  const task = (async () => {
    await Promise.all([cancellation, draft])
    if (epoch !== owner) return
    releaseImages(state.pendingImages)
    useFreeAskStore.setState({ ...initialView(), projectId, loading: true })
    const [conversations, local] = await Promise.all([
      repositories.freeAsk.listByProject(projectId), repositories.freeAsk.getLocal(projectLocalId(projectId)),
    ])
    if (epoch !== owner) return
    const selected = conversations.find((entry) => entry.id === local?.activeConversationId) ?? conversations[0]
    useFreeAskStore.setState({ conversations })
    await loadConversation(selected?.id ?? null, projectId, repositories, owner)
  })().catch(() => {
    if (epoch === owner) {
      boundDatabase = null
      useFreeAskStore.setState({ loading: false, error: i18n.t('review:freeAsk.loadFailed') })
    }
  })
  loadingTask = task
  await task
  if (loadingTask === task) loadingTask = null
}

async function refreshHistory(repositories: Repositories, owner: number) {
  const projectId = useFreeAskStore.getState().projectId
  if (!projectId) return
  const conversations = await repositories.freeAsk.listByProject(projectId)
  if (epoch === owner) useFreeAskStore.setState({ conversations })
}

export const useFreeAskStore = create<FreeAskState>()((set, get) => ({
  projectId: null, ...initialView(),
  setDraft: (draft) => { set({ draft }); void persistDraft() },
  attachImages: async (files) => {
    const projectId = get().projectId
    if (!projectId || files.length === 0 || get().loading) return
    const owner = epoch
    try {
      const assets = await Promise.all(files.map((file) => createImageAsset(file, projectId)))
      if (owner !== epoch) return
      set((state) => ({ pendingImages: [...state.pendingImages, ...assets.map((asset) => ({ asset, url: URL.createObjectURL(asset.blob) }))] }))
      await persistDraft()
    } catch { if (owner === epoch) set({ error: i18n.t('review:freeAsk.imageReadFailed') }) }
  },
  removePendingImage: (assetId) => {
    releaseImages(get().pendingImages.filter((image) => image.asset.id === assetId))
    set((state) => ({ pendingImages: state.pendingImages.filter((image) => image.asset.id !== assetId) }))
    void persistDraft()
  },
  syncProject: async (projectId) => {
    if (projectId) await loadProject(projectId)
    else {
      const owner = ++epoch
      const cancellation = get().cancel()
      const draft = persistDraft()
      set({ loading: true })
      await Promise.all([cancellation, draft])
      if (epoch === owner) get().reset()
    }
  },
  reload: async () => {
    if (!get().projectId) return
    if (activeRequest || get().loading) {
      await refreshHistory(getRepositories(), epoch)
      return
    }
    await loadProject(get().projectId!, true)
  },
  newConversation: async () => {
    const projectId = get().projectId
    if (!projectId || get().loading) return
    const started = epoch
    await get().cancel()
    await persistDraft()
    if (epoch !== started) return
    const owner = ++epoch
    const repositories = getRepositories()
    set({ loading: true })
    try {
      const now = Date.now()
      const conversation: FreeAskConversation = { id: newId(), projectId, title: '', createdAt: now, updatedAt: now }
      await repositories.freeAsk.create(conversation)
      const local = await repositories.freeAsk.getLocal(projectLocalId(projectId))
      await repositories.freeAsk.saveLocal({ ...local, id: projectLocalId(projectId), projectId, activeConversationId: conversation.id })
      if (epoch !== owner) return
      await refreshHistory(repositories, owner)
      await loadConversation(conversation.id, projectId, repositories, owner)
    } catch { if (epoch === owner) set({ loading: false, error: i18n.t('review:freeAsk.saveFailed') }) }
  },
  selectConversation: async (id) => {
    const projectId = get().projectId
    if (!projectId || get().loading || id === get().conversationId) return
    const started = epoch
    await get().cancel()
    await persistDraft()
    if (epoch !== started) return
    const owner = ++epoch
    const repositories = getRepositories()
    set({ loading: true })
    try {
      const conversation = await repositories.freeAsk.get(id)
      if (epoch !== owner) return
      if (!conversation || conversation.projectId !== projectId) { set({ loading: false }); return }
      const local = await repositories.freeAsk.getLocal(projectLocalId(projectId))
      await repositories.freeAsk.saveLocal({ ...local, id: projectLocalId(projectId), projectId, activeConversationId: id })
      await loadConversation(id, projectId, repositories, owner)
    } catch { if (epoch === owner) set({ loading: false, error: i18n.t('review:freeAsk.loadFailed') }) }
  },
  cancel: async () => {
    const request = activeRequest
    if (!request) return
    const owner = epoch
    activeRequest = null
    request.controller.abort()
    const partial = stripReviewRating(request.text)
    set((state) => ({
      messages: partial.trim() ? [...state.messages, { ...request.answer, text: partial, incomplete: true }] : state.messages,
      streaming: null,
    }))
    try { await persistAnswer(request) }
    catch { if (epoch === owner) set({ error: i18n.t('review:freeAsk.saveFailed') }) }
  },
  reset: () => {
    const request = activeRequest
    activeRequest = null
    request?.controller.abort()
    if (request?.timer) clearTimeout(request.timer)
    ++epoch
    boundDatabase = null
    loadingTask = null
    releaseImages(get().pendingImages)
    set({ ...initialView(), projectId: null })
  },
  ask: async (question) => {
    const trimmed = question.trim()
    if (!trimmed && get().pendingImages.length === 0) return
    const workspace = useWorkspaceStore.getState()
    const projectId = workspace.projectId
    if (!projectId) return
    if (get().projectId !== projectId || boundDatabase !== currentDatabaseName()) await get().syncProject(projectId)
    await loadingTask
    if (get().loading || get().projectId !== projectId) return
    const started = epoch
    const images = [...get().pendingImages]
    if (!get().conversationId) {
      await get().newConversation()
      if (epoch !== started + 1 || get().projectId !== projectId) return
      // First-send creation keeps the captured attachments; their preview URLs were released.
      set({ pendingImages: images.map((image) => ({ ...image, url: URL.createObjectURL(image.asset.blob) })) })
    }
    const conversationId = get().conversationId
    if (!conversationId) return
    await get().cancel()
    if (get().conversationId !== conversationId || get().projectId !== projectId || boundDatabase !== currentDatabaseName()) return
    const owner = epoch
    const repositories = getRepositories()
    const request: ActiveRequest = {
      controller: new AbortController(), repositories, text: '', writes: Promise.resolve(),
      answer: { id: newId(), projectId, conversationId, role: 'assistant', text: '', createdAt: Date.now(), updatedAt: Date.now(), incomplete: true },
    }
    activeRequest = request
    set({ streaming: { text: '', tools: [] }, error: null, contextNote: null })
    const current = () => activeRequest === request && epoch === owner
    try {
      const urls: Record<Id, string> = {}
      for (const image of images) {
        await repositories.assets.create(image.asset)
        urls[image.asset.id] = await assetToDataUrl(image.asset)
        if (!current()) return
      }
      const history: ContextMessage[] = get().messages.map((message) => ({ role: message.role, parts: historyParts(message, get().imageUrlsByMessage) }))
      const now = Math.max(Date.now(), (get().messages.at(-1)?.createdAt ?? 0) + 1)
      const asked: FreeAskMessage = { id: newId(), projectId, conversationId, role: 'user', text: trimmed, createdAt: now, updatedAt: now, ...(images.length ? { imageIds: images.map((image) => image.asset.id) } : {}) }
      request.answer.createdAt = now + 1
      await repositories.freeAsk.saveMessage(asked)
      if (!current()) return
      releaseImages(get().pendingImages)
      set((state) => ({ messages: [...state.messages, asked], draft: '', pendingImages: [], imageUrlsByMessage: { ...state.imageUrlsByMessage, ...urls } }))
      await persistDraft()
      await refreshHistory(repositories, owner)
      if (!current()) return
      const result = await runFreeAskRequest({
        settings: useSettingsStore.getState().settings, projectSettings: workspace.projectSettings,
        projectName: workspace.project?.name, projectDescription: workspace.project?.description,
        nodes: workspace.nodes, messagesByNode: new Map(Object.entries(workspace.messagesByNode)),
        notes: Object.values(workspace.notesByMessage).flat(), history, imageDataUrls: Object.values(urls), text: trimmed, signal: request.controller.signal,
        onDelta: (delta) => {
          if (!current()) return
          request.text += delta
          const streaming = get().streaming
          if (streaming) set({ streaming: { ...streaming, text: request.text } })
          if (!request.timer) request.timer = setTimeout(() => {
            void persistAnswer(request).catch(() => { if (current()) set({ error: i18n.t('review:freeAsk.saveFailed') }) })
          }, 400)
        },
        onToolCall: (activity) => {
          if (!current() || !get().streaming) return
          const streaming = get().streaming!
          set({ streaming: { ...streaming, tools: [...streaming.tools, { ...activity, status: 'running' }] } })
        },
        onToolResult: (outcome) => {
          if (!current() || !get().streaming) return
          const streaming = get().streaming!
          set({ streaming: { ...streaming, tools: streaming.tools.map((tool) => tool.callId !== outcome.callId ? tool : outcome.error !== undefined ? { ...tool, status: 'error', error: outcome.error } : { ...tool, status: 'done', output: outcome.output }) } })
        },
      })
      if (!current()) return
      request.text = result.ok ? result.output.clean || i18n.t('common:ask.emptyAnswer') : stripReviewRating(result.failure.partial)
      const complete = result.ok && !result.output.aborted
      await persistAnswer(request, complete)
      if (!current()) return
      activeRequest = null
      set((state) => ({
        messages: request.text.trim() ? [...state.messages, { ...request.answer, text: request.text, incomplete: !complete }] : state.messages,
        streaming: null,
        error: result.ok ? result.output.aborted ? i18n.t('common:ask.abortedError') : null : result.failure.message,
        contextNote: result.ok ? i18n.t('common:ask.contextNote', { listed: result.output.listed, total: result.output.total, notes: result.output.notes > 0 ? i18n.t('common:ask.contextNoteNotes', { count: result.output.notes }) : '' }) : null,
      }))
      await refreshHistory(repositories, owner)
      const messages = await repositories.freeAsk.listMessages(conversationId)
      if (epoch === owner) set({ messages: messages.filter((message) => message.text.trim() || message.imageIds?.length) })
    } catch {
      if (!current()) return
      await get().cancel()
      if (epoch === owner) set({ error: i18n.t('review:freeAsk.saveFailed') })
    }
  },
}))

function historyParts(message: FreeAskMessage, urls: Record<Id, string>): ContextMessage['parts'] {
  const parts: ContextMessage['parts'] = [{ type: 'text', text: message.text }]
  for (const id of message.imageIds ?? []) {
    if (urls[id]) parts.push({ type: 'image', dataUrl: urls[id] })
    else parts.push({ type: 'text', text: i18n.t('review:freeAsk.missingImage') })
  }
  return parts
}
