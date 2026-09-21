import { Module } from '@nestjs/common'
import { AuthService } from './auth.service'
import { DevTokenController } from './dev-token.controller'
import { JwtAuthGuard } from './jwt-auth.guard'

@Module({
  controllers: [DevTokenController],
  providers: [AuthService, JwtAuthGuard],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}