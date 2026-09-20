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