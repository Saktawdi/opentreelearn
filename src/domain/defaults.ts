import type { BranchPromptPreference, GlobalSettings } from '@/domain/models'

export const DEFAULT_CONTEXT_BUDGET = 24_000
export const DEFAULT_RECENT_MESSAGES = 8

/**
 * 上下文预算的合法区间。配置页的输入校验与存储读回时的归一化共用同一份边界，
 * 避免两处各写一套魔数后漂移。
 */
export const MIN_CONTEXT_BUDGET = 2_000
/**
 * 上限按当前最大的模型上下文给（Gemini 1.5/2.x 的 1M）；上限的作用只是挡住
 * 明显无意义的输入（手滑多按几个 0），不是替用户判断模型能吃多少 ——
 * 预算超出模型窗口时由模型侧报错，比在这里静默截断更容易被理解。
 */
export const MAX_CONTEXT_BUDGET = 1_000_000

export function clampContextBudget(value: number): number {
  return Math.min(Math.max(value, MIN_CONTEXT_BUDGET), MAX_CONTEXT_BUDGET)
}

/**
 * Agent 工具循环的步数上限（一步 = 一次完整的模型调用，含最终作答那一步）。
 *
 * **0 = 不限制**：不设步数停止条件，模型自己决定何时收尾，用户随时可点停止。
 * 上限只是挡手滑（多按几个 0），不是替用户判断合理值 —— 与 MAX_CONTEXT_BUDGET 同哲学。
 */
export const DEFAULT_AGENT_MAX_STEPS = 50
export const MAX_AGENT_MAX_STEPS = 1_000

/**
 * 归一化步数配置。必须截断成整数：SDK 的 `stepCountIs` 是 `steps.length === n`
 * 的**严格相等**判断，小数或负数永不满足，等于静默变成不限制 —— 这不是用户要的。
 */
export function clampAgentMaxSteps(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_MAX_STEPS
  return Math.min(Math.max(Math.trunc(value), 0), MAX_AGENT_MAX_STEPS)
}

/** 「新建子节点」小窗里的快捷指令：一点即发，被框选的原文作为引用胶囊附在消息里。 */
export interface BranchQuickChoice {
  id: string
  label: string
  hint: string
  /** 点击芯片后直接作为新节点首条提问正文发送的指令全文 */
  prompt: string
}

/**
 * 快捷指令候选。prompt 全文是消息正文的唯一凭据（设置页的「记住的指令」、
 * deriveTitle 判断「模板指令不当标题」都按全文比对），改文案等于换指令，
 * 会同时改变已记住用户的直发内容 —— 谨慎。
 */
export const BRANCH_QUICK_CHOICES: BranchQuickChoice[] = [
  {
    id: 'consult',
    label: '咨询',
    hint: '就这段内容提问、答疑',
    prompt: '我想就这段内容向你咨询，请帮我解答其中的疑问。',
  },
  {
    id: 'interpret',
    label: '解读',
    hint: '逐句解释含义',
    prompt: '请逐句解读这段内容，把含义讲清楚。',
  },
  {
    id: 'extend',
    label: '扩展',
    hint: '延伸相关知识与例子',
    prompt: '请以这段内容为起点做扩展，补充相关的知识点、例子与常见误区。',
  },
  {
    id: 'quiz',
    label: '出题',
    hint: '根据这段内容练习',
    prompt: '请根据这段内容出几道练习题，并附上答案与解析。',
  },
  {
    id: 'summarize',
    label: '总结',
    hint: '提炼便于记忆的要点',
    prompt: '请把这段内容总结成便于记忆的要点。',
  },
]

/** 按指令全文找回快捷意图；找不到说明是用户自定义文本。 */
export function findBranchQuickChoice(prompt: string): BranchQuickChoice | null {
  return BRANCH_QUICK_CHOICES.find((choice) => choice.prompt === prompt) ?? null
}

export const DEFAULT_BRANCH_PROMPT: BranchPromptPreference = {
  showDialog: true,
  rememberedPrompt: null,
}

export function createDefaultSettings(): GlobalSettings {
  return {
    backgroundProfile: '',
    defaultChatModelRef: null,
    titleModelRef: null,
    summaryModelRef: null,
    contextBudget: DEFAULT_CONTEXT_BUDGET,
    agentMaxSteps: DEFAULT_AGENT_MAX_STEPS,
    branchPrompt: { ...DEFAULT_BRANCH_PROMPT },
    providers: [],
    // 0 表示「用户从未改过设置」：首次登录同步时云端版本会（正确地）覆盖它
    updatedAt: 0,
  }
}