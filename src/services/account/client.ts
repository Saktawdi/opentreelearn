import i18n from '@/i18n'
import { errorMessage } from '@/lib/utils'
import {
  ApiError as AccountApiError,
  interpretEnvelope,
  readJson,
  type ApiEnvelope,
} from '@/services/api/envelope'

// 账号客户端对外沿用 AccountApiError / interpretEnvelope 两个名字：
// 实现已抽到 services/api/envelope.ts，与同步服务共用同一套信封与错误形状。
export { AccountApiError, interpretEnvelope }

/**
 * 若依账号系统客户端。
 *
 * 浏览器直连 `https://api.sakta.top`：该服务已对预检返回
 * `Access-Control-Allow-Origin` 与 `Access-Control-Allow-Headers: token, content-type`，
 * 受保护接口的自定义 `token` 头能通过预检，所以这里不像 LLM 那样需要走 `/api-proxy`。
 */
export const ACCOUNT_BASE_URL = 'https://api.sakta.top'

/** token 存 localStorage，键名沿用生态里既有的 `sakta-token`。 */
export const ACCOUNT_TOKEN_KEY = 'sakta-token'

/**
 * 上次成功登录的账号名（loginName），与 token 配套存本机。
 *
 * 本地库名由 loginName 决定（`opentreelearn:<loginName>`）。冷启动必须**先绑库再载入
 * 数据**，而这一步不该等账号服务：离线时会白屏，慢网时会先按游客库载入再被切掉。
 * 记住账号名就能纯本地切库，token 是否还有效交给后台校验。
 */
export const ACCOUNT_IDENTITY_KEY = 'sakta-account'

export interface AccountRole {
  roleId?: number
  roleName?: string
  roleKey?: string
}

/** 账号系统返回的用户信息；字段全部可选，页面只读它认得的那些。 */
export interface AccountUser {
  userId?: number
  deptId?: number
  loginName?: string
  userName?: string
  email?: string
  phonenumber?: string
  sex?: string
  avatar?: string
  status?: string
  loginDate?: string
  dept?: { deptId?: number; deptName?: string }
  roles?: AccountRole[]
  createTime?: string
}

export type AccountEnvelope<T> = ApiEnvelope<T>

export interface LoginInput {
  username: string
  password: string
}

export interface RegisterInput {
  loginName: string
  password: string
  email: string
  userName?: string
  phonenumber?: string
  sex?: string
}

export interface AccountRequestOptions {
  method?: 'GET' | 'POST' | 'PUT'
  /** 表单体：login / sendCode / updatePassword 走 x-www-form-urlencoded。 */
  form?: Record<string, string>
  /** JSON 体：register / updateInfo 走 application/json。 */
  json?: unknown
  query?: Record<string, string | undefined>
  token?: string | null
}

export function buildAccountRequest(
  path: string,
  options: AccountRequestOptions = {},
): { url: string; init: RequestInit } {
  // URL 拼接用 URL 对象：path 里带查询串（如 ?emailCode=）也能正确合并 searchParams。
  const url = new URL(`${ACCOUNT_BASE_URL}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, value)
  }

  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.token) headers.token = options.token

  let body: string | undefined
  if (options.form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    body = new URLSearchParams(options.form).toString()
  } else if (options.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(options.json)
  }

  return { url: url.toString(), init: { method: options.method ?? 'GET', headers, body } }
}

async function request<T>(
  path: string,
  options: AccountRequestOptions = {},
): Promise<AccountEnvelope<T>> {
  const { url, init } = buildAccountRequest(path, options)

  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    // 网络层失败（离线、DNS、证书、被拦截）不会有响应体，单独给一句能行动的提示。
    throw new AccountApiError(
      i18n.t('common:account.connectFailed', { reason: errorMessage(error) }),
      0,
    )
  }

  return interpretEnvelope<T>(await readJson(response), response.status)
}

/** 登录并返回 token。 */
export async function login(input: LoginInput): Promise<string> {
  const envelope = await request<never>('/v1/user/pub/login', {
    method: 'POST',
    form: { username: input.username, password: input.password },
  })
  if (!envelope.token) throw new AccountApiError(i18n.t('common:account.loginNoToken'), 0)
  return envelope.token
}

/** 发送 6 位注册邮箱验证码。 */
export async function sendRegisterCode(email: string): Promise<void> {
  await request<never>('/v1/user/pub/sendCode', { method: 'POST', form: { email } })
}

/** 注册：`emailCode` 走查询参数，其余字段走 JSON 体。 */
export async function register(input: RegisterInput, emailCode: string): Promise<void> {
  await request<never>('/v1/user/pub/register', {
    method: 'POST',
    query: { emailCode },
    json: {
      loginName: input.loginName,
      password: input.password,
      userName: input.userName?.trim() || input.loginName,
      email: input.email,
      ...(input.phonenumber ? { phonenumber: input.phonenumber } : {}),
      ...(input.sex ? { sex: input.sex } : {}),
    },
  })
}

export async function fetchAccountUser(token: string): Promise<AccountUser> {
  const envelope = await request<AccountUser>('/v1/user/pri/getInfo', { token })
  return envelope.data ?? {}
}

/** 用当前（仍有效的）token 换一个新 token。 */
export async function refreshAccountToken(token: string): Promise<string> {
  const envelope = await request<never>('/v1/user/pri/refreshToken', {
    method: 'POST',
    token,
  })
  if (!envelope.token) throw new AccountApiError(i18n.t('common:account.refreshNoToken'), 0)
  return envelope.token
}

export async function logout(token: string): Promise<void> {
  await request<never>('/v1/user/pri/logout', { method: 'POST', token })
}

/** 头像可能是相对路径（`/profile/avatar/x.png`），补全为账号服务上的绝对地址。 */
export function resolveAvatarUrl(avatar?: string): string | null {
  const value = avatar?.trim()
  if (!value) return null
  if (/^(https?:)?\/\//i.test(value) || value.startsWith('data:')) return value
  return `${ACCOUNT_BASE_URL}${value.startsWith('/') ? '' : '/'}${value}`
}

/** localStorage 在隐私模式/被禁用时会抛错，读不到就当作未登录。 */
export function readAccountToken(): string | null {
  try {
    return window.localStorage.getItem(ACCOUNT_TOKEN_KEY)
  } catch {
    return null
  }
}

export function saveAccountToken(token: string): void {
  try {
    window.localStorage.setItem(ACCOUNT_TOKEN_KEY, token)
  } catch {
    // 存不下也只是这次会话结束后要重新登录，不影响本次使用。
  }
}

export function clearAccountToken(): void {
  try {
    window.localStorage.removeItem(ACCOUNT_TOKEN_KEY)
  } catch {
    // 同上：清不掉不影响内存里的退出。
  }
}

/** 上次登录的账号名；读不到（隐私模式、从未登录）返回 null，此时按游客库启动。 */
export function readAccountIdentity(): string | null {
  try {
    const value = window.localStorage.getItem(ACCOUNT_IDENTITY_KEY)?.trim()
    return value ? value : null
  } catch {
    return null
  }
}

export function saveAccountIdentity(loginName: string | undefined): void {
  try {
    const value = loginName?.trim()
    if (value) window.localStorage.setItem(ACCOUNT_IDENTITY_KEY, value)
    else window.localStorage.removeItem(ACCOUNT_IDENTITY_KEY)
  } catch {
    // 存不下只是退化成「启动先看游客库、进我的页再切」，不值得打断登录流程。
  }
}

export function clearAccountIdentity(): void {
  try {
    window.localStorage.removeItem(ACCOUNT_IDENTITY_KEY)
  } catch {
    // 同上。
  }
}