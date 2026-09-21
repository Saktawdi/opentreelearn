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
  /** 最后修改时间；历史数据可能没有，同步时以 outbox 的变更时间为准。 */
  updatedAt?: number
}

export interface ForkRef {
  nodeId: Id
  messageId: Id
  /**
   * fork 那一刻源节点 thread 的版本选择快照。
   *
   * 冻结下来，源节点之后切版本才不会悄悄改写已有子节点的上下文；
   * 快照里的版号若已被 3 版上限淘汰，解析时回退到该槽最新版。
   */
  selection?: Record<Id, number>
}

/**
 * 节点内对话版本结构。**全部挂在 Node 上，消息表一个字段都不加**：
 * 老数据与导入的 .tree 没有 `thread`，按 createdAt 线性解析，行为不变。
 *
 * - `entries`：顶层顺序，消息 id 与版本槽标记混排
 * - `slots[slotId]`：一个版本槽，`slotId = 该槽锚点消息 id`（同一槽的历次版本共享提问/前缀）
 * - `selection[slotId]`：选中版号；缺省 = 最新版
 */
export type ThreadEntry = Id | { slot: Id }

export interface ThreadVersion {
  /** 单调递增、不压缩：淘汰旧版后编号保持原值，冻结的选择才不会指向别的版本 */
  version: number
  entries: ThreadEntry[]
}

export interface ThreadSlot {
  /** 按创建顺序，最多 3 版 */
  versions: ThreadVersion[]
}

export interface NodeThread {
  entries: ThreadEntry[]
  slots: Record<Id, ThreadSlot>
  selection?: Record<Id, number>
}

export type NodeStatus = 'active' | 'archived'

/**
 * 节点类型。缺省（含老数据与导入的 `.tree`）= 普通学习节点。
 *
 * - `review`：复习中心。每个项目至多一个，自成一棵根树，**不参与掌握度聚合**，
 *   它的对话上下文走 `domain/review/digest` 的学习快照而不是普通前置脉络。
 */
export type NodeKind = 'topic' | 'review'

/**
 * 掌握度快照：AI 评估（生成学习摘要）或复习评分写下的一个时间点切片。
 *
 * `score` 只用于展示与排序 —— 一切决策（排期、分流）都走档位，因为不同模型
 * 给分分布不可比，把原始分数当阈值判据是假精度。
 */
export interface MasterySnapshot {
  /** 0-100（超出范围由 normalize 夹紧） */
  score: number
  /**
   * AI 给出的薄弱点（至多 3 条）。**只做出题材料，绝不作为调度键** ——
   * 每次生成文本都会漂移，无法稳定标识一个记忆。
   */
  weakPoints?: string[]
  /** 快照时间（epoch ms）：之后又继续学习超过阈值就算过期（见 domain/mastery） */
  updatedAt: number
}

/** FSRS 卡片状态；与 ts-fsrs 的 State 枚举一一对应，存成字符串免得版本换了数字含义 */
export type ReviewCardState = 'new' | 'learning' | 'review' | 'relearning'

/**
 * 一张 FSRS 卡片的**序列化形状**：全部是普通 number（时间戳用 epoch ms）。
 *
 * Date 与 `elapsed_days` 这类会随 ts-fsrs 6.0 消失的 API 一律不进来 ——
 * 适配层（domain/review/fsrs.ts）负责在我们的形状和 ts-fsrs 的 `Card` 之间往返。
 */
export interface ReviewCard {
  /** 下次到期时间（epoch ms） */
  due: number
  stability: number
  difficulty: number
  scheduledDays: number
  /** 当前处在第几个（重）学习步；与 ts-fsrs 的 learning_steps 对齐 */
  learningSteps: number
  reps: number
  lapses: number
  state: ReviewCardState
  /** 上次复习时间（epoch ms）；新卡没有 */
  lastReview?: number
}

export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'

export const REVIEW_GRADES: readonly ReviewGrade[] = ['again', 'hard', 'good', 'easy']

export function isReviewGrade(value: unknown): value is ReviewGrade {
  return typeof value === 'string' && (REVIEW_GRADES as readonly string[]).includes(value)
}

/** 挂在节点上的复习状态：一张卡片 + 最近一次评分档位。 */
export interface NodeReview {
  card: ReviewCard
  lastGrade?: ReviewGrade
}

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
  /** 节点内「编辑重发 + 重新生成」的历史版本；缺省 = 线性对话 */
  thread?: NodeThread
  /** 缺省 = 普通学习节点；`review` = 复习中心 */
  kind?: NodeKind
  /** 掌握度快照；没生成过就没有（不等于 0 分） */
  mastery?: MasterySnapshot
  /** 复习调度状态；有 mastery 的节点在第一次复习后才有 */
  review?: NodeReview
  /**
   * 最后学习时间（epoch ms）= 显示路径末条消息的 createdAt。
   *
   * 刻意不是 `updatedAt`：重命名、拖拽、生成摘要、切版本都会改 updatedAt，
   * 用它当「学过没有」会把整理动作误读成学习。单一写入口在消息落库处。
   */
  lastStudiedAt?: number
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
  /**
   * 最后修改时间。历史数据可能没有这个字段（消息一直是写完即定稿），
   * 同步以 outbox 里的变更时间为准，这里只用于跨端合并时的比较。
   */
  updatedAt?: number
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
  /** 最后修改时间（epoch ms）；0 表示从未改过，同步时以云端版本为准。 */
  updatedAt: number
}