import { create } from 'zustand'
import { immer } from 'zustand/middleware/immer'
import { errorMessage } from '@/lib/utils'
import {
  AccountApiError,
  clearAccountToken,
  fetchAccountUser,
  login as requestLogin,
  logout as requestLogout,
  readAccountToken,
  refreshAccountToken,
  register as requestRegister,
  saveAccountToken,
  type AccountUser,
  type LoginInput,
  type RegisterInput,
} from '@/services/account/client'

export type AccountStatus = 'uninitialized' | 'restoring' | 'anonymous' | 'authenticated'

interface AccountState {
  status: AccountStatus
  token: string | null
  user: AccountUser | null
  /** 会话恢复失败的原因（离线、服务不可用），仅用于提示；此时仍是未登录。 */
  restoreError: string | null
  restore: () => Promise<void>
  login: (input: LoginInput) => Promise<void>
  register: (input: RegisterInput, emailCode: string) => Promise<void>
  logout: () => Promise<void>
}

/** 取用户信息；token 已失效时先换一次新 token，仍失败才认作未登录。 */
async function loadUser(token: string): Promise<{ token: string; user: AccountUser }> {
  try {
    return { token, user: await fetchAccountUser(token) }
  } catch (error) {
    if (!(error instanceof AccountApiError) || error.code !== 401) throw error
    const refreshed = await refreshAccountToken(token)
    return { token: refreshed, user: await fetchAccountUser(refreshed) }
  }
}

export const useAccountStore = create<AccountState>()(
  immer((set, get) => ({
    status: 'uninitialized',
    token: null,
    user: null,
    restoreError: null,

    restore: async () => {
      const state = get()
      const retryable = state.status === 'anonymous' && state.restoreError !== null
      if (state.status !== 'uninitialized' && !retryable) return

      const stored = readAccountToken()
      if (!stored) {
        set((draft) => {
          draft.status = 'anonymous'
          draft.restoreError = null
        })
        return
      }

      set((draft) => {
        draft.status = 'restoring'
        draft.restoreError = null
      })

      try {
        const { token, user } = await loadUser(stored)
        saveAccountToken(token)
        set((draft) => {
          draft.token = token
          draft.user = user
          draft.status = 'authenticated'
        })
      } catch (error) {
        if (error instanceof AccountApiError && error.code === 401) {
          clearAccountToken()
          set((draft) => {
            draft.token = null
            draft.user = null
            draft.status = 'anonymous'
          })
          return
        }
        // 服务不可用时保留本地 token：可能只是断网，重试或下次进来还能恢复。
        set((draft) => {
          draft.status = 'anonymous'
          draft.restoreError = errorMessage(error)
        })
      }
    },

    login: async (input) => {
      const token = await requestLogin(input)
      const user = await fetchAccountUser(token)
      saveAccountToken(token)
      set((draft) => {
        draft.token = token
        draft.user = user
        draft.status = 'authenticated'
        draft.restoreError = null
      })
    },

    register: async (input, emailCode) => {
      await requestRegister(input, emailCode)
      // 注册完直接登录，省掉用户再填一次账号密码；失败则如实报出来。
      try {
        await get().login({ username: input.loginName, password: input.password })
      } catch (error) {
        throw new Error(`注册成功，但自动登录失败：${errorMessage(error)}`, { cause: error })
      }
    },

    logout: async () => {
      const token = get().token
      // 服务端退出是尽力而为：本地登录态无论上游结果都必须清掉。
      if (token) {
        try {
          await requestLogout(token)
        } catch {
          // 忽略：本地照样退出。
        }
      }
      clearAccountToken()
      set((draft) => {
        draft.token = null
        draft.user = null
        draft.status = 'anonymous'
        draft.restoreError = null
      })
    },
  })),
)