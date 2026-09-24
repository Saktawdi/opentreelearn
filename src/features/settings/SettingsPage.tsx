import { Loader2, Plus, Trash2, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Section } from '@/components/ui/section'
import type { ProviderConfig } from '@/domain/models'
import {
  clampAgentMaxSteps,
  clampContextBudget,
  MAX_AGENT_MAX_STEPS,
  MAX_CONTEXT_BUDGET,
  MIN_CONTEXT_BUDGET,
} from '@/domain/defaults'
import { errorMessage } from '@/lib/utils'
import { PROVIDER_KIND_LABEL, describeProviderModels } from '@/services/llm/catalog'
import { testProviderConnection } from '@/services/llm/providers'
import { useSettingsStore, type ModelSlot } from '@/stores/settings-store'
import { ModelPicker } from './ModelPicker'
import { ProviderDialog } from './ProviderDialog'
import { ReasoningEffortInput } from './ReasoningEffortInput'

const MODEL_SLOTS: { slot: ModelSlot; label: string; hint: string }[] = [
  {
    slot: 'defaultChatModelRef',
    label: '对话模型',
    hint: '节点内一问一答使用。',
  },
  {
    slot: 'titleModelRef',
    label: '标题模型',
    hint: '留空则用提问原文当标题。',
  },
  {
    slot: 'summaryModelRef',
    label: '摘要模型',
    hint: '用于手动生成节点学习摘要；留空则该功能不可用。',
  },
]

function maskKey(key: string): string {
  if (!key) return '未填写'
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
        ? `已保存（超出 ${formatBudget(MIN_CONTEXT_BUDGET)}–${formatBudget(MAX_CONTEXT_BUDGET)}，按 ${formatBudget(next)} 保存）`
        : '已保存',
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
        ? `已保存（合法区间 0–${MAX_AGENT_MAX_STEPS}，按 ${next} 保存）`
        : next === 0
          ? '已保存：不限制步数，生成过程中可随时手动停止'
          : '已保存',
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
          ? `${provider.label} 连接正常，支持工具调用`
          : `${provider.label} 连接正常，但没有探测到工具调用能力：后续对话按无工具模式进行`,
      )
    } catch (error) {
      toast.error(`连接失败：${errorMessage(error)}`)
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-6 py-7">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">配置</h1>
          <p className="mt-1 text-xs text-muted">数据与密钥只保存在本机浏览器。</p>
        </div>

        <Section title="上下文">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block">
              <span className="mb-1.5 block text-sm text-ink-soft">上下文预算（tokens）</span>
              <Input
                value={budget}
                inputMode="numeric"
                onChange={(event) => setBudget(event.target.value)}
                className="w-[150px] font-mono text-xs"
              />
              <span className="mt-1 block text-xs text-muted">
                超出后自动压缩更早的父链对话。可填 {formatBudget(MIN_CONTEXT_BUDGET)}–
                {formatBudget(MAX_CONTEXT_BUDGET)}，超出部分会按边界保存。
              </span>
            </label>

            <Button variant="primary" size="sm" onClick={() => void saveBudget()} disabled={!budgetDirty}>
              保存
            </Button>
          </div>
        </Section>

        <Section title="智能体（Agent）">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <label className="block max-w-lg">
              <span className="mb-1.5 block text-sm text-ink-soft">工具调用步数上限</span>
              <Input
                value={maxSteps}
                inputMode="numeric"
                onChange={(event) => setMaxSteps(event.target.value)}
                className="w-[150px] font-mono text-xs"
              />
              <span className="mt-1 block text-xs leading-relaxed text-muted">
                一轮中模型调用工具的最大步数（一步 = 一次模型调用，含最终作答那一步）。默认 50；
                <strong className="font-semibold text-ink-soft">填 0 表示不限制</strong>
                （由模型自行决定何时完成，生成中可随时点击停止按钮中断）。
              </span>
            </label>

            <Button
              variant="primary"
              size="sm"
              onClick={() => void saveMaxSteps()}
              disabled={!maxStepsDirty}
            >
              保存
            </Button>
          </div>
        </Section>

        <Section title="模型分配">
          <div className="space-y-2">
            {MODEL_SLOTS.map(({ slot, label, hint }) => {
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
                    <p className="text-sm text-ink-soft">{label}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{hint}</p>
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
                      />
                    ) : null}
                  </div>
                </div>
              )
            })}
          </div>
        </Section>

        <Section title="BYOK 提供商">
          <div className="space-y-2">
            {settings.providers.length === 0 ? (
              <p className="rounded-md border border-dashed border-line px-4 py-5 text-center text-xs text-muted">
                还没有提供商。添加一个，填好 API Key 与模型 ID 即可开始对话。
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
                    <Badge tone="neutral">{PROVIDER_KIND_LABEL[provider.kind]}</Badge>
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
                    测试
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setEditing(provider)
                      setDialogOpen(true)
                    }}
                  >
                    编辑
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
              添加提供商
            </Button>
          </div>
        </Section>

        <p className="border-t border-line pt-5 text-xs leading-relaxed text-muted">
          项目、节点、对话与图片都存在浏览器 IndexedDB 里，清空浏览器数据会一并丢失。
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
