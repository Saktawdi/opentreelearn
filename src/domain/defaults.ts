import type { GlobalSettings } from '@/domain/models'

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

export function createDefaultSettings(): GlobalSettings {
  return {
    backgroundProfile: '',
    defaultChatModelRef: null,
    titleModelRef: null,
    summaryModelRef: null,
    contextBudget: DEFAULT_CONTEXT_BUDGET,
    providers: [],
    // 0 表示「用户从未改过设置」：首次登录同步时云端版本会（正确地）覆盖它
    updatedAt: 0,
  }
}