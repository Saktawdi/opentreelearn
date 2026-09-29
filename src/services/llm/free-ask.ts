import type { ContextMessage } from '@/domain/context/assemble'
import { assembleFreeAskContext } from '@/domain/context/free-ask'
import type { GlobalSettings, Id, Message, ModelRef, Node, Note, ProjectSettings } from '@/domain/models'
import { stripReviewRating } from '@/domain/review/protocol'
import { newId } from '@/lib/id'
import {
  streamReply,
  toModelMessages,
  type ChatUsage,
  type ToolActivity,
  type ToolOutcome,
} from './chat'
import { describeLlmError, formatErrorMessage } from './errors'
import { findProvider } from './catalog'
import { requireReviewModel } from './review'
import { clampAgentMaxSteps } from '@/domain/defaults'
import { TOOLS_SYSTEM, buildReadOnlyTools } from './tools/registry'

/**
 * 复习工作区「自由问答」的模型服务。
 *
 * 与复习练习同样保持隔离：自己的 abort controller、自己的流式状态、自己的消息落点。
 * 差别在于**它不落任何库** —— 问答是「随口问一句进度」的临时内容，既不进节点对话
 * （会污染可见路径与分支继承），也不进复习会话（那里记的是评分与草稿）。
 *
 * 失败不抛异常，返回结构化失败信息（含已生成的部分）：一次网络抖动不该让用户
 * 刚打完的问题消失。
 */

export interface FreeAskRequestInput {
  settings: GlobalSettings
  projectSettings?: ProjectSettings | null
  projectName?: string
  projectDescription?: string
  nodes: Node[]
  /** 项目里的全部标注；只有带标签的那些会进上下文（纯高亮是用户自己的书签） */
  notes?: Note[]
  /** 按节点分组的消息：工具要按对话内容检索时需要 */
  messagesByNode?: Map<Id, Message[]>
  /** 已经发生的问答，按时间顺序（不含本轮提问） */
  history: ContextMessage[]
  /** 本轮随问附上的图片（dataUrl，调用方已转存 assets 后现取现传） */
  imageDataUrls?: string[]
  /** 本轮提问 */
  text: string
  signal: AbortSignal
  onDelta?: (delta: string) => void
  /** 模型举手（工具调用开始） */
  onToolCall?: (activity: ToolActivity) => void
  /** 工具执行结束（成功或失败） */
  onToolResult?: (outcome: ToolOutcome) => void
  now?: number
}

export interface FreeAskRequestOutput {
  requestId: Id
  text: string
  /** 剥掉评分标记后的正文；可见文本一律用它 */
  clean: string
  usage?: ChatUsage
  modelRef?: ModelRef
  aborted: boolean
  /** 本次上下文实际列出的主题数 / 活跃主题总数 */
  listed: number
  total: number
  /** 本次上下文实际列出的标注条数（0 = 这个项目没有带标签的标注） */
  notes: number
}

export interface FreeAskRequestFailure {
  requestId: Id
  /** 已生成的部分正文（中断的正文是内容，用户看得见） */
  partial: string
  message: string
  hint?: string
  aborted: boolean
}

export async function runFreeAskRequest(
  input: FreeAskRequestInput,
): Promise<{ ok: true; output: FreeAskRequestOutput } | { ok: false; failure: FreeAskRequestFailure }> {
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

  const question = input.text.trim()
  const history: ContextMessage[] = [
    ...input.history,
    {
      role: 'user',
      parts: [
        { type: 'text', text: question },
        // 贴图随提问附上（与学习对话同一套 image part 通道，toModelMessages 会展开成 vision 内容）
        ...(input.imageDataUrls ?? []).map((dataUrl) => ({ type: 'image' as const, dataUrl })),
      ],
    },
  ]

  const context = assembleFreeAskContext({
    nodes: input.nodes,
    notes: input.notes,
    history,
    projectName: input.projectName,
    projectDescription: input.projectDescription,
    backgroundProfile: input.settings.backgroundProfile,
    projectBackground: input.projectSettings?.backgroundProfile,
    projectSystemPrompt: input.projectSettings?.systemPrompt,
    budgetTokens: input.settings.contextBudget,
    now: input.now,
  })

  let partial = ''

  // 只读工具：自由问答是「按需取数」最典型的一条链路 ——
  // 「我有哪些还没搞懂的」不必靠把全部标注塞进 system，让模型自己查更准也更省。
  // 开放区是当前项目、且这里只有读工具，所以不接授权闸门（approvalPolicy: 'open'）。
  const provider = findProvider(input.settings.providers, ref)
  const toolsAllowed = provider?.capabilities?.tools !== false
  const tools = toolsAllowed
    ? buildReadOnlyTools({
        nodes: input.nodes,
        messagesByNode: input.messagesByNode ?? new Map(),
        notes: input.notes ?? [],
        approvalPolicy: 'open',
        permission: input.projectSettings?.agentToolPermission ?? 'prompt',
      })
    : undefined

  try {
    const result = await streamReply({
      model,
      system: tools ? `${context.system}\n\n${TOOLS_SYSTEM}` : context.system,
      messages: toModelMessages(context.messages),
      abortSignal: input.signal,
      ...(tools ? { tools, maxSteps: clampAgentMaxSteps(input.settings.agentMaxSteps) } : {}),
      // 跟随提供商配置的推理强度；非法值/auto 由 chat 层过滤为不传
      reasoningEffort: provider?.reasoningEffort,
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
        listed: context.listed,
        total: context.total,
        notes: context.notes,
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
      },
    }
  }
}