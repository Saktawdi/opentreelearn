import type { GlobalSettings } from '@/domain/models'

export const DEFAULT_CONTEXT_BUDGET = 24_000
export const DEFAULT_RECENT_MESSAGES = 8

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