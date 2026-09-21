import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { getRepositories } from '@/data'
import { createDefaultSettings } from '@/domain/defaults'
import type { GlobalSettings, Id, ModelRef, ProviderConfig } from '@/domain/models'

export type ModelSlot = 'defaultChatModelRef' | 'titleModelRef' | 'summaryModelRef'

interface SettingsState {
  loaded: boolean
  settings: GlobalSettings
  load: () => Promise<void>
  patch: (patch: Partial<GlobalSettings>) => Promise<void>
  addProvider: (provider: ProviderConfig) => Promise<void>
  updateProvider: (id: Id, patch: Partial<ProviderConfig>) => Promise<void>
  removeProvider: (id: Id) => Promise<void>
  setModelRef: (slot: ModelSlot, ref: ModelRef | null) => Promise<void>
}

export const useSettingsStore = create<SettingsState>()(
  immer((set, get) => ({
    loaded: false,
    settings: createDefaultSettings(),

    load: async () => {
      const settings = await getRepositories().settings.load()
      set((state) => {
        state.settings = settings
        state.loaded = true
      })
    },

    patch: async (patch) => {
      // updatedAt 是跨端合并（LWW）的依据，任何一次设置改动都要盖时间戳
      const next = { ...get().settings, ...patch, updatedAt: Date.now() }
      set((state) => {
        state.settings = next
      })
      await getRepositories().settings.save(next)
    },

    addProvider: async (provider) => {
      await get().patch({ providers: [...get().settings.providers, provider] })
    },

    updateProvider: async (id, patch) => {
      const providers = get().settings.providers.map((provider) =>
        provider.id === id ? { ...provider, ...patch } : provider,
      )
      await get().patch({ providers })
    },

    removeProvider: async (id) => {
      const settings = get().settings
      const providers = settings.providers.filter((provider) => provider.id !== id)
      const clearRef = (ref: ModelRef | null): ModelRef | null =>
        ref && ref.providerId === id ? null : ref

      await get().patch({
        providers,
        defaultChatModelRef: clearRef(settings.defaultChatModelRef),
        titleModelRef: clearRef(settings.titleModelRef),
        summaryModelRef: clearRef(settings.summaryModelRef),
      })
    },

    setModelRef: async (slot, ref) => {
      await get().patch({ [slot]: ref } as Partial<GlobalSettings>)
    },
  })),
)