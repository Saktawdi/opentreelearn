import { ApiPropertyOptional } from '@nestjs/swagger'
import { IsOptional, IsString, Length, Matches } from 'class-validator'

export class DevTokenDto {
  @ApiPropertyOptional({ description: '联调账号名，默认 dev' })
  @IsOptional()
  @IsString()
  @Length(1, 64)
  @Matches(/^[A-Za-z0-9_-]+$/, { message: '账号名只能是字母、数字、下划线或连字符' })
  loginName?: string
}