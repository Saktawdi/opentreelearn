import {
  CanActivate,
  ExecutionContext,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import type { Request } from 'express'
import type { Account } from '@prisma/client'
import { AccountsService } from '../accounts/accounts.service'
import { AuthService, type RuoYiUserInfo } from './auth.service'

/** 守卫通过后挂在请求上的三样东西。 */
export interface AuthedRequest extends Request {
  user: RuoYiUserInfo
  token: string
  account: Account
}

/**
 * 认证守卫：从 `token` 或 `Authorization: Bearer` 请求头取 token，
 * 转发账号系统 getInfo 校验，再解析出本地账号行挂到请求上。
 *
 * 两种请求头都收：账号系统生态里前端用 `token:`，通用客户端习惯 `Bearer`。
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  private readonly logger = new Logger('JwtAuthGuard')

  constructor(
    private readonly auth: AuthService,
    private readonly accounts: AccountsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthedRequest>()
    const token = extractToken(request)
    if (!token) throw new UnauthorizedException('未提供认证 token')

    let user: RuoYiUserInfo
    try {
      user = await this.auth.getInfo(token)
    } catch (error) {
      // 对外统一是「token 无效」，但服务端必须留下真实原因：
      // 否则 RUIYI_API_URL 配错、账号系统不可用都会被误读成「用户 token 过期」。
      this.logger.warn(`token 校验失败：${error instanceof Error ? error.message : String(error)}`)
      throw new UnauthorizedException('Token 无效或已过期，请重新登录')
    }

    request.user = user
    request.token = token
    request.account = await this.accounts.ensure(user.loginName, user.userId)
    return true
  }
}

export function extractToken(request: Request): string | undefined {
  const authHeader = request.headers.authorization
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const value = authHeader.slice('Bearer '.length).trim()
    if (value) return value
  }
  const tokenHeader = request.headers['token']
  if (typeof tokenHeader === 'string' && tokenHeader.length > 0) return tokenHeader
  return undefined
}