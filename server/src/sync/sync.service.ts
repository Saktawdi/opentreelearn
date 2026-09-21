import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../prisma/prisma.service'
import type { SyncRecord } from '@prisma/client'
import type { SyncEntity } from '../entities'
import {
  clampPullLimit,
  decideWrite,
  parseRecordData,
  slicePage,
} from './sync-rules'
import type {
  PullResult,
  PushResult,
  SyncStatus,
  WireApplied,
  WireChange,
} from './sync-types'

/** push 里一条待写记录（controller 已校验过形状）。 */
export interface IncomingChange {
  entity: SyncEntity
  id: string
  updatedAt: number
  deletedAt?: number
  data?: unknown
}

@Injectable()
export class SyncService {
  private readonly logger = new Logger('SyncService')

  constructor(private readonly prisma: PrismaService) {}

  /**
   * 增量拉取：返回该账号 rev 大于游标的记录（含 tombstone），按 rev 升序。
   * 游标用服务端分配的 rev 而不是时间戳 —— 客户端时钟不可信，也会回拨。
   */
  async pull(accountId: number, cursor: number, limit?: number): Promise<PullResult> {
    const take = clampPullLimit(limit)
    const rows = await this.prisma.syncRecord.findMany({
      where: { accountId, rev: { gt: cursor } },
      orderBy: { rev: 'asc' },
      // 多取一条只用于判断还有没有下一页
      take: take + 1,
    })

    const { items, hasMore } = slicePage(rows, take)
    const nextCursor = items.length > 0 ? items[items.length - 1].rev : cursor

    return { cursor: nextCursor, hasMore, changes: items.map(toWireChange) }
  }

  /**
   * 批量写入：逐条做 last-write-wins，接受的分配新 rev，判旧的带回服务端版本。
   * 整批放在一个事务里，rev 计数器与记录一起提交，避免并发下发出重复 rev。
   */
  async push(accountId: number, changes: IncomingChange[]): Promise<PushResult> {
    return this.prisma.$transaction(
      async (tx) => {
        const account = await tx.account.findUniqueOrThrow({ where: { id: accountId } })
        let rev = account.revCounter
        const applied: WireApplied[] = []

        for (const change of changes) {
          const where = {
            accountId_entity_localId: {
              accountId,
              entity: change.entity,
              localId: change.id,
            },
          }
          const stored = await tx.syncRecord.findUnique({ where })

          if (stored && decideWrite(stored.clientUpdatedAt, change.updatedAt) === 'stale') {
            applied.push({
              entity: change.entity,
              id: change.id,
              rev: stored.rev,
              status: 'stale',
              record: toWireChange(stored),
            })
            continue
          }

          rev += 1
          const data = change.deletedAt ? '{}' : JSON.stringify(change.data ?? {})
          const saved = await tx.syncRecord.upsert({
            where,
            create: {
              accountId,
              entity: change.entity,
              localId: change.id,
              rev,
              clientUpdatedAt: change.updatedAt,
              deletedAt: change.deletedAt ?? null,
              data,
            },
            update: {
              rev,
              clientUpdatedAt: change.updatedAt,
              deletedAt: change.deletedAt ?? null,
              data,
            },
          })

          applied.push({
            entity: change.entity,
            id: change.id,
            rev: saved.rev,
            status: 'applied',
          })
        }

        if (rev !== account.revCounter) {
          await tx.account.update({ where: { id: accountId }, data: { revCounter: rev } })
        }

        return { cursor: rev, applied }
      },
      { timeout: 20_000, maxWait: 10_000 },
    )
  }

  /** 云端概况：客户端用它判断「云端有没有数据」，决定首次登录时要不要提示合并。 */
  async status(accountId: number): Promise<SyncStatus> {
    const [records, aggregate] = await Promise.all([
      this.prisma.syncRecord.count({ where: { accountId, deletedAt: null } }),
      this.prisma.syncRecord.aggregate({
        where: { accountId },
        _max: { clientUpdatedAt: true },
      }),
    ])

    return {
      records,
      cursor: (
        await this.prisma.account.findUniqueOrThrow({
          where: { id: accountId },
          select: { revCounter: true },
        })
      ).revCounter,
      latestUpdatedAt: aggregate._max.clientUpdatedAt ?? null,
    }
  }
}

export function toWireChange(row: SyncRecord): WireChange {
  return {
    entity: row.entity as SyncEntity,
    id: row.localId,
    rev: row.rev,
    updatedAt: row.clientUpdatedAt,
    deletedAt: row.deletedAt ?? null,
    data: parseRecordData(row.data),
  }
}