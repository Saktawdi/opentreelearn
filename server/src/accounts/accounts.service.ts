import { Injectable } from '@nestjs/common'
import type { Account } from '@prisma/client'
import { PrismaService } from '../prisma/prisma.service'

@Injectable()
export class AccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * 按登录账号找到（或建立）本地账号行，所有同步记录都挂在它下面。
   * 账号系统侧改了 userId 时跟着更新 —— 用 loginName 当映射键，与 Blog BFF 的做法一致。
   */
  async ensure(loginName: string, userId: number): Promise<Account> {
    return this.prisma.account.upsert({
      where: { loginName },
      create: { loginName, userId },
      update: { userId },
    })
  }
}