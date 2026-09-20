import type { GlobalSettings } from '@/domain/models'

export const DEFAULT_CONTEXT_BUDGET = 24_000
export const DEFAULT_RECENT_MESSAGES = 8

/**
 * 上下文预算的合法区间。配置页的输入校验与存储读回时的归一化共用同一份边界，
 * 避免两处各写一套魔数后漂移。
 */
export const MIN_CONTEXT_BUDGET = 2_000
export const MAX_CONTEXT_BUDGET = 200_000

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
  }
}