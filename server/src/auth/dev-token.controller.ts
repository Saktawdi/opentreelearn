import { Body, Controller, NotFoundException, Post } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { ok } from '../common/response'
import { shouldEnableDevToken } from '../common/runtime-security'
import { DEV_TOKEN_PREFIX, AuthService } from './auth.service'
import { DevTokenDto } from './dto/dev-token.dto'

/**
 * 本地联调用的 token 签发口。
 *
 * 生产环境（或未开 ALLOW_DEV_TOKEN 时）这个路由直接 404，连存在都不暴露 ——
 * 它是唯一绕过账号系统的入口，只能活在开发机上。
 */
@ApiTags('auth')
@Controller('auth')
export class DevTokenController {
  constructor(private readonly auth: AuthService) {}

  @Post('dev-token')
  @ApiOperation({ summary: '开发环境：签发本地联调 token' })
  devToken(@Body() dto: DevTokenDto) {
    if (!shouldEnableDevToken()) {
      throw new NotFoundException('接口不存在')
    }
    const token = this.auth.issueDevToken(dto.loginName)
    return ok({ token, prefix: DEV_TOKEN_PREFIX }, '已签发本地联调 token')
  }
}