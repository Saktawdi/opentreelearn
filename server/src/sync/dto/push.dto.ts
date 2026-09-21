import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger'
import { Type } from 'class-transformer'
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator'
import { SYNC_ENTITIES, type SyncEntity } from '../../entities'
import { MAX_PUSH_CHANGES } from '../sync-rules'

export class SyncChangeDto {
  @ApiProperty({ enum: SYNC_ENTITIES, description: '实体名' })
  @IsIn(SYNC_ENTITIES as unknown as string[])
  entity: SyncEntity

  @ApiProperty({ description: '客户端生成的实体 id' })
  @IsString()
  @Length(1, 128)
  id: string

  @ApiProperty({ description: '客户端时钟（epoch ms），LWW 依据' })
  @IsNumber()
  @Min(0)
  updatedAt: number

  @ApiPropertyOptional({ description: '删除标记（epoch ms）；带上它就是 tombstone，data 会被忽略' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  deletedAt?: number

  @ApiPropertyOptional({ description: '实体内容；tombstone 不需要' })
  @IsOptional()
  @IsObject()
  data?: Record<string, unknown>
}

export class PushDto {
  @ApiProperty({ type: [SyncChangeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_PUSH_CHANGES)
  @ValidateNested({ each: true })
  @Type(() => SyncChangeDto)
  changes: SyncChangeDto[]
}