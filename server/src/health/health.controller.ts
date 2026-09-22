import { Controller, Get, ServiceUnavailableException } from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { ok } from '../common/response'
import { PrismaService } from '../prisma/prisma.service'

/**
 * 存活探针：无鉴权，供容器 / 负载均衡健康检查使用。
 *
 * 顺带 ping 一次数据库——只回 200 但数据库断了的话，编排层会继续把流量打进来。
 * 不做业务校验（不查记录数），保持廉价、可高频调用。
 */
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  @Get()
  @ApiOperation({ summary: '存活与数据库连通性（无鉴权）' })
  async check() {
    try {
      await this.prisma.$queryRaw`SELECT 1`
    } catch {
      throw new ServiceUnavailableException('数据库不可用')
    }
    return ok({ status: 'ok' })
  }
}