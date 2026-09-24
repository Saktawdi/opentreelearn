import { getDatabase } from '@/data'
import { MODEL_CATALOG_KEY } from '@/data/dexie/db'
import type { CustomModelConfig } from '@/domain/models'

/**
 * 模型目录服务（models.dev）。
 *
 * 智能匹配的数据源：models.dev 是 opencode 生态的模型元数据目录，里面每个模型
 * 会**自声明**推理能力（`reasoning: true/false`）与支持的档位（`reasoning_options`，
 * 如 `[{type:'effort',values:['low','medium','high','xhigh']}]` 或 `[{type:'toggle'}]`）。
 * 推理强度控件据此给候选，而不是硬编码一套全局档位。
 *
 * 匹配原则复刻 OpenWorktree 的「宁可少匹配，不可匹配错」：只做可解释的形态归一
 * （大小写/点号/日期戳），不做模糊打分。本机网关填的 id 与目录 id 常不一致，
 * 匹配不到就退回自由输入 —— 目录只是增强，不是门槛。
 */

/** SDK 顶层 `reasoning` 设置的全部合法取值（见 @ai-sdk/provider 的 LanguageModelV4CallOptions）。 */
export const ALLOWED_REASONING_LEVELS = [
  'provider-default',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
] as const

export type ReasoningLevel = (typeof ALLOWED_REASONING_LEVELS)[number]

/** 展示序：推理从弱到强；'none' 是「关闭」，排在最后。 */
export const REASONING_LEVEL_ORDER: readonly ReasoningLevel[] = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
]

/** 面向用户的档位文案；'provider-default' 不出现在候选里（「自动」语义由值 'auto' 表达）。 */
export const REASONING_LEVEL_LABEL: Partial<Record<ReasoningLevel, string>> = {
  none: '关闭推理',
  minimal: '极简',
  low: '低',
  medium: '中',
  high: '高',
  xhigh: '最高',
}

export const MODELS_DEV_URL = 'https://models.dev/api.json'

/** 目录缓存有效期；拉取失败退回旧缓存，不阻塞手填。 */
export const MODELS_DEV_TTL_MS = 10 * 60 * 1000

const ALLOWED_SET: ReadonlySet<string> = new Set<string>(ALLOWED_REASONING_LEVELS)

/** 'auto'（或缺失）以外、且属于 SDK 合法档位的值才随请求携带。 */
export function isValidReasoningLevel(value: string | undefined): value is ReasoningLevel {
  return value !== undefined && value !== 'auto' && ALLOWED_SET.has(value)
}

/**
 * 生效值解析：会话级覆盖（非 auto）优先，其次供应商配置（非 auto），
 * 都不是则返回 undefined（不传参，跟随厂商默认）。
 */
export function effectiveReasoningEffort(
  override: string | undefined,
  stored: string | undefined,
): ReasoningLevel | undefined {
  const candidate = override && override !== 'auto' ? override : stored
  return isValidReasoningLevel(candidate) ? candidate : undefined
}

/** models.dev 条目的最小结构（外部数据，全部字段按 unknown 保守读取）。 */
export interface ModelCatalogEntry {
  id?: unknown
  name?: unknown
  description?: unknown
  reasoning?: unknown
  reasoning_options?: unknown
  limit?: {
    context?: unknown
  }
  modalities?: {
    input?: unknown
  }
}

export type ModelCatalogEntries = Record<string, ModelCatalogEntry>

export interface CatalogSnapshot {
  entries: ModelCatalogEntries
  fetchedAt: number
  /** 本次返回的目录是否新鲜（也就是有没有真拉到） */
  ok: boolean
  /** 是否来自缓存（可能已过期） */
  cached: boolean
}

export interface MatchedModel {
  /** 目录里的原始 id（如 deepseek-ai/DeepSeek-V4-Pro） */
  entryId: string
  reasoning: boolean
  reasoningOptions: unknown[]
  contextLimit?: number
  hasVision?: boolean
}

/** 一次目录拉取 + 缓存判定。拉取失败时退回旧缓存（cached: true, ok: false），把决定权留给调用方。 */
export async function loadModelCatalog(options?: { forceRefresh?: boolean }): Promise<CatalogSnapshot> {
  const row = await getDatabase().modelCatalog.get(MODEL_CATALOG_KEY)
  const fresh =
    !options?.forceRefresh &&
    row !== undefined &&
    Date.now() - row.fetchedAt < MODELS_DEV_TTL_MS

  if (fresh) return toSnapshot(row.raw, row.fetchedAt)

  try {
    const response = await fetch(MODELS_DEV_URL, { headers: { accept: 'application/json' } })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const raw: unknown = await response.json()
    const fetchedAt = Date.now()
    await getDatabase().modelCatalog.put({ key: MODEL_CATALOG_KEY, raw, fetchedAt })
    return toSnapshot(raw, fetchedAt)
  } catch {
    // 拉不到就用旧缓存；完全没有则给空目录，调用方按其语义处理（纯自由输入）
    return row !== undefined ? toSnapshot(row.raw, row.fetchedAt) : emptySnapshot()
  }
}

function toSnapshot(raw: unknown, fetchedAt: number): CatalogSnapshot {
  return {
    entries: parseEntries(raw),
    fetchedAt,
    ok: true,
    cached: fetchedAt < Date.now() - MODELS_DEV_TTL_MS,
  }
}

function emptySnapshot(): CatalogSnapshot {
  return { entries: {}, fetchedAt: 0, ok: false, cached: false }
}

/**
 * 解析 models.dev 的两层结构并展平为模型字典：
 * 数据顶层是提供商（如 `{ "deepseek": { ..., "models": { "deepseek/deepseek-v4-pro": { ... } } } }`）。
 * 必须把每家下的 `models` 抽出来展平到顶层，才能搜到真实的 3800+ 款模型！
 */
function parseEntries(value: unknown): ModelCatalogEntries {
  if (typeof value !== 'object' || value === null) return {}
  const entries: ModelCatalogEntries = {}

  for (const provider of Object.values(value)) {
    if (typeof provider !== 'object' || provider === null) continue
    const providerRecord = provider as Record<string, unknown>

    // 结构 A：顶层 provider 下有 models 字典（models.dev 的标准形状）
    if (typeof providerRecord.models === 'object' && providerRecord.models !== null) {
      for (const [modelId, entry] of Object.entries(providerRecord.models)) {
        if (typeof entry === 'object' && entry !== null) {
          entries[modelId] = entry as ModelCatalogEntry
        }
      }
    } else {
      // 结构 B：扁平模型条目兜底
      const modelId = typeof providerRecord.id === 'string' ? providerRecord.id : null
      if (modelId) {
        entries[modelId] = providerRecord as ModelCatalogEntry
      }
    }
  }

  return entries
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** 形态归一：小写 + 全去非字母数字。点号/斜杠/下划线/空格全部抹平。 */
function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

/** 厂商前缀段（'/' 之前）；没有则 null。 */
function vendorOf(key: string): string | null {
  const index = key.indexOf('/')
  return index > 0 ? key.slice(0, index) : null
}

/** 剥掉厂商前缀，只留裸模型名。 */
function bareId(key: string): string {
  const vendor = vendorOf(key)
  return vendor ? key.slice(vendor.length + 1) : key
}

/** 剥常见版本尾巴：日期戳（20250131 / 2025-01-31）与 -vN(.N)*，再剥一层标记词。 */
function stripVersionSuffix(key: string): string {
  const withoutDate = key.replace(/(\d{4}[-_]?\d{2}[-_]?\d{2}|-v\d+(\.\d+)*|\.v\d+)$/i, '')
  return withoutDate.replace(/\b(latest|preview|stable|nightly)\b$/, '')
}

/**
 * 归一化天梯匹配：精确 → 版本剥离 → 裸 id（剥厂商前缀）→ 裸 id 剥版本。
 *
 * 每一步都在「目录 id 的归一化键」里找**完全相等**，不做子串模糊。厂商前缀必须在
 * 归一化**之前**剥（normalizeKey 会把 `/` 也抹掉，剥完前缀才算得对）。
 * 用户侧带头剥前缀是怕网关填的 id 与目录粒度不同（`deepseek-chat` vs
 * `deepseek-ai/deepseek-chat`）；四轮剥完还不相等就是真不认识 —— 返回 null，
 * 调用方退回自由输入。严格相等天然防跨厂商错配（`glm-5.2-old` 不会等于任何 deepseek 键）。
 */
export function matchModel(
  rawId: string,
  entries: ModelCatalogEntries,
): MatchedModel | null {
  const trimmed = rawId.trim()
  if (trimmed.length === 0) return null

  const needleKey = normalizeKey(trimmed)
  const needleKeyStripped = normalizeKey(stripVersionSuffix(trimmed))
  const needleBare = normalizeKey(bareId(trimmed))
  const needleBareStripped = normalizeKey(bareId(stripVersionSuffix(trimmed)))

  // 预归一化一次，后续比较全走内存数组（目录几千条，别在 find 回调里反复 normalize）
  const rows = Object.keys(entries).map((id) => ({
    id,
    key: normalizeKey(id),
    keyStripped: normalizeKey(stripVersionSuffix(id)),
    bare: normalizeKey(bareId(id)),
    bareStripped: normalizeKey(bareId(stripVersionSuffix(id))),
  }))

  const find = (field: 'key' | 'keyStripped' | 'bare' | 'bareStripped', value: string) =>
    rows.find((row) => row[field] === value)?.id

  const hit =
    find('key', needleKey) ??
    find('keyStripped', needleKeyStripped) ??
    find('bare', needleBare) ??
    find('bareStripped', needleBareStripped)

  if (!hit) return null

  const entry = entries[hit]
  const reasoningOptions = Array.isArray(entry.reasoning_options) ? entry.reasoning_options : []
  const contextLimit =
    typeof entry.limit?.context === 'number' && Number.isFinite(entry.limit.context)
      ? entry.limit.context
      : undefined
  const hasVision =
    Array.isArray(entry.modalities?.input) &&
    entry.modalities.input.some((item) => item === 'image')

  return {
    entryId: hit,
    reasoning: entry.reasoning === true,
    reasoningOptions,
    contextLimit,
    hasVision,
  }
}

export interface ModelTag {
  kind: 'context' | 'vision'
  label: string
  tooltip: string
}

/**
 * 模型的特征小标签（复刻 OpenWorktree presets.ts 的 modelTags 规则）：
 * - context >= 1,000,000 标 1M（取整百万，1048576 → "1M"）
 * - 输入含图片标「视觉」
 */
export function modelTags(matched: MatchedModel | null): ModelTag[] {
  if (!matched) return []
  const tags: ModelTag[] = []
  if (matched.contextLimit && matched.contextLimit >= 1_000_000) {
    const millions = Math.floor(matched.contextLimit / 1_000_000)
    tags.push({
      kind: 'context',
      label: `${millions}M`,
      tooltip: `上下文达到 ${millions}M tokens`,
    })
  }
  if (matched.hasVision) {
    tags.push({
      kind: 'vision',
      label: '视觉',
      tooltip: '支持图片输入',
    })
  }
  return tags
}

export interface ReasoningCandidates {
  /** 该模型支持的档位（SDK 合法值子集；不含 'provider-default'——「自动」由值 'auto' 表达） */
  levels: ReasoningLevel[]
  /** 命中的目录条目 id（来源标注用） */
  sourceId: string
  /** 是否支持推理 */
  reasoning: boolean
}

/**
 * 一个模型能给的推理强度候选。
 *
 * 优先级：
 * 1. 用户自定义配置了 `reasoningLevels`（在 ProviderDialog 中单独配置），优先使用该档位列表；
 * 2. 线上目录匹配：`effort` 型求交，`toggle` 型给 none；
 * 3. 若用户明确配置了 `reasoning: true`（支持思考），但线上未匹配且未配置自定义档位：
 *    降级兜底提供通用三档 + 关闭（'low', 'medium', 'high', 'none'），避免用户面对空档位列表；
 * 4. 其余不支持推理情况 → null。
 */
export function reasoningCandidatesFor(
  modelId: string,
  entries: ModelCatalogEntries,
  customConfig?: CustomModelConfig,
): ReasoningCandidates | null {
  const isReasoningEnabled = customConfig?.reasoning ?? matchModel(modelId, entries)?.reasoning ?? false
  if (!isReasoningEnabled) return null

  const levels = new Set<ReasoningLevel>()

  // 1. 优先使用用户在单模型配置中填写的自定义档位
  if (customConfig?.reasoningLevels && customConfig.reasoningLevels.length > 0) {
    for (const val of customConfig.reasoningLevels) {
      const trimmed = val.trim()
      if (isValidReasoningLevel(trimmed)) {
        levels.add(trimmed)
      }
    }
  }

  // 2. 若未自定义档位，读取线上目录匹配信息
  const matched = matchModel(modelId, entries)
  if (levels.size === 0 && matched && matched.reasoning) {
    for (const option of matched.reasoningOptions) {
      if (!isRecord(option)) continue
      if (option.type === 'toggle') {
        levels.add('none')
        continue
      }
      if (option.type === 'effort' && Array.isArray(option.values)) {
        for (const value of option.values) {
          if (typeof value === 'string' && ALLOWED_SET.has(value) && value !== 'provider-default') {
            levels.add(value as ReasoningLevel)
          }
        }
      }
    }
    // 目录匹配成功但没声明任何档位：至少给「关闭」这一档（保持原有语义）
    if (levels.size === 0) levels.add('none')
  }

  // 3. 目录未匹配（matched 为空）且用户在本地开启了推理且没自定义档位：给出标准四档候选
  if (levels.size === 0 && isReasoningEnabled) {
    levels.add('low')
    levels.add('medium')
    levels.add('high')
    levels.add('none')
  }

  const sourceId = customConfig?.reasoningLevels && customConfig.reasoningLevels.length > 0
    ? `${modelId} (自定义)`
    : (matched?.entryId ?? modelId)

  const ordered = [...levels].sort(
    (a, b) => REASONING_LEVEL_ORDER.indexOf(a) - REASONING_LEVEL_ORDER.indexOf(b),
  )
  return { levels: ordered, sourceId, reasoning: true }
}

/**
 * 一个供应商的合并候选：已填模型的候选取并集（多模型同厂商时通常档位一致）。
 * 命中来源标注保留在 `sources` 里（key = 档位，value = 第一个声明它的模型 id）。
 */
export function unionReasoningCandidates(
  modelIds: string[],
  entries: ModelCatalogEntries,
  modelConfigs?: Record<string, CustomModelConfig>,
): { levels: ReasoningLevel[]; sources: Map<ReasoningLevel, string> } {
  const levels = new Set<ReasoningLevel>()
  const sources = new Map<ReasoningLevel, string>()
  for (const modelId of modelIds) {
    const candidates = reasoningCandidatesFor(modelId, entries, modelConfigs?.[modelId])
    if (!candidates) continue
    for (const level of candidates.levels) {
      levels.add(level)
      if (!sources.has(level)) sources.set(level, candidates.sourceId)
    }
  }
  const ordered = [...levels].sort(
    (a, b) => REASONING_LEVEL_ORDER.indexOf(a) - REASONING_LEVEL_ORDER.indexOf(b),
  )
  return { levels: ordered, sources }
}