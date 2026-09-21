import { createDefaultSettings, clampContextBudget } from './defaults'
import type {
  GlobalSettings,
  ModelRef,
  Note,
  ProviderConfig,
  ProviderKind,
  Project,
} from './models'
import { isNoteKind } from './notes'

/**
 * 存储读回边界的数据归一化。
 *
 * 为什么需要它：IndexedDB 里的记录是没有 schema 约束的历史数据 —— 旧版本写入的、
 * 手工改过的、导入 `.tree` 时字段缺失的，都会以「类型上合法、运行时缺字段」的形态
 * 回到内存里。UI 层于是到处 `.map` / `.length` 直接访问嵌套字段，一条坏记录就能在
 * 渲染期抛出 TypeError；没有 error boundary 时整棵 React 树会被卸载成白屏。
 *
 * 与其在每个 UI 调用点补 `?? []`（既散落、又会让 UI 层承担存储契约），不如在
 * `data` 读取边界一次性收敛：读出来的对象保证是完整形状，上层可以放心直接访问。
 *
 * 本模块是纯函数，只依赖 `domain` 内部类型与默认值，不碰存储 / React / 网络。
 */

const PROVIDER_KINDS: readonly ProviderKind[] = [
  'openai',
  'anthropic',
  'google',
  'openai-compatible',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** 只接受有限数值；其余（含数字字符串）一律回退，避免把隐式转换的坑带进业务层。 */
function readNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** 过滤非字符串、去空白、丢空串 —— 与 `collectTags` / `ModelPicker` 的口径保持一致。 */
function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const result: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const trimmed = item.trim()
    if (trimmed) result.push(trimmed)
  }
  return result
}

export function normalizeModelRef(value: unknown): ModelRef | null {
  if (!isRecord(value)) return null
  const providerId = readString(value.providerId)
  const modelId = readString(value.modelId)
  if (!providerId || !modelId) return null
  return { providerId, modelId }
}

export function normalizeProvider(value: unknown): ProviderConfig | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null

  const kind = PROVIDER_KINDS.includes(value.kind as ProviderKind)
    ? (value.kind as ProviderKind)
    : 'openai-compatible'

  return {
    id,
    label: readString(value.label) ?? '未命名提供商',
    kind,
    apiKey: readString(value.apiKey) ?? '',
    baseURL: readString(value.baseURL),
    models: readStringArray(value.models),
  }
}

export function normalizeProject(value: unknown, now = Date.now()): Project | null {
  if (!isRecord(value)) return null
  const id = readString(value.id)
  if (!id) return null

  const createdAt = readNumber(value.createdAt, now)

  return {
    id,
    name: readString(value.name) ?? '未命名项目',
    description: readString(value.description),
    tags: readStringArray(value.tags),
    createdAt,
    updatedAt: readNumber(value.updatedAt, createdAt),
  }
}

/**
 * 笔记的读回归一化。
 *
 * `start` / `end` 决定这段笔记画在正文的哪一段上，坏值（负的、倒置的、非数值的）
 * 会让渲染期的 Range 直接抛错，所以这里一律夹紧：起点不为负，终点不早于起点。
 * 缺少 `projectId` / `nodeId` / `messageId` 的记录无法归属到任何消息，也就永远
 * 渲染不出来，直接丢弃而不是留在库里越积越多。
 */
export function normalizeNote(value: unknown, now = Date.now()): Note | null {
  if (!isRecord(value)) return null

  const id = readString(value.id)
  const projectId = readString(value.projectId)
  const nodeId = readString(value.nodeId)
  const messageId = readString(value.messageId)
  if (!id || !projectId || !nodeId || !messageId) return null

  const quote = readString(value.quote) ?? ''
  const start = Math.max(0, Math.floor(readNumber(value.start, 0)))
  const end = Math.max(start, Math.floor(readNumber(value.end, start + quote.length)))
  const createdAt = readNumber(value.createdAt, now)

  return {
    id,
    projectId,
    nodeId,
    messageId,
    kind: isNoteKind(value.kind) ? value.kind : 'highlight',
    quote,
    start,
    end,
    body: readString(value.body),
    createdAt,
    updatedAt: readNumber(value.updatedAt, createdAt),
  }
}

export function normalizeGlobalSettings(value: unknown): GlobalSettings {
  const defaults = createDefaultSettings()
  if (!isRecord(value)) return defaults

  return {
    backgroundProfile: readString(value.backgroundProfile) ?? defaults.backgroundProfile,
    defaultChatModelRef: normalizeModelRef(value.defaultChatModelRef),
    titleModelRef: normalizeModelRef(value.titleModelRef),
    summaryModelRef: normalizeModelRef(value.summaryModelRef),
    contextBudget: clampContextBudget(
      readNumber(value.contextBudget, defaults.contextBudget),
    ),
    providers: Array.isArray(value.providers)
      ? value.providers
          .map(normalizeProvider)
          .filter((provider): provider is ProviderConfig => provider !== null)
      : [],
    updatedAt: readNumber(value.updatedAt, defaults.updatedAt),
  }
}
