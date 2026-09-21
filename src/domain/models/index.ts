export type Id = string

export interface ModelRef {
  providerId: Id
  modelId: string
}

export interface Project {
  id: Id
  name: string
  description?: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface ProjectSettings {
  projectId: Id
  backgroundProfile?: string
  systemPrompt?: string
  chatModelRef?: ModelRef
  titleModelRef?: ModelRef
  summaryModelRef?: ModelRef
}

export interface ForkRef {
  nodeId: Id
  messageId: Id
}

export type NodeStatus = 'active' | 'archived'

export interface Node {
  id: Id
  projectId: Id
  parentId: Id | null
  forkFrom: ForkRef | null
  title: string
  summary?: string
  contextSeed?: string[]
  position: { x: number; y: number } | null
  status: NodeStatus
  createdAt: number
  updatedAt: number
}

export type Role = 'system' | 'user' | 'assistant'

export type MessagePart =
  | { type: 'text'; text: string }
  // 从消息里框选后「引用到对话框」的原文片段；与用户自己的话分开存，
  // 以便气泡里渲染成引用块，而不是混进正文。
  | { type: 'quote'; text: string }
  | { type: 'image'; assetId: Id }

export interface MessageMeta {
  providerId?: Id
  modelId?: string
  usage?: { inputTokens?: number; outputTokens?: number }
  error?: string
  errorHint?: string
  incomplete?: boolean
}

export interface Message {
  id: Id
  nodeId: Id
  projectId: Id
  role: Role
  parts: MessagePart[]
  createdAt: number
  meta?: MessageMeta
}

export type NoteKind = 'highlight' | 'annotation'

/**
 * 消息正文里的「笔记」：高亮标记与批注锚定到同一段被框选的原文。
 *
 * 锚点存的是**字符区间**而不是 DOM 引用 —— 消息正文是 Markdown 渲染出来的，
 * 每次重渲染都会重建 DOM，只有「正文纯文本里的第 start 到 end 个字符」这种说法
 * 能在重建后重新定位。`quote` 同时用于展示与锚点自愈（渲染结果变了就按原文找回）。
 */
export interface Note {
  id: Id
  projectId: Id
  nodeId: Id
  messageId: Id
  kind: NoteKind
  quote: string
  start: number
  end: number
  /** 批注内容；纯高亮可以留空，留空时正文里只留一条划线。 */
  body?: string
  createdAt: number
  updatedAt: number
}

export interface Asset {
  id: Id
  projectId: Id
  kind: 'image'
  mime: string
  name?: string
  width?: number
  height?: number
  createdAt: number
  blob: Blob
}

export type ProviderKind = 'openai' | 'anthropic' | 'google' | 'openai-compatible'

export interface ProviderConfig {
  id: Id
  label: string
  kind: ProviderKind
  apiKey: string
  baseURL?: string
  models: string[]
}

export interface GlobalSettings {
  backgroundProfile: string
  defaultChatModelRef: ModelRef | null
  titleModelRef: ModelRef | null
  summaryModelRef: ModelRef | null
  contextBudget: number
  providers: ProviderConfig[]
}