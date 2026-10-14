import { z } from 'zod'
import { getDatabase } from '@/data'
import type { AppDatabase } from '@/data/dexie/db'
import { freeAskConversationSchema, freeAskMessageSchema } from '@/domain/review/free-ask'
import type { SyncEntity } from '@/domain/sync'
import i18n from '@/i18n'
import { downloadFile } from '@/services/export/tree-export'

// Back up every account-local data table. Sync cursors and pending operations belong
// to the destination device: imports create fresh operations instead of replaying them.
export const BACKUP_TABLES = [
  'projects', 'projectSettings', 'nodes', 'messages', 'assets', 'notes', 'settings',
  'reviewSessions', 'modelCatalog', 'composerDrafts', 'freeAskConversations',
  'freeAskMessages', 'freeAskLocal',
] as const
type BackupTable = typeof BACKUP_TABLES[number]
type Row = Record<string, unknown>

export interface DataBackup {
  format: 'opentreelearn-backup'
  version: 1
  exportedAt: number
  tables: Record<BackupTable, Row[]>
}

const id = z.string().min(1)
const time = z.number().finite().nonnegative()
const record = z.looseObject({ id })
const projectRecord = record.extend({ projectId: id })
const asset = projectRecord.extend({
  kind: z.literal('image'), mime: z.string(), createdAt: time, blob: z.instanceof(Blob),
})
const schemas = {
  projects: record.extend({ name: z.string(), tags: z.array(z.string()), createdAt: time, updatedAt: time }),
  projectSettings: z.looseObject({ projectId: id }),
  nodes: projectRecord.extend({
    title: z.string(), parentId: id.nullable(), status: z.enum(['active', 'archived']),
    createdAt: time, updatedAt: time,
  }),
  messages: projectRecord.extend({
    nodeId: id, role: z.enum(['user', 'assistant', 'system']), createdAt: time,
    parts: z.array(z.discriminatedUnion('type', [
      z.looseObject({ type: z.literal('text'), text: z.string() }),
      z.looseObject({ type: z.literal('quote'), text: z.string() }),
      z.looseObject({ type: z.literal('image'), assetId: id }),
      z.looseObject({ type: z.literal('tool'), callId: id, name: id, input: z.unknown() }),
    ])),
  }),
  assets: asset,
  notes: projectRecord.extend({
    nodeId: id, messageId: id, quote: z.string(), start: time, end: time,
    createdAt: time, updatedAt: time,
  }),
  settings: z.looseObject({
    key: z.literal('global'), value: z.looseObject({
      backgroundProfile: z.string(), providers: z.array(z.looseObject({
        id, label: z.string(), kind: z.enum(['openai', 'anthropic', 'google', 'openai-compatible']),
        apiKey: z.string(), models: z.array(z.string()),
      })),
    }),
  }),
  reviewSessions: projectRecord.extend({
    schemaVersion: z.number().int().positive(), version: z.number().int().positive(),
    status: z.enum(['active', 'paused', 'completed', 'ended']), open: z.union([z.literal(0), z.literal(1)]),
    cursor: z.number().int().nonnegative(), createdAt: time, updatedAt: time,
    items: z.array(z.looseObject({ itemId: id, nodeId: id, title: z.string(), messages: z.array(z.looseObject({ id })) })),
  }),
  modelCatalog: z.looseObject({ key: id, raw: z.unknown(), fetchedAt: time }),
  composerDrafts: projectRecord.extend({
    nodeId: id, text: z.string(), quotes: z.array(z.string()), assets: z.array(asset), updatedAt: time,
  }),
  freeAskConversations: freeAskConversationSchema.loose(),
  freeAskMessages: freeAskMessageSchema.loose(),
  freeAskLocal: projectRecord.extend({
    activeConversationId: id.optional(), draft: z.string().optional(), pendingImages: z.array(asset).optional(),
  }),
} satisfies Record<BackupTable, z.ZodType>

function invalidBackup(): never {
  throw new Error(i18n.t('me:backup.invalidFile'))
}

function rowKey(table: BackupTable, row: Row): string {
  return String(row[table === 'projectSettings' ? 'projectId' :
    table === 'settings' || table === 'modelCatalog' ? 'key' : 'id'])
}

// Images also occur inside unsent drafts; traverse the entire snapshot so these
// blobs are included just like assets that have already been sent.
async function encode(value: unknown): Promise<unknown> {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer())
    const chunks: string[] = []
    for (let offset = 0; offset < bytes.length; offset += 32768) {
      chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)))
    }
    return { __opentreelearnBlob: { mime: value.type, base64: btoa(chunks.join('')) } }
  }
  if (Array.isArray(value)) return Promise.all(value.map(encode))
  if (value && typeof value === 'object') {
    return Object.fromEntries(await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [key, await encode(entry)]),
    ))
  }
  return value
}

function decode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(decode)
  if (!value || typeof value !== 'object') return value
  const object = value as Row
  if ('__opentreelearnBlob' in object) {
    const result = z.object({ __opentreelearnBlob: z.object({ mime: z.string(), base64: z.string() }) }).strict().safeParse(object)
    if (!result.success) return invalidBackup()
    const { mime, base64 } = result.data.__opentreelearnBlob
    const binary = atob(base64)
    return new Blob([Uint8Array.from(binary, (char) => char.charCodeAt(0))], { type: mime })
  }
  return Object.fromEntries(Object.entries(object).map(([key, entry]) => [key, decode(entry)]))
}

function validateBackup(value: unknown): DataBackup {
  const envelope = z.object({
    format: z.literal('opentreelearn-backup'), version: z.literal(1), exportedAt: time,
    tables: z.record(z.string(), z.array(z.record(z.string(), z.unknown()))),
  }).safeParse(value)
  if (!envelope.success) return invalidBackup()
  const { tables } = envelope.data
  if (Object.keys(tables).some((name) => !BACKUP_TABLES.includes(name as BackupTable))) return invalidBackup()
  for (const name of BACKUP_TABLES) {
    const rows = tables[name]
    if (!rows || rows.some((row) => !schemas[name].safeParse(row).success)) return invalidBackup()
    if (new Set(rows.map((row) => rowKey(name, row))).size !== rows.length) return invalidBackup()
  }
  const projects = new Set(tables.projects.map((row) => row.id))
  for (const name of BACKUP_TABLES) {
    if (['projects', 'settings', 'modelCatalog'].includes(name)) continue
    if (tables[name].some((row) => !projects.has(row.projectId))) return invalidBackup()
  }
  const nodes = new Map(tables.nodes.map((row) => [row.id, row.projectId]))
  for (const row of [...tables.messages, ...tables.composerDrafts]) {
    if (nodes.get(row.nodeId) !== row.projectId) return invalidBackup()
  }
  const conversations = new Map(tables.freeAskConversations.map((row) => [row.id, row.projectId]))
  for (const row of tables.freeAskMessages) {
    if (conversations.get(row.conversationId) !== row.projectId) return invalidBackup()
  }
  for (const row of tables.composerDrafts) {
    if (row.id !== row.nodeId) return invalidBackup()
  }
  for (const row of tables.reviewSessions) {
    const open = row.status === 'active' || row.status === 'paused'
    if (row.open !== Number(open) || Number(row.cursor) > (row.items as unknown[]).length) return invalidBackup()
  }
  // Validate without normalizing or stripping fields: all historical versions,
  // tool results, review schedules and future optional fields must survive intact.
  return envelope.data as DataBackup
}

export async function exportAllData(db: AppDatabase = getDatabase()): Promise<string> {
  const tables = await db.transaction('r', BACKUP_TABLES.map((name) => db.table(name)), async () => {
    const entries = await Promise.all(BACKUP_TABLES.map(async (name) => [name, await db.table(name).toArray()]))
    return Object.fromEntries(entries)
  })
  return JSON.stringify(await encode({ format: 'opentreelearn-backup', version: 1, exportedAt: Date.now(), tables }))
}

export async function downloadAllData(): Promise<void> {
  const content = await exportAllData()
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  downloadFile(content, `opentreelearn-backup-${stamp}.json`)
}

export function parseDataBackup(content: string): DataBackup {
  try {
    return validateBackup(decode(JSON.parse(content)))
  } catch {
    return invalidBackup()
  }
}

const syncEntities: Partial<Record<BackupTable, SyncEntity>> = {
  projects: 'project', projectSettings: 'projectSettings', nodes: 'node', messages: 'message',
  notes: 'note', settings: 'globalSettings', freeAskConversations: 'freeAskConversation',
  freeAskMessages: 'freeAskMessage',
}

export async function importAllData(backup: DataBackup, db: AppDatabase = getDatabase()): Promise<void> {
  validateBackup(backup)
  await db.transaction('rw', [...BACKUP_TABLES.map((name) => db.table(name)), db.outbox], async () => {
    for (const name of BACKUP_TABLES) {
      const rows = backup.tables[name]
      if (rows.length === 0) continue
      const entity = syncEntities[name]
      if (entity) {
        for (const row of rows) {
          const key = rowKey(name, row)
          const existing = await db.table(name).get(key) as Row | undefined
          const pending = await db.outbox.where('[entity+localId]').equals([entity, key]).toArray()
          const stampOf = (value: Row | undefined) => {
            const payload = name === 'settings' ? value?.value as Row | undefined : value
            return typeof payload?.updatedAt === 'number' ? payload.updatedAt : 0
          }
          const updatedAt = Math.max(
            Date.now(), stampOf(row) + 1, stampOf(existing) + 1,
            ...pending.map((entry) => entry.updatedAt + 1),
          )
          await db.outbox.where('[entity+localId]').equals([entity, key]).delete()
          await db.outbox.add({ entity, localId: key, op: 'upsert', updatedAt })
        }
      }
      // Merge by original primary key; projects absent from the backup are retained.
      await db.table(name).bulkPut(rows)
    }
    // Two devices can have different unfinished batches for one project. Preserve
    // their contents, but allow only the most recently active batch to stay open.
    for (const project of backup.tables.projects) {
      const sessions = await db.reviewSessions.where('[projectId+open]').equals([project.id as string, 1]).toArray()
      sessions.sort((a, b) => b.updatedAt - a.updatedAt)
      for (const session of sessions.slice(1)) {
        await db.reviewSessions.put({
          ...session, open: 0, status: 'ended', version: session.version + 1,
          finishedAt: session.finishedAt ?? Date.now(),
        })
      }
    }
  })
}
