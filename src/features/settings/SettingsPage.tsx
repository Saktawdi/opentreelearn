import { Loader2, Plus, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import { Switch } from '@/components/ui/switch'
import type { BranchPromptPreference, ProviderConfig } from '@/domain/models'
import {
  BRANCH_QUICK_CHOICES,
  clampAgentMaxSteps,
  clampContextBudget,
  findBranchQuickChoice,
  MAX_AGENT_MAX_STEPS,
  MAX_CONTEXT_BUDGET,
  MIN_CONTEXT_BUDGET,
} from '@/domain/defaults'
import { cn, errorMessage } from '@/lib/utils'
import i18n from '@/i18n'
import { describeProviderModels, providerKindLabel } from '@/services/llm/catalog'
import { testProviderConnection } from '@/services/llm/providers'
import { useSettingsStore } from '@/stores/settings-store'
import { ModelPicker } from './ModelPicker'
import { ProviderDialog } from './ProviderDialog'
import { ReasoningEffortInput } from './ReasoningEffortInput'

// labelKey/hintKey 是 i18n 键：文案在渲染处用 t() 解析（当前语言），模块级常量只存键
const MODEL_SLOTS = [
  {
    slot: 'defaultChatModelRef',
    labelKey: 'slot.chat.label',
    hintKey: 'slot.chat.hint',
  },
  {
    slot: 'titleModelRef',
    labelKey: 'slot.title.label',
    hintKey: 'slot.title.hint',
  },
  {
    slot: 'summaryModelRef',
    labelKey: 'slot.summary.label',
    hintKey: 'slot.summary.hint',
  },
] as const

function maskKey(key: string): string {
  if (!key) return i18n.t('settings:providers.keyNotSet')
  if (key.length <= 10) return `${key.slice(0, 2)}····`
  return `${key.slice(0, 5)}····${key.slice(-4)}`
}

/** 预算这种大数字按 k 显示更好读：20000 → 20k，1000000 → 1M。 */
function formatBudget(value: number): string {
  if (value >= 1_000_000) return `${value / 1_000_000}M`
  if (value >= 1_000) return `${Math.round(value / 1_000)}k`
  return String(value)
}

export function SettingsPage() {
  // 快捷指令芯片的 label/hint 是跨 feature 词表（common）：数组形式让 t(`common:${...}`) 能过类型校验
  const { t } = useTranslation(['settings', 'common'])
  const settings = useSettingsStore((state) => state.settings)
  const patch = useSettingsStore((state) => state.patch)
  const setModelRef = useSettingsStore((state) => state.setModelRef)
  const removeProvider = useSettingsStore((state) => state.removeProvider)
  const updateProvider = useSettingsStore((state) => state.updateProvider)

  const [budget, setBudget] = useState(() => String(settings.contextBudget))
  const [maxSteps, setMaxSteps] = useState(() => String(settings.agentMaxSteps))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const budgetDirty = budget !== String(settings.contextBudget)
  const maxStepsDirty = maxSteps !== String(settings.agentMaxSteps)

  const branchPrompt = settings.branchPrompt
  const setBranchPrompt = (next: Partial<BranchPromptPreference>) =>
    void patch({ branchPrompt: { ...branchPrompt, ...next } })

  const saveBudget = async () => {
    const parsed = Number.parseInt(budget, 10)
    // 先把输入框回填成真正落库的值：超出区间时用户能立刻看见被夹到了哪，
    // 而不是「保存成功」之后输入框里还留着 10000000、下次刷新才变。
    const next = Number.isFinite(parsed)
      ? clampContextBudget(parsed)
      : settings.contextBudget
    setBudget(String(next))
    await patch({ contextBudget: next })
    toast.success(
      Number.isFinite(parsed) && parsed !== next
        ? t('toast.budgetClamped', {
            min: formatBudget(MIN_CONTEXT_BUDGET),
            max: formatBudget(MAX_CONTEXT_BUDGET),
            value: formatBudget(next),
          })
        : t('toast.saved'),
    )
  }

  const saveMaxSteps = async () => {
    const parsed = Number.parseInt(maxSteps, 10)
    // 与预算同一套「回填落库值」交互；非法输入回落到当前值而不是默认值
    const next = Number.isFinite(parsed) ? clampAgentMaxSteps(parsed) : settings.agentMaxSteps
    setMaxSteps(String(next))
    await patch({ agentMaxSteps: next })
    toast.success(
      Number.isFinite(parsed) && parsed !== next
        ? t('toast.stepsClamped', { max: MAX_AGENT_MAX_STEPS, value: next })
        : next === 0
          ? t('toast.stepsUnlimited')
          : t('toast.saved'),
    )
  }

  const testProvider = async (provider: ProviderConfig) => {
    setTestingId(provider.id)
    try {
      const probe = await testProviderConnection(provider, provider.models[0])
      // 探测结论跟着 provider 走（会随设置同步到云端），运行时据此决定带不带工具
      await updateProvider(provider.id, { capabilities: { tools: probe.tools } })
      toast.success(
        probe.tools
          ? t('toast.testOkTools', { label: provider.label })
          : t('toast.testOkNoTools', { label: provider.label }),
      )
    } catch (error) {
      toast.error(t('toast.testFailed', { error: errorMessage(error) }))
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 sm:px-6 py-5 sm:py-7 pb-safe">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('page.title')}</h1>
          <p className="mt-1 text-xs text-muted">{t('page.subtitle')}</p>
        </div>

        <Section title={t('section.context')}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block">
              <span className="mb-1.5 block text-sm text-ink-soft">{t('context.budgetLabel')}</span>
              <Input
                value={budget}
                inputMode="numeric"
                onChange={(event) => setBudget(event.target.value)}
                className="w-[150px] font-mono text-xs"
              />
              <span className="mt-1 block text-xs text-muted">
                {t('context.budgetHint', {
                  min: formatBudget(MIN_CONTEXT_BUDGET),
                  max: formatBudget(MAX_CONTEXT_BUDGET),
                })}
              </span>
            </label>

            <Button variant="primary" size="sm" onClick={() => void saveBudget()} disabled={!budgetDirty}>
              {t('action.save')}
            </Button>
          </div>
        </Section>

        <Section title={t('section.preferences')}>
          <div className="space-y-2">
            <LanguageSwitcher />

            <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
              <div className="min-w-0 max-w-lg">
                <p className="text-sm text-ink-soft">{t('prefs.dialogToggleTitle')}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted">
                  {branchPrompt.showDialog
                    ? t('prefs.dialogOn')
                    : t('prefs.dialogOff')}
                </p>
              </div>
              <Switch
                checked={branchPrompt.showDialog}
                onCheckedChange={(show) => {
                  if (show) {
                    setBranchPrompt({ showDialog: true })
                    return
                  }
                  // 关掉弹窗就得有一条能直发的指令：还没记住时先取第一个快捷意图兜底
                  setBranchPrompt({
                    showDialog: false,
                    rememberedPrompt: branchPrompt.rememberedPrompt ?? BRANCH_QUICK_CHOICES[0].prompt,
                  })
                }}
              />
            </div>

            <div className="rounded-md border border-line px-3 py-2.5">
              <p className="text-sm text-ink-soft">{t('prefs.rememberedTitle')}</p>
              <p className="mt-0.5 text-xs leading-relaxed text-muted">
                {t('prefs.rememberedHint')}
              </p>
              <div className="mt-2 flex flex-wrap gap-1.5">
                {BRANCH_QUICK_CHOICES.map((choice) => {
                  const active = branchPrompt.rememberedPrompt === choice.prompt
                  return (
                    <button
                      key={choice.id}
                      type="button"
                      title={t(`common:${choice.hintKey}`)}
                      onClick={() => setBranchPrompt({ rememberedPrompt: choice.prompt })}
                      className={cn(
                        'rounded-full border px-2.5 py-1 text-xs transition-colors',
                        active
                          ? 'border-accent/50 bg-accent-soft text-accent'
                          : 'border-line/70 bg-elevated/50 text-ink-soft hover:border-accent/40 hover:text-accent',
                      )}
                    >
                      {t(`common:${choice.labelKey}`)}
                    </button>
                  )
                })}
              </div>
              {branchPrompt.rememberedPrompt &&
              !findBranchQuickChoice(branchPrompt.rememberedPrompt) ? (
                <p className="mt-2 break-all text-xs text-muted">
                  {t('prefs.customPromptLabel')}
                  <span className="text-ink-soft">{branchPrompt.rememberedPrompt}</span>
                </p>
              ) : null}
            </div>
          </div>
        </Section>

        <Section title={t('section.agent')}>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block max-w-lg">
              <span className="mb-1.5 block text-sm text-ink-soft">{t('agent.maxStepsLabel')}</span>
              <Input
                value={maxSteps}
                inputMode="numeric"
                onChange={(event) => setMaxSteps(event.target.value)}
                className="w-[150px] font-mono text-xs"
              />
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                {t('agent.maxStepsHintA')}
                <strong className="font-semibold text-ink-soft">{t('agent.maxStepsHintEm')}</strong>
                {t('agent.maxStepsHintB')}
              </span>
            </label>

            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveMaxSteps()}
              disabled={!maxStepsDirty}
            >
              {t('action.save')}
            </Button>
          </div>
        </Section>

        <Section title={t('section.models')}>
          <div className="space-y-2">
            {MODEL_SLOTS.map(({ slot, labelKey, hintKey }) => {
              const ref = settings[slot]
              const isChatSlot = slot === 'defaultChatModelRef'
              // 只有对话模型允许配置推理强度；模型在前，推理强度在后
              const slotProvider =
                isChatSlot && ref
                  ? settings.providers.find((item) => item.id === ref.providerId) ?? null
                  : null
              return (
                <div
                  key={slot}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5"
                >
                  <div className="min-w-0">
                    <p className="text-sm text-ink-soft">{t(labelKey)}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{t(hintKey)}</p>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <ModelPicker
                      value={ref}
                      onChange={(nextRef) => void setModelRef(slot, nextRef)}
                    />
                    {slotProvider ? (
                      <ReasoningEffortInput
                        value={slotProvider.reasoningEffort ?? 'auto'}
                        onChange={(next) =>
                          void updateProvider(slotProvider.id, {
                            reasoningEffort: next === 'auto' ? undefined : next,
                          })
                        }
                        models={ref ? [ref.modelId] : slotProvider.models}
                        modelConfigs={slotProvider.modelConfigs}
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title={t('section.providers')}>
          <div className="space-y-2">
            {settings.providers.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-4 py-5 text-center text-xs text-muted">
                {t('providers.empty')}
              </p>
            ) : null}

            {settings.providers.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium text-ink">{provider.label}</span>
                    <Badge tone="neutral">{providerKindLabel(provider.kind)}</Badge>
                    <span className="font-mono text-2xs text-faint">
                      {maskKey(provider.apiKey)}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate font-mono text-2xs text-muted">
                    {describeProviderModels(provider)}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={testingId === provider.id}
                    onClick={() => void testProvider(provider)}
                  >
                    {testingId === provider.id ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Zap className="h-3.5 w-3.5" />
                    )}
                    {t('providers.test')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(provider)
                      setDialogOpen(true)
                    }}
                  >
                    {t('providers.edit')}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-muted hover:text-danger"
                    onClick={() => void removeProvider(provider.id)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-3.5 w-3.5" />
              {t('providers.add')}
            </Button>
          </div>
        </Section>

        <p className="border-t border-line pt-5 text-xs leading-relaxed text-muted">
          {t('page.storageNote')}
        </p>
      </div>

      <ProviderDialog
        key={`${editing?.id ?? 'new'}:${dialogOpen}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        provider={editing}
      />
    </div>
  )
}

/** 界面语言切换：i18n.changeLanguage 后 detector 会把选择持久化到 localStorage（ootl.lang）。 */
function LanguageSwitcher() {
  const { t, i18n } = useTranslation('settings')
  const current = i18n.language ?? ''
  const options = [
    { code: 'zh-CN', zh: true, label: t('language.zh') },
    { code: 'en', zh: false, label: t('language.en') },
  ] as const
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-line px-3 py-2.5">
      <div className="min-w-0 max-w-lg">
        <p className="text-sm text-ink-soft">{t('language.label')}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted">{t('language.hint')}</p>
      </div>
      <div role="group" aria-label={t('language.groupLabel')} className="flex gap-1.5">
        {options.map((option) => {
          const active = option.zh ? current.startsWith('zh') : current.startsWith('en')
          return (
            <button
              key={option.code}
              type="button"
              aria-pressed={active}
              onClick={() => void i18n.changeLanguage(option.code)}
              className={cn(
                'rounded-full border px-2.5 py-1 text-xs transition-colors',
                active
                  ? 'border-accent/50 bg-accent-soft text-accent'
                  : 'border-line/70 bg-elevated/50 text-ink-soft hover:border-accent/40 hover:text-accent',
              )}
            >
              {option.label}
            </button>
          )
        })}
      </div>
    </div>
  )
}
