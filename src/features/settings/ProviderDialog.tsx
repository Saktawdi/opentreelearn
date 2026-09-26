import { Check, Download, Eye, EyeOff, Loader2, Pencil, Sparkles, Trash2, Zap } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import type { CustomModelConfig, ProviderConfig, ProviderKind } from '@/domain/models'
import { newId } from '@/lib/id'
import { cn, errorMessage } from '@/lib/utils'
import {
  PROVIDER_KIND_BASE_URL,
  PROVIDER_KIND_HINT,
  PROVIDER_KIND_LABEL,
} from '@/services/llm/catalog'
import {
  loadModelCatalog,
  matchModel,
  modelTags,
  reasoningCandidatesFor,
  type CatalogSnapshot,
} from '@/services/llm/model-catalog'
import { fetchUpstreamModels, testProviderConnection } from '@/services/llm/providers'
import { useSettingsStore } from '@/stores/settings-store'

const KINDS: ProviderKind[] = ['openai-compatible', 'openai', 'anthropic', 'google']

function createDraft(provider?: ProviderConfig | null): ProviderConfig {
  return (
    provider ?? {
      id: newId(),
      label: '',
      kind: 'openai-compatible',
      apiKey: '',
      baseURL: '',
      models: [],
    }
  )
}

export function ProviderDialog({
  open,
  onOpenChange,
  provider,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  provider?: ProviderConfig | null
}) {
  const { t } = useTranslation('settings')
  const addProvider = useSettingsStore((state) => state.addProvider)
  const updateProvider = useSettingsStore((state) => state.updateProvider)

  const [draft, setDraft] = useState<ProviderConfig>(() => createDraft(provider))
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null)
  const [matching, setMatching] = useState(false)
  const [matchSummary, setMatchSummary] = useState<string | null>(null)
  const [newModelInput, setNewModelInput] = useState('')

  // 上游模型探测列表（OpenWorktree 风格的 checkbox 候选流）
  const [fetchingUpstream, setFetchingUpstream] = useState(false)
  const [upstreamModels, setUpstreamModels] = useState<string[] | null>(null)

  useEffect(() => {
    let alive = true
    void loadModelCatalog().then((snapshot) => {
      if (!alive) return
      setCatalog(snapshot)
    })
    return () => {
      alive = false
    }
  }, [])

  const patch = (values: Partial<ProviderConfig>) => {
    setDraft((previous) => ({ ...previous, ...values }))
  }

  // 当前正在展开单独编辑的模型 ID（复刻 OpenWorktree 的 ModelEditor 交互）
  const [editingModelId, setEditingModelId] = useState<string | null>(null)

  // 预先匹配全部已填模型：提取命中的元数据与标签，并融合用户手改的 custom 配置
  const matchedEntries = useMemo(() => {
    const entries = catalog?.entries ?? {}
    return draft.models.map((modelId) => {
      const online = matchModel(modelId, entries)
      const custom = draft.modelConfigs?.[modelId]
      const onlineCandidates = online ? reasoningCandidatesFor(modelId, entries) : null
      // 融合规则：线上有的字段保留，用户手改的优先覆盖
      const merged = {
        entryId: online?.entryId ?? modelId,
        reasoning: custom?.reasoning ?? online?.reasoning ?? false,
        reasoningOptions: online?.reasoningOptions ?? [],
        // 若用户未手动覆盖，则回填线上匹配出来的档位列表
        reasoningLevels: custom?.reasoningLevels ?? onlineCandidates?.levels,
        contextLimit: custom?.contextLimit ?? online?.contextLimit,
        hasVision: custom?.hasVision ?? online?.hasVision,
      }
      const tags = modelTags(merged)
      return { modelId, matched: online, merged, tags, custom }
    })
  }, [draft.models, catalog, draft.modelConfigs])

  const patchModelConfig = (modelId: string, patchObj: Partial<CustomModelConfig>) => {
    const existing = draft.modelConfigs?.[modelId] ?? {}
    const next = { ...existing, ...patchObj }
    patch({
      modelConfigs: {
        ...(draft.modelConfigs ?? {}),
        [modelId]: next,
      },
    })
  }

  const runMatch = async () => {
    if (draft.models.length === 0) {
      toast.error(t('dialog.matchNeedsModel'))
      return
    }
    setMatching(true)
    // 强制从线上拉取最新 models.dev 目录，绕过本地 10 分钟缓存
    const freshCatalog = await loadModelCatalog({ forceRefresh: true })
    setCatalog(freshCatalog)
    const entries = freshCatalog.entries
    let hitCount = 0
    for (const modelId of draft.models) {
      if (matchModel(modelId, entries)) hitCount += 1
    }
    setMatching(false)
    const summary =
      hitCount === draft.models.length
        ? t('dialog.matchAll', { count: hitCount })
        : hitCount > 0
          ? t('dialog.matchPartial', { count: hitCount, total: draft.models.length })
          : t('dialog.matchNone')
    setMatchSummary(summary)
    toast.success(summary)
  }

  // 拉取真实上游模型列表（调用 /models 接口）
  const fetchModels = async () => {
    setFetchingUpstream(true)
    try {
      const fetched = await fetchUpstreamModels(draft)
      if (fetched.length === 0) {
        toast.info(t('dialog.fetchEmpty'))
      } else {
        toast.success(t('dialog.fetchOk', { count: fetched.length }))
      }
      setUpstreamModels(fetched)
    } catch (error) {
      toast.error(t('dialog.fetchFailed', { error: errorMessage(error) }))
    } finally {
      setFetchingUpstream(false)
    }
  }

  // 单个模型勾选/反选
  const toggleUpstreamModel = (modelId: string) => {
    const exists = draft.models.includes(modelId)
    if (exists) {
      patch({ models: draft.models.filter((id) => id !== modelId) })
    } else {
      patch({ models: [...draft.models, modelId] })
    }
  }

  // 全选上游模型（增量追加）
  const selectAllUpstream = () => {
    if (!upstreamModels || upstreamModels.length === 0) return
    const have = new Set(draft.models)
    const added = upstreamModels.filter((id) => !have.has(id))
    patch({ models: [...draft.models, ...added] })
    toast.success(t('dialog.addAllOk', { count: upstreamModels.length }))
  }

  // 当输入框有内容且存在上游拉取的模型列表时，计算联想候选词
  const suggestions = useMemo(() => {
    const q = newModelInput.trim().toLowerCase()
    if (!q || !upstreamModels || upstreamModels.length === 0) return []
    return upstreamModels
      .filter((id) => id.toLowerCase().includes(q))
      .slice(0, 10) // 最多展示 10 条联想结果，避免遮挡
  }, [newModelInput, upstreamModels])

  const addSpecificModel = (modelId: string) => {
    const clean = modelId.trim()
    if (!clean) return
    if (!draft.models.includes(clean)) {
      patch({ models: [...draft.models, clean] })
    }
    setNewModelInput('')
  }

  const addModel = () => {
    const parts = newModelInput
      .split(/[,，\s]+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length === 0) return

    const next = [...draft.models]
    for (const part of parts) {
      if (!next.includes(part)) next.push(part)
    }
    patch({ models: next })
    setNewModelInput('')
  }

  const removeModel = (target: string) => {
    patch({ models: draft.models.filter((item) => item !== target) })
  }

  const canSave = draft.label.trim().length > 0 && draft.models.length > 0

  const test = async () => {
    if (!draft.apiKey.trim() || draft.models.length === 0) {
      toast.error(t('dialog.testNeedsKey'))
      return
    }
    setTesting(true)
    try {
      const probe = await testProviderConnection(draft, draft.models[0])
      // 探测结论写回草稿，保存时一并落库 —— 运行时据此决定带不带工具
      patch({ capabilities: { tools: probe.tools } })
      toast.success(
        probe.tools
          ? t('dialog.testOkTools', { model: draft.models[0] })
          : t('dialog.testOkNoTools', { model: draft.models[0] }),
      )
    } catch (error) {
      toast.error(t('dialog.testFailed', { error: errorMessage(error) }))
    } finally {
      setTesting(false)
    }
  }

  const save = async () => {
    const payload: ProviderConfig = {
      ...draft,
      label: draft.label.trim(),
      apiKey: draft.apiKey.trim(),
      baseURL: draft.baseURL?.trim() || undefined,
      models: draft.models.map((model) => model.trim()).filter(Boolean),
      // 'auto' = 不落库（与缺省等价）：跟「跟随厂商默认」的语义一致，避免存噪音
      reasoningEffort:
        draft.reasoningEffort && draft.reasoningEffort !== 'auto'
          ? draft.reasoningEffort.trim()
          : undefined,
    }

    if (provider) {
      await updateProvider(provider.id, payload)
    } else {
      await addProvider(payload)
    }
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[min(580px,100%)]">
        <DialogHeader>
          <DialogTitle>{provider ? t('dialog.editTitle') : t('dialog.addTitle')}</DialogTitle>
          <DialogDescription>{t('dialog.keyNote')}</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <DialogField label={t('dialog.kindLabel')}>
            <div className="flex flex-wrap gap-1.5">
              {KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  onClick={() =>
                    patch({
                      kind,
                      baseURL: draft.baseURL?.trim() ? draft.baseURL : PROVIDER_KIND_BASE_URL[kind],
                    })
                  }
                  className={cn(
                    'rounded-md border px-2.5 py-1 text-left text-sm transition-colors',
                    draft.kind === kind
                      ? 'border-accent/45 bg-accent-soft text-accent'
                      : 'border-line text-muted hover:border-line-strong hover:text-ink-soft',
                  )}
                >
                  {PROVIDER_KIND_LABEL[kind]}
                </button>
              ))}
            </div>
            <p className="mt-1 text-xs text-muted">{PROVIDER_KIND_HINT[draft.kind]}</p>
          </DialogField>

          <div className="grid gap-4 sm:grid-cols-2">
            <DialogField label={t('dialog.nameLabel')}>
              <Input
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
                placeholder={t('dialog.namePlaceholder')}
              />
            </DialogField>

            <DialogField label="API Key">
              <div className="relative">
                <Input
                  type={showKey ? 'text' : 'password'}
                  value={draft.apiKey}
                  onChange={(event) => patch({ apiKey: event.target.value })}
                  placeholder="sk-..."
                  className="pr-9 font-mono text-xs"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((value) => !value)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-muted transition-colors hover:text-ink"
                >
                  {showKey ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                </button>
              </div>
            </DialogField>
          </div>

          <DialogField
            label="Base URL"
            hint={t('dialog.baseUrlHint')}
          >
            <Input
              value={draft.baseURL ?? ''}
              onChange={(event) => patch({ baseURL: event.target.value })}
              placeholder={PROVIDER_KIND_BASE_URL[draft.kind] || 'https://your-endpoint/v1'}
              className="font-mono text-xs"
            />
          </DialogField>

          {/* 模型管理：复刻 OpenWorktree 交互 —— 拉取模型与智能匹配并排 */}
          <DialogField
            label={t('dialog.modelsLabel')}
            hint={t('dialog.modelsHint')}
          >
            <div className="space-y-2">
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    value={newModelInput}
                    onChange={(event) => setNewModelInput(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        // 如果有第一条联想词且完全匹配/敲回车，优先选中联想词
                        if (suggestions.length > 0) {
                          addSpecificModel(suggestions[0])
                        } else {
                          addModel()
                        }
                      }
                    }}
                    placeholder={t('dialog.modelInputPlaceholder')}
                    className="font-mono text-xs"
                  />

                  {/* 联想词浮层：输入时实时过滤上游拉取到的模型 */}
                  {suggestions.length > 0 ? (
                    <div className="absolute left-0 top-full z-50 mt-1 max-h-[180px] w-full overflow-y-auto rounded-md border border-line bg-canvas p-1 shadow-md">
                      <div className="px-2 py-1 text-2xs text-muted">
                        {t('dialog.suggestionsHeader', { count: suggestions.length })}
                      </div>
                      {suggestions.map((suggestion) => {
                        const alreadyAdded = draft.models.includes(suggestion)
                        return (
                          <button
                            key={suggestion}
                            type="button"
                            onClick={() => addSpecificModel(suggestion)}
                            className={cn(
                              'flex w-full items-center justify-between rounded px-2 py-1 text-left font-mono text-2xs transition-colors',
                              alreadyAdded
                                ? 'text-accent opacity-60'
                                : 'hover:bg-accent-soft/40 hover:text-accent text-ink-soft',
                            )}
                          >
                            <span className="truncate">{suggestion}</span>
                            {alreadyAdded ? (
                              <span className="shrink-0 text-2xs text-muted">{t('dialog.alreadyAdded')}</span>
                            ) : null}
                          </button>
                        )
                      })}
                    </div>
                  ) : null}
                </div>

                <Button variant="ghost" size="sm" onClick={addModel} disabled={!newModelInput.trim()}>
                  {t('dialog.addModel')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void fetchModels()}
                  disabled={fetchingUpstream || !draft.apiKey.trim()}
                  title={!draft.apiKey.trim() ? t('dialog.fetchNeedsKey') : t('dialog.fetchTitle')}
                  className="shrink-0 gap-1"
                >
                  {fetchingUpstream ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Download className="h-3.5 w-3.5" />
                  )}
                  {fetchingUpstream ? t('dialog.fetching') : t('dialog.fetchModels')}
                </Button>
                <Button
                  variant="subtle"
                  size="sm"
                  onClick={runMatch}
                  disabled={matching || draft.models.length === 0}
                  className="shrink-0 gap-1 text-accent"
                >
                  {matching ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  ) : (
                    <Sparkles className="h-3.5 w-3.5" />
                  )}
                  {matching ? t('dialog.matching') : t('dialog.smartMatch')}
                </Button>
              </div>

              {matchSummary ? (
                <p className="text-2xs text-accent">✦ {matchSummary}</p>
              ) : null}

              {/* OpenWorktree 风格：上游探测到的模型多选流（折叠候选列表） */}
              {upstreamModels !== null ? (
                <div className="rounded-lg border border-accent/30 bg-accent-soft/20 p-2.5 space-y-2">
                  <div className="flex items-center justify-between text-xs">
                    <span className="font-medium text-ink-soft">
                      {t('dialog.upstreamFound', { count: upstreamModels.length })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={selectAllUpstream}
                      className="h-6 px-2 text-2xs text-accent"
                    >
                      {t('dialog.selectAll')}
                    </Button>
                  </div>
                  <div className="max-h-[160px] overflow-y-auto space-y-1 pr-1">
                    {upstreamModels.map((upstreamId) => {
                      const selected = draft.models.includes(upstreamId)
                      return (
                        <button
                          key={upstreamId}
                          type="button"
                          onClick={() => toggleUpstreamModel(upstreamId)}
                          className={cn(
                            'flex w-full items-center justify-between rounded px-2 py-1 text-left text-xs transition-colors',
                            selected
                              ? 'bg-accent/15 text-accent font-medium'
                              : 'hover:bg-canvas/60 text-muted hover:text-ink',
                          )}
                        >
                          <span className="font-mono text-2xs truncate">{upstreamId}</span>
                          {selected ? <Check className="h-3 w-3 shrink-0 text-accent" /> : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ) : null}

              {matchedEntries.length > 0 ? (
                <div className="max-h-[300px] space-y-1.5 overflow-y-auto rounded-md border border-line bg-canvas/40 p-2">
                  {matchedEntries.map(({ modelId, matched, merged, tags }) => {
                    const sourceText = matched
                      ? t('dialog.matchedFrom', { entry: matched.entryId })
                      : t('dialog.notInCatalog')
                    const isEditing = editingModelId === modelId
                    return (
                      <div
                        key={modelId}
                        className="rounded-md border border-line bg-canvas/80 px-2.5 py-1.5 transition-colors"
                      >
                        <div className="flex items-center gap-2">
                          <span
                            className="min-w-0 truncate font-mono text-xs text-ink"
                            title={sourceText}
                          >
                            {modelId}
                          </span>

                          {/* OpenWorktree 风格小标签：1M / 视觉 / 思考 */}
                          <div className="flex shrink-0 items-center gap-1">
                            {tags.map((tag) => (
                              <Badge
                                key={tag.kind}
                                tone={tag.kind === 'vision' ? 'accent' : 'neutral'}
                                className="text-2xs"
                                title={tag.tooltip}
                              >
                                {tag.label}
                              </Badge>
                            ))}
                            {merged.reasoning ? (
                              <Badge
                                tone="accent"
                                className="text-2xs"
                                title={
                                  merged.reasoningLevels && merged.reasoningLevels.length > 0
                                    ? t('dialog.reasoningBadgeCustom', {
                                        levels: merged.reasoningLevels.join(', '),
                                      })
                                    : t('dialog.reasoningBadge')
                                }
                              >
                                {t('dialog.thinkingBadge')}
                              </Badge>
                            ) : null}
                          </div>

                          <div className="flex-1" />

                          {/* 单独编辑按钮（复刻 OpenWorktree ModelEditor 交互） */}
                          <button
                            type="button"
                            onClick={() => setEditingModelId(isEditing ? null : modelId)}
                            className={cn(
                              'rounded p-1 transition-colors',
                              isEditing
                                ? 'bg-accent/15 text-accent'
                                : 'text-muted hover:text-ink',
                            )}
                            title={isEditing ? t('dialog.collapseEditor') : t('dialog.editModel')}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </button>

                          <button
                            type="button"
                            onClick={() => removeModel(modelId)}
                            className="rounded p-1 text-muted transition-colors hover:text-danger"
                            title={t('dialog.deleteModel')}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {/* 内联展开的单模型编辑器 (ModelEditor) */}
                        {isEditing ? (
                          <div className="mt-2 space-y-2.5 border-t border-line/60 pt-2.5">
                            <div className="flex flex-wrap items-center justify-between gap-2 text-2xs text-muted">
                              <span>{t('dialog.capabilitiesHeader')}</span>
                              {matched ? (
                                <span className="font-mono text-faint">
                                  {t('dialog.basedOn', { entry: matched.entryId })}
                                </span>
                              ) : (
                                <span className="text-warn">{t('dialog.fullManual')}</span>
                              )}
                            </div>

                            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                              <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                                <Switch
                                  checked={merged.reasoning}
                                  onCheckedChange={(checked) =>
                                    patchModelConfig(modelId, { reasoning: checked })
                                  }
                                />
                                <span>{t('dialog.reasoningSwitch')}</span>
                              </label>

                              <label className="flex items-center gap-2 text-xs text-ink-soft cursor-pointer">
                                <Switch
                                  checked={merged.hasVision ?? false}
                                  onCheckedChange={(checked) =>
                                    patchModelConfig(modelId, { hasVision: checked })
                                  }
                                />
                                <span>{t('dialog.visionSwitch')}</span>
                              </label>

                              <div className="flex items-center gap-1.5">
                                <span className="text-2xs text-muted shrink-0">{t('dialog.contextLabel')}</span>
                                <Input
                                  value={
                                    merged.contextLimit ? String(merged.contextLimit) : ''
                                  }
                                  placeholder={t('dialog.contextPlaceholder')}
                                  className="h-6 font-mono text-2xs"
                                  onChange={(e) => {
                                    const val = Number.parseInt(e.target.value, 10)
                                    patchModelConfig(modelId, {
                                      contextLimit: Number.isFinite(val) ? val : undefined,
                                    })
                                  }}
                                />
                              </div>
                            </div>

                            {/* 开启思考后，可自定义配置推理档位 */}
                            {merged.reasoning ? (
                              <div className="rounded-md border border-line/50 bg-surface/50 p-2 text-2xs space-y-1.5">
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-ink-soft">
                                    {t('dialog.levelsHeader')}
                                  </span>
                                  <div className="flex items-center gap-1">
                                    <button
                                      type="button"
                                      className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-accent/40 hover:text-accent transition-colors"
                                      onClick={() =>
                                        patchModelConfig(modelId, {
                                          reasoningLevels: ['low', 'medium', 'high'],
                                        })
                                      }
                                      title={t('dialog.presetThreeTitle')}
                                    >
                                      {t('dialog.presetThree')}
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-accent/40 hover:text-accent transition-colors"
                                      onClick={() =>
                                        patchModelConfig(modelId, {
                                          reasoningLevels: ['low', 'medium', 'high', 'xhigh'],
                                        })
                                      }
                                      title={t('dialog.presetFourTitle')}
                                    >
                                      {t('dialog.presetFour')}
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-accent/40 hover:text-accent transition-colors"
                                      onClick={() =>
                                        patchModelConfig(modelId, {
                                          reasoningLevels: ['low', 'high'],
                                        })
                                      }
                                      title={t('dialog.presetTwoTitle')}
                                    >
                                      {t('dialog.presetTwo')}
                                    </button>
                                    <button
                                      type="button"
                                      className="rounded border border-line px-1.5 py-0.5 text-2xs text-muted hover:border-accent/40 hover:text-accent transition-colors"
                                      onClick={() =>
                                        patchModelConfig(modelId, {
                                          reasoningLevels: ['none'],
                                        })
                                      }
                                      title={t('dialog.presetToggleTitle')}
                                    >
                                      {t('dialog.presetToggle')}
                                    </button>
                                  </div>
                                </div>
                                <Input
                                  value={merged.reasoningLevels ? merged.reasoningLevels.join(', ') : ''}
                                  placeholder={t('dialog.levelsPlaceholder')}
                                  className="h-6 font-mono text-2xs"
                                  onChange={(e) => {
                                    const raw = e.target.value
                                    const parts = raw
                                      .split(',')
                                      .map((s) => s.trim())
                                      .filter(Boolean)
                                    patchModelConfig(modelId, {
                                      reasoningLevels: parts.length > 0 ? parts : undefined,
                                    })
                                  }}
                                />
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ) : (
                <p className="text-xs text-muted">{t('dialog.noModels')}</p>
              )}
            </div>
          </DialogField>
        </div>

        <DialogFooter className="justify-between">
          <Button variant="ghost" size="sm" onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            {t('dialog.testConnection')}
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
              {t('action.save')}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}