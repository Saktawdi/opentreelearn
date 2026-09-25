import type { Id, Message, ModelRef, Node, Note, ProjectSettings } from '@/domain/models'
import { messageText } from '@/domain/messages'
import {
  assembleReviewContext,
  buildReviewMaterial,
  type ReviewContextMessage,
  type ReviewContextPart,
} from '@/domain/context/review'
import { currentOpenQuestion } from '@/domain/review/delivery'
import type { ReviewItemPhase, ReviewRequestPurpose, ReviewSessionItem } from '@/domain/review/session'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import { describeLlmError, formatErrorMessage } from './errors'
import { findProvider } from './catalog'
import { requireModel } from './providers'
import { streamReply, toModelMessages, type ChatUsage, type ToolActivity, type ToolOutcome } from './chat'
import type { ToolSet } from 'ai'
import {
  buildReviewDeliveryTools,
  type ReviewDeliveryHandlers,
  type ReviewDeliveryKind,
} from './tools/review-delivery'
import type { GlobalSettings } from '@/domain/models'

/**
 * 复习专用模型服务。
 *
 * 与学习聊天**完全隔离**：各自的 abort controller、各自的流式状态、各自的消息落点。
 * 复习消息写进会话文档，不写进节点的普通 `messages` 流 —— 否则会污染原节点的可见路径、
 * 分支继承与 T-187 版本结构，复习完再打开节点会看到一堆「出题」「点评」。
 *
 * 一次请求的产物固定包含：请求 id（迟到回调靠它被丢弃）、用途、材料版本与
 * **实际使用的材料文本**（原版本被淘汰后仍要能看当初依据的是什么）。
 */

export interface ReviewRequestInput {
  settings: GlobalSettings
  projectSettings?: ProjectSettings | null
  projectName?: string
  projectDescription?: string
  node: Node
  nodes: Node[]
  messagesByNode: Map<Id, Message[]>
  notesByMessage?: Map<Id, Note[]>
  /** 本节点在复习会话里产生的标注（历次累计）；投喂口径见 buildReviewMaterial */
  reviewNotes?: Note[]
  /** 会话消息里作答图片的数据 URL（assetId → dataUrl，调用方现取现传） */
  imageUrls?: Map<Id, string>
  item: ReviewSessionItem
  purpose: ReviewRequestPurpose
  /** 本轮要发给模型的新内容（学习者回答 / 追问 / 空的触发语） */
  text: string
  signal: AbortSignal
  onDelta?: (delta: string) => void
  /**
   * Agent 主路径的交付 handler。给出且供应商支持工具时，本轮产物通过交付工具
   * 落库（消息 + 阶段由 handler 原子写入）；缺省或能力为 false 时走回退散文路径。
   */
  handlers?: ReviewDeliveryHandlers
  /** 只读检索工具（复习运行时绑定作用域后由 buildReadOnlyTools 构建） */
  readOnlyTools?: ToolSet
  /** 工具活动回调（检索活动行；交付工具由卡片本身展示，不进活动行） */
  onToolCall?: (activity: ToolActivity) => void
  onToolResult?: (outcome: ToolOutcome) => void
  /** 本次是第几个主题 / 共几个，写进上下文帮模型掌握节奏 */
  progressNote?: string
  now?: number
}

export interface ReviewRequestOutput {
  requestId: Id
  text: string
  /** 剥掉判定标记后的正文（会话消息里存这个；agent 路径它是旁白，不落库） */
  clean: string
  usage?: ChatUsage
  modelRef?: ModelRef
  aborted: boolean
  /** 本次实际使用的资料文本与版本，供会话快照保存 */
  materialText: string
  materialVersion: string
  materialTruncated: boolean
  /** 本轮是否走了交付工具路径（true 时消息与阶段由 handler 落库，正文是旁白） */
  usedDelivery: boolean
}

export interface ReviewRequestFailure {
  requestId: Id
  /** 已生成的（不完整）正文；**不采纳其中的评分标记** */
  partial: string
  message: string
  hint?: string
  aborted: boolean
  /**
   * 供应商能力未探测（capabilities.tools === undefined）时发起的工具请求失败。
   * 调用方据此决定降级重试一次散文路径 —— 与学习对话的探测-回退模式一致。
   */
  capabilityUnknown?: boolean
}

/** 把会话项里已有的消息转成模型能读的对话（判定标记剥掉；作答图片按现成的 dataUrl 附上）。 */
function itemHistory(item: ReviewSessionItem, imageUrls?: Map<Id, string>): ReviewContextMessage[] {
  return item.messages.map((message) => {
    const parts: ReviewContextPart[] = [{ type: 'text', text: stripReviewRating(message.text) }]
    if (message.role === 'user') {
      for (const id of message.imageIds ?? []) {
        const dataUrl = imageUrls?.get(id)
        // 资产已被清理（删库、同步裁剪）时跳过：正文还在，图片缺席优于整轮失败
        if (dataUrl) parts.push({ type: 'image', dataUrl })
      }
    }
    return { role: message.role, parts }
  })
}

/** 本轮触发语：把「用户做了什么」写成一句明确的指令，避免模型把空消息当成误发。 */
function triggerText(purpose: ReviewRequestPurpose, text: string): string {
  const trimmed = text.trim()
  if (trimmed) return trimmed
  switch (purpose) {
    case 'question':
      return '请出题。'
    case 'relearn':
      return '我还没掌握，先给我讲关键点。'
    case 'hint':
      return '给一点提示。'
    case 'rephrase':
      return '换个问法。'
    case 'answer':
      return '（学习者直接提交了完整回答，见上一条）'
    default:
      return '继续。'
  }
}

export async function requireReviewModel(
  settings: GlobalSettings,
  projectSettings?: ProjectSettings | null,
): Promise<{ model: Awaited<ReturnType<typeof requireModel>>; ref?: ModelRef }> {
  const ref = projectSettings?.chatModelRef ?? settings.defaultChatModelRef ?? undefined
  const model = await requireModel(settings, ref ?? null, '对话模型')
  return { model, ref }
}

/** 交付阶段的步数上限：检索 1~2 步 + 交付 1 步；合并轮次在阶段 3 再评估。 */
const REVIEW_DELIVERY_MAX_STEPS = 4

/**
 * 用途 → 本轮允许的交付工具。反馈轮（answer / followup）给全集：
 * 点评 → 补讲 → 再问 的合并链路（阶段 3），其余轮次单工具绑定。
 */
const DELIVERY_KINDS_BY_PURPOSE: Record<ReviewRequestPurpose, ReviewDeliveryKind[]> = {
  question: ['pose_question'],
  rephrase: ['pose_question'],
  relearn: ['teach_key_points'],
  hint: ['give_hint'],
  answer: ['submit_feedback', 'teach_key_points', 'pose_question'],
  followup: ['submit_feedback', 'teach_key_points', 'pose_question'],
}

/**
 * 跑一次复习请求。
 *
 * 失败时**不抛异常**：返回结构化的失败信息（含已生成的正文与错误提示），
 * 由调用方决定停在哪个阶段、要不要重试。复习的失败必须是可恢复的 ——
 * 一次网络抖动不该把用户刚写的回答弄丢。
 */
export async function runReviewRequest(
  input: ReviewRequestInput,
): Promise<{ ok: true; output: ReviewRequestOutput } | { ok: false; failure: ReviewRequestFailure }> {
  const requestId = newId()

  let model
  let ref: ModelRef | undefined
  try {
    const resolved = await requireReviewModel(input.settings, input.projectSettings)
    model = resolved.model
    ref = resolved.ref
  } catch (error) {
    const info = describeLlmError(error)
    return {
      ok: false,
      failure: { requestId, partial: '', message: info.message, hint: info.hint, aborted: false },
    }
  }

  // 能力门控：明确不支持工具的供应商直接走回退散文路径；未探测过的先试工具，
  // 失败时 failure.capabilityUnknown 让调用方降级重试（与学习对话同一模式）。
  const provider = findProvider(input.settings.providers, ref)
  const toolsCapability = provider?.capabilities?.tools
  const useDelivery = input.handlers !== undefined && toolsCapability !== false

  let toolSet: ToolSet | undefined
  if (useDelivery && input.handlers) {
    // 换问法轮由服务层预绑当前开放题：消息 id 不进模型上下文，模型无从填写
    const rephraseOf = input.purpose === 'rephrase' ? currentOpenQuestion(input.item)?.id : undefined
    const deliveryTools = buildReviewDeliveryTools(
      DELIVERY_KINDS_BY_PURPOSE[input.purpose],
      input.handlers,
      { rephraseOf },
    )
    // 只读检索工具与交付工具并存：模型可以先查（作用域内）再交付；
    // 交付每轮限一次由 handler 守卫，检索不落库、无此限制
    toolSet = input.readOnlyTools ? { ...input.readOnlyTools, ...deliveryTools } : deliveryTools
  }

  const material = buildReviewMaterial({
    node: input.node,
    nodes: input.nodes,
    messagesByNode: input.messagesByNode,
    notesByMessage: input.notesByMessage,
    reviewNotes: input.reviewNotes,
    budgetTokens: input.settings.contextBudget,
  })

  const history = itemHistory(input.item, input.imageUrls)
  history.push({ role: 'user', parts: [{ type: 'text', text: triggerText(input.purpose, input.text) }] })

  const context = assembleReviewContext({
    node: input.node,
    purpose: input.purpose,
    material,
    history,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    backgroundProfile: input.settings.backgroundProfile,
    projectBackground: input.projectSettings?.backgroundProfile,
    projectSystemPrompt: input.projectSettings?.systemPrompt,
    usedHint: input.item.usedHint,
    usedSource: input.item.usedSource,
    progressNote: input.progressNote,
    deliveryToolName: toolSet ? DELIVERY_KINDS_BY_PURPOSE[input.purpose][0] : undefined,
  })

  // 已生成的部分要留着：中断的正文是内容（用户看得见），只是**不采纳其中的评分标记**
  let partial = ''

  try {
    const result = await streamReply({
      model,
      system: context.system,
      messages: toModelMessages(context.messages),
      abortSignal: input.signal,
      ...(toolSet ? { tools: toolSet, maxSteps: REVIEW_DELIVERY_MAX_STEPS } : {}),
      // 跟随提供商配置的推理强度；非法值/auto 由 chat 层过滤为不传
      reasoningEffort: findProvider(input.settings.providers, ref)?.reasoningEffort,
      onDelta: (delta) => {
        partial += delta
        input.onDelta?.(delta)
      },
      onToolCall: input.onToolCall,
      onToolResult: input.onToolResult,
    })

    return {
      ok: true,
      output: {
        requestId,
        text: result.text,
        clean: stripReviewRating(result.text),
        usage: result.usage,
        modelRef: ref,
        aborted: result.aborted,
        materialText: material.text,
        materialVersion: material.versionId,
        materialTruncated: material.truncated,
        usedDelivery: toolSet !== undefined,
      },
    }
  } catch (error) {
    const info = describeLlmError(error)
    return {
      ok: false,
      failure: {
        requestId,
        partial,
        message: formatErrorMessage(info),
        hint: info.hint,
        aborted: false,
        ...(toolsCapability === undefined ? { capabilityUnknown: true } : {}),
      },
    }
  }
}

/** 复习阶段 → 是否需要请求模型（界面据此决定按钮与骨架屏）。 */
export function phaseNeedsModel(phase: ReviewItemPhase): boolean {
  return phase === 'preparing' || phase === 'evaluating'
}

/** 会话消息的展示文本（历史记录、资料面板都用它）。 */
export function reviewMessageText(message: { text: string }): string {
  return stripReviewRating(message.text)
}

/** 把节点可见对话渲染成纯文本（资料面板与材料快照共用一处口径）。 */
export function visibleThreadText(_node: Node, messages: Message[], limit = 40): string {
  return messages
    .slice(-limit)
    .map((message) => {
      const speaker = message.role === 'assistant' ? '导师' : '学习者'
      return `${speaker}：${messageText(message)}`
    })
    .join('\n\n')
}