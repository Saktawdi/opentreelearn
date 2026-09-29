import {
  BadGatewayException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import axios, { type AxiosInstance, type AxiosError } from 'axios'
import https from 'node:https'
import { shouldEnableDevToken, shouldEnableInsecureTls } from '../common/runtime-security'

/** 若依 getInfo 返回的用户信息（只列本地会用到的字段）。 */
export interface RuoYiUserInfo {
  userId: number
  loginName: string
  userName?: string
  email?: string
  avatar?: string
  roles?: Array<{ roleId?: number; roleName?: string; roleKey?: string }>
}

/** 若依统一响应信封。 */
interface RuoYiEnvelope {
  code: number
  msg?: string
  data?: unknown
}

const TOKEN_CACHE_TTL_MS = 60_000
export const DEV_TOKEN_PREFIX = 'dev-'

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)
  private readonly http: AxiosInstance
  /**
   * token → 用户信息缓存。同步是批量请求且会连续发生（push 完立刻 pull），
   * 每个请求都打一次账号系统没有必要；TTL 内直接复用，过期后自然重验。
   */
  private readonly tokenCache = new Map<string, { user: RuoYiUserInfo; expireAt: number }>()

  constructor(config: ConfigService) {
    const baseURL = config.get<string>('RUIYI_API_URL')
    if (!baseURL) {
      throw new Error('缺少 RUIYI_API_URL：服务端需要它校验客户端 token')
    }

    // 启动时留档上游地址：云端 502 排查时先确认这一行是不是预期的账号系统
    this.logger.log(`账号系统校验地址：${baseURL}`)

    this.http = axios.create({
      baseURL,
      timeout: 10_000,
      // 本机不信任账号系统证书链时（开发环境）跳过校验，见 .env.example
      httpsAgent: shouldEnableInsecureTls()
        ? new https.Agent({ rejectUnauthorized: false })
        : undefined,
    })
  }

  /**
   * 签发本地联调 token。是否允许由调用方（DevTokenController）按环境判定，
   * 这里只负责形状：`dev-<loginName>`，校验时被 getInfo 直接认成该账号。
   */
  issueDevToken(loginName?: string): string {
    const name = loginName?.trim() || 'dev'
    return `${DEV_TOKEN_PREFIX}${name}`
  }

  /**
   * 校验 token 并取用户：远端只提供 getInfo，没有 introspect 接口，
   * 也没有共享签名密钥，所以这里转发校验（与 Blog BFF 的 JwtAuthGuard 同一策略）。
   */
  async getInfo(token: string): Promise<RuoYiUserInfo> {
    if (shouldEnableDevToken() && token.startsWith(DEV_TOKEN_PREFIX)) {
      return devUser(token)
    }

    const cached = this.tokenCache.get(token)
    if (cached && cached.expireAt > Date.now()) return cached.user

    let envelope: RuoYiEnvelope
    const startedAt = Date.now()
    try {
      const response = await this.http.get<RuoYiEnvelope>('/v1/user/pri/getInfo', {
        headers: { token },
      })
      envelope = response.data
      this.logger.verbose(
        `账号系统 getInfo 成功：HTTP ${response.status}，耗时 ${Date.now() - startedAt}ms`,
      )
    } catch (error) {
      // 401 与网络类失败都由守卫统一翻成 401，这里不做区分；
      // 但真实原因（HTTP 状态 / 网络错误码 / 耗时）必须落在自己的日志里
      this.logger.warn(
        `账号系统 getInfo 失败（${describeUpstreamError(error)}），耗时 ${Date.now() - startedAt}ms`,
      )
      throw new UnauthorizedException(describeUpstreamError(error))
    }

    if (!envelope || typeof envelope.code !== 'number' || envelope.code !== 0) {
      const message = envelope?.msg?.trim() || '账号系统校验 token 失败'
      if (envelope?.code === 401 || envelope?.code === undefined) {
        throw new UnauthorizedException(message)
      }
      throw new BadGatewayException(message)
    }

    const user = normalizeUser(envelope.data)
    if (!user) throw new UnauthorizedException('账号系统没有返回可用的用户信息')

    this.tokenCache.set(token, { user, expireAt: Date.now() + TOKEN_CACHE_TTL_MS })
    return user
  }
}

function normalizeUser(data: unknown): RuoYiUserInfo | null {
  if (!data || typeof data !== 'object') return null
  const raw = data as Record<string, unknown>
  const loginName = typeof raw.loginName === 'string' ? raw.loginName.trim() : ''
  if (!loginName) return null
  return {
    userId: typeof raw.userId === 'number' ? raw.userId : 0,
    loginName,
    userName: typeof raw.userName === 'string' ? raw.userName : undefined,
    email: typeof raw.email === 'string' ? raw.email : undefined,
    avatar: typeof raw.avatar === 'string' ? raw.avatar : undefined,
    roles: Array.isArray(raw.roles) ? (raw.roles as RuoYiUserInfo['roles']) : undefined,
  }
}

function devUser(token: string): RuoYiUserInfo {
  const loginName = token.slice(DEV_TOKEN_PREFIX.length).trim() || 'dev'
  return { userId: 0, loginName, userName: `本地联调账号 ${loginName}` }
}

function describeUpstreamError(error: unknown): string {
  const axiosError = error as AxiosError | undefined
  const status = axiosError?.response?.status
  const upstreamMsg = (axiosError?.response?.data as RuoYiEnvelope | undefined)?.msg
  if (upstreamMsg) return `${upstreamMsg}（HTTP ${status}）`
  if (status) return `账号系统返回 HTTP ${status}`
  // 没有响应 = 连接层失败：带上 axios 错误码（ENOTFOUND / ECONNREFUSED / ECONNABORTED /
  // CERT_HAS_EXPIRED…）与底层 message，云端排查时才能区分 DNS、防火墙和超时
  const code = axiosError?.code
  const detail = axiosError?.message ? `：${axiosError.message}` : ''
  return `无法连接账号系统${code ? `（错误码 ${code}）` : ''}${detail}`
}