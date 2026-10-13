import 'reflect-metadata'
import { describe, expect, it } from 'vitest'
import { plainToInstance } from 'class-transformer'
import { validate } from 'class-validator'
import { PushDto } from './dto/push.dto'

describe('Free Q&A sync protocol', () => {
  it('accepts conversation and message records through the push DTO', async () => {
    const request = plainToInstance(PushDto, { changes: [
      { entity: 'freeAskConversation', id: 'c1', updatedAt: 1, data: { id: 'c1', projectId: 'p1', title: '图论' } },
      { entity: 'freeAskMessage', id: 'm1', updatedAt: 2, data: { id: 'm1', conversationId: 'c1', text: '```mermaid\nflowchart LR\n A-->B\n```' } },
    ] })
    expect(await validate(request)).toEqual([])
  })
})
