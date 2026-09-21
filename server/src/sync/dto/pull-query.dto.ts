import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import { IsInt, IsOptional, Max, Min } from 'class-validator'
import { MAX_PULL_LIMIT } from '../sync-rules'

export class PullQueryDto {
  @ApiPropertyOptional({ description: '上次拉取返回的游标（服务端 rev），首次传 0' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  cursor?: number

  @ApiProperty({
    description: `单页条数，默认 200，上限 ${MAX_PULL_LIMIT}`,
    required: false,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PULL_LIMIT)
  limit?: number
}