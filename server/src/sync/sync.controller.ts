import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common'
import { ApiOperation, ApiTags } from '@nestjs/swagger'
import { JwtAuthGuard, type AuthedRequest } from '../auth/jwt-auth.guard'
import { ok } from '../common/response'
import { MAX_RECORD_JSON_BYTES, recordByteLength } from './sync-rules'
import { SyncService } from './sync.service'
import { PullQueryDto } from './dto/pull-query.dto'
import { PushDto, type SyncChangeDto } from './dto/push.dto'

@ApiTags('sync')
@Controller('sync')
@UseGuards(JwtAuthGuard)
export class SyncController {
  constructor(private readonly sync: SyncService) {}

  @Get('pull')
  @ApiOperation({ summary: '按游标增量拉取记录（含 tombstone）' })
  async pull(@Req() request: AuthedRequest, @Query() query: PullQueryDto) {
    const result = await this.sync.pull(request.account.id, query.cursor ?? 0, query.limit)
    return ok(result)
  }

  @Post('push')
  @ApiOperation({ summary: '批量写入本地变更（逐条 last-write-wins）' })
  async push(@Req() request: AuthedRequest, @Body() body: PushDto) {
    assertRecordSizes(body.changes)
    const result = await this.sync.push(request.account.id, body.changes)
    return ok(result)
  }

  @Get('status')
  @ApiOperation({ summary: '云端概况：当前账号、记录数、最新游标' })
  async status(@Req() request: AuthedRequest) {
    const status = await this.sync.status(request.account.id)
    return ok({
      account: { loginName: request.account.loginName, userId: request.account.userId },
      ...status,
    })
  }
}

/** 单条载荷上限在协议层挡住：一条超大的记录会拖垮整批 push，也会撑爆客户端内存。 */
function assertRecordSizes(changes: SyncChangeDto[]): void {
  for (const change of changes) {
    const bytes = recordByteLength(change.data)
    if (bytes > MAX_RECORD_JSON_BYTES) {
      throw new BadRequestException(
        `记录过大：${change.entity}/${change.id} 约 ${Math.round(bytes / 1024)}KB，上限 ${MAX_RECORD_JSON_BYTES / 1024}KB`,
      )
    }
  }
}