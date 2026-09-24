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
  /**
   * 允许 Agent 改动这棵树（建节点、改标题、打标签）。
   *
   * 缺省（含老数据）= 关闭：只读工具随时可用，写工具必须由用户显式打开 ——
   * 「默认不让 AI 改我的数据」是这套设计的硬约定（见设计文档 §6.3）。
   * 打开后也只放可逆操作，破坏性的（归档、删除）不提供。
   */
  agentWriteEnabled?: boolean
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
  /**
   * **评估快照时间**（epoch ms）：之后又继续学习超过阈值就算过期（见 domain/mastery）。
   *
   * 复习评分只改 `score`，不动这个时间 —— 否则「摘要与薄弱点是哪次评估得出的」
   * 会被一次评分刷成「刚刚评估过」，等于伪造依据（见 AssessmentMeta）。
   */
  updatedAt: number
  /** 最近一次**因复习评分**改动分数的时间；从未被评分改过就没有。 */
  gradedAt?: number
}

/** 最近一次掌握状态变化来自哪里。 */
export type AssessmentSource = 'ai' | 'review' | 'historical'

/**
 * 学习评估的来源与依据。
 *
 * 掌握度可能与摘要来自不同时间、不同动作（AI 评估 vs 复习评分），只有分开记账，
 * 界面才能如实说「这个分数是复习评出来的，摘要还是上次评估的」，而不是把两者
 * 说成同一个「刚刚更新」。
 */
export interface AssessmentMeta {
  /** 最近一次 AI 学习评估（摘要 + 掌握度）的时间；历史数据没有，此时不声称任何依据 */
  assessedAt?: number
  /** 那次评估依据的学习时间（当时的 `lastStudiedAt`），用于判断「评估后有新的学习内容」 */
  basedOnStudiedAt?: number
  /**
   * 那次评估依据的对话版本指纹（可见路径的稳定摘要）。
   *
   * 只比时间无法区分「又学了新内容」与「切到了另一个历史版本」：后者学习时间没变，
   * 但评估针对的确实是另一版对话，界面要另行标注。
   */
  basedOnPath?: string
  /** 最近一次状态变化来自 AI 评估还是用户复习评分；历史数据缺省视为 historical */
  source: AssessmentSource
}

/**
 * 复习计划开关。
 *
 * 缺省（老数据、导入数据）由 `domain/review/enrollment` 兼容推导：有掌握度即视为
 * 已加入 —— 升级不该让已经在复习的主题凭空退出计划。新建节点显式写 `disabled`：
 * 用户没有明确选择过，就不该开始积累复习任务。
 */
export type ReviewEnrollment = 'enabled' | 'disabled'

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
  /** 复习计划开关；缺省时按「有掌握度即已加入」兼容（见 ReviewEnrollment） */
  reviewEnrollment?: ReviewEnrollment
  /** 学习评估的来源与依据；历史数据没有 */
  assessmentMeta?: AssessmentMeta
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
  /**
   * 一次工具调用与它的结果（Agent 的「举手记录」）。
   *
   * **内联在同一条 assistant 消息的 parts 里，不是独立消息**：厂商要求
   * `assistant(tool_call)` 后必须紧跟 `tool(tool_result)`，而全项目的版本槽、fork、
   * 删除级联、导出都以「一轮 = 一条 user + 一条 assistant」为单位 —— 保持这条不变量，
   * 代价只是 `toModelMessages` 多做一层展开（见设计文档 §7.2/§7.3）。
   *
   * `output` 缺失 = 这一轮在工具执行完之前就中断了：**落库时整条丢弃**，
   * 不能留下半截配对。工具记录不进 `messageText`，因此摘要/导出/预览天然不受影响。
   */
  | {
      type: 'tool'
      callId: string
      name: string
      input: unknown
      output?: string
      error?: string
    }

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

/**
 * 标注标签。
 *
 * 刻意用字符串而不是封闭枚举：内置一组（见 `domain/notes` 的 `NOTE_LABELS`），
 * 项目里可以继续扩展。但**新增标签必须带一句释义** —— 模型读不懂标签名就只能猜，
 * 「猜不到意思的自定义标签」正是把标注喂给 AI 时最该避免的污染。
 */
export type NoteLabel = string

/**
 * 消息正文里的「标注」：标签与可选备注锚定到同一段被框选的原文。
 *
 * 锚点存的是**字符区间**而不是 DOM 引用 —— 消息正文是 Markdown 渲染出来的，
 * 每次重渲染都会重建 DOM，只有「正文纯文本里的第 start 到 end 个字符」这种说法
 * 能在重建后重新定位。`quote` 同时用于展示与锚点自愈（渲染结果变了就按原文找回）。
 *
 * `labels` 空数组 = 纯高亮（用户自己的书签）：正文里照常画线，但**默认不进 AI 上下文**
 * —— 只有带标签的标注才外送，那是用户亲口确认过的语义（错题 / 没懂）。
 */
export interface Note {
  id: Id
  projectId: Id
  nodeId: Id
  messageId: Id
  /** 标签；空数组 = 纯高亮。旧数据的 `kind` 在读取时归一化掉（见 normalizeNote）。 */
  labels: NoteLabel[]
  quote: string
  start: number
  end: number
  /** 可选备注，退居次要：默认不进 AI 上下文，且限长（见 NOTE_BODY_MAX）。 */
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

/**
 * 探测出来的 provider 能力。
 *
 * 工具调用走各家原生 function calling，而自建中转（new-api / one-api / LM Studio /
 * Ollama）**可能直接忽略 `tools` 字段**：模型永远不举手，却一声不响 —— 用户会以为
 * 「AI 不想用工具」。所以要在连接测试时主动探测一次，把结论存在这里。
 *
 * `undefined` = 还没探过（不是「不支持」）：运行时先按支持试一次，失败再退回无工具。
 */
export interface ProviderCapabilities {
  tools?: boolean
}

/** 单个模型的自定义/覆盖能力配置（未在全局目录匹配到或想手工覆盖时使用）。 */
export interface CustomModelConfig {
  contextLimit?: number
  hasVision?: boolean
  reasoning?: boolean
  /** 用户针对该模型自定义设置的推理档位列表（例如 ['low', 'medium', 'high']） */
  reasoningLevels?: string[]
}

export interface ProviderConfig {
  id: Id
  label: string
  kind: ProviderKind
  apiKey: string
  baseURL?: string
  models: string[]
  /** 连接测试时探测出的能力；缺省 = 未探测（见 ProviderCapabilities） */
  capabilities?: ProviderCapabilities
  /**
   * 推理强度：自由文本（通常来自智能匹配候选，也可手填任意档位）。
   * `'auto'` 或缺失 = 不传参，跟随厂商默认；其余取值仅在属于 SDK 合法档位
   * （见 model-catalog 的 ALLOWED_REASONING_LEVELS）时随请求携带。
   */
  reasoningEffort?: string
  /** 针对单个模型的个性化能力配置（按模型 ID 索引）。 */
  modelConfigs?: Record<string, CustomModelConfig>
}

/**
 * 「新建子节点」快捷小窗的偏好（设置 → 偏好 收录）。
 *
 * showDialog=false 时点击「新建子节点」不再弹窗，直接以 rememberedPrompt 发送；
 * 勾选弹窗里的「记住选择，下次不再弹出窗口」会把这里写成 false。
 */
export interface BranchPromptPreference {
  /** 点击「新建子节点」时是否弹出快捷小窗 */
  showDialog: boolean
  /** 记住的指令文本（快捷意图的完整 prompt 或用户自定义文本）；null = 还没记住 */
  rememberedPrompt: string | null
}

export interface GlobalSettings {
  backgroundProfile: string
  defaultChatModelRef: ModelRef | null
  titleModelRef: ModelRef | null
  summaryModelRef: ModelRef | null
  contextBudget: number
  /** Agent 工具循环的步数上限；0 = 不限制（归一化见 defaults.clampAgentMaxSteps） */
  agentMaxSteps: number
  /** 新建子节点快捷小窗的偏好，见 BranchPromptPreference。 */
  branchPrompt: BranchPromptPreference
  providers: ProviderConfig[]
  /** 最后修改时间（epoch ms）；0 表示从未改过，同步时以云端版本为准。 */
  updatedAt: number
}