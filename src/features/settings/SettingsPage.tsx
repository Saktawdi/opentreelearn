import { Database, KeyRound, Loader2, Plus, Sparkles, Trash2, UserRound, Zap } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import type { ModelRef, ProviderConfig } from '@/domain/models'
import { errorMessage } from '@/lib/utils'
import {
  PROVIDER_KIND_LABEL,
  describeModelRef,
  describeProviderModels,
} from '@/services/llm/catalog'
import { testProviderConnection } from '@/services/llm/providers'
import { useSettingsStore, type ModelSlot } from '@/stores/settings-store'
import { ModelPicker } from './ModelPicker'
import { ProviderDialog } from './ProviderDialog'

const MODEL_SLOTS: { slot: ModelSlot; label: string; hint: string }[] = [
  {
    slot: 'defaultChatModelRef',
    label: '对话模型',
    hint: '节点里一问一答使用的主模型。',
  },
  {
    slot: 'titleModelRef',
    label: '标题模型',
    hint: '用第一轮提问生成节点标题；留空则直接用提问原文当标题。',
  },
  {
    slot: 'summaryModelRef',
    label: '摘要模型',
    hint: '对话后生成节点摘要，也用于长上下文压缩；留空则不自动摘要。',
  },
]

function Section({
  icon,
  title,
  description,
  children,
}: {
  icon: ReactNode
  title: string
  description: string
  children: ReactNode
}) {
  return (
    <section className="rounded-2xl border border-line bg-surface p-5">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-line bg-elevated text-accent">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="text-[14.5px] font-medium text-ink">{title}</h2>
          <p className="mt-1 text-[12.5px] leading-relaxed text-muted">{description}</p>
        </div>
      </div>
      <div className="mt-4">{children}</div>
    </section>
  )
}

function maskKey(key: string): string {
  if (!key) return '未填写'
  if (key.length <= 10) return `${key.slice(0, 2)}····`
  return `${key.slice(0, 5)}····${key.slice(-4)}`
}

export function SettingsPage() {
  const settings = useSettingsStore((state) => state.settings)
  const patch = useSettingsStore((state) => state.patch)
  const setModelRef = useSettingsStore((state) => state.setModelRef)
  const removeProvider = useSettingsStore((state) => state.removeProvider)

  const [profile, setProfile] = useState(() => settings.backgroundProfile)
  const [budget, setBudget] = useState(() => String(settings.contextBudget))
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<ProviderConfig | null>(null)
  const [testingId, setTestingId] = useState<string | null>(null)

  const profileDirty =
    profile !== settings.backgroundProfile || budget !== String(settings.contextBudget)

  const saveProfile = async () => {
    const parsed = Number.parseInt(budget, 10)
    await patch({
      backgroundProfile: profile,
      contextBudget: Number.isFinite(parsed)
        ? Math.min(Math.max(parsed, 2000), 200_000)
        : settings.contextBudget,
    })
    toast.success('已保存')
  }

  const testProvider = async (provider: ProviderConfig) => {
    setTestingId(provider.id)
    try {
      await testProviderConnection(provider, provider.models[0])
      toast.success(`${provider.label} 连接正常`)
    } catch (error) {
      toast.error(`连接失败：${errorMessage(error)}`)
    } finally {
      setTestingId(null)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl space-y-5 px-6 py-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">配置</h1>
          <p className="mt-1 text-[13px] text-muted">
            全部数据与密钥仅保存在这台设备的浏览器里，登录云同步属于后续迭代。
          </p>
        </div>

        <Section
          icon={<UserRound className="h-4 w-4" />}
          title="个人背景"
          description="每次新开空白节点时都会注入这段上下文，让 AI 知道你是谁、在什么水平线上回答问题。"
        >
          <Textarea
            value={profile}
            rows={5}
            onChange={(event) => setProfile(event.target.value)}
            placeholder="例如：计算机专业大三学生，正在准备考研数学；希望解释尽量给推导和反例，不要跳过中间步骤。"
          />

          <div className="mt-4 flex flex-wrap items-end justify-between gap-3">
            <label className="block">
              <span className="mb-1.5 block text-[13px] font-medium text-ink-soft">
                上下文预算（tokens）
              </span>
              <Input
                value={budget}
                inputMode="numeric"
                onChange={(event) => setBudget(event.target.value)}
                className="w-[160px] font-mono text-[12.5px]"
              />
              <span className="mt-1 block text-[11.5px] text-muted">
                超出后自动压缩更早的父链对话。
              </span>
            </label>

            <Button variant="primary" onClick={() => void saveProfile()} disabled={!profileDirty}>
              保存
            </Button>
          </div>
        </Section>

        <Section
          icon={<Sparkles className="h-4 w-4" />}
          title="模型分配"
          description="分别指定负责对话、生成标题、生成摘要的模型；未指定标题/摘要模型时不会产生额外调用。"
        >
          <div className="space-y-3">
            {MODEL_SLOTS.map(({ slot, label, hint }) => (
              <div
                key={slot}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line/70 bg-canvas/40 px-3.5 py-3"
              >
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-ink-soft">{label}</p>
                  <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted">{hint}</p>
                </div>
                <ModelPicker
                  value={settings[slot] as ModelRef | null}
                  onChange={(ref) => void setModelRef(slot, ref)}
                  className="border border-line"
                />
              </div>
            ))}
          </div>
        </Section>

        <Section
          icon={<KeyRound className="h-4 w-4" />}
          title="BYOK 提供商"
          description="支持 OpenAI 兼容协议（DeepSeek、Moonshot、通义、OpenRouter、本地推理等）、OpenAI、Anthropic、Google Gemini。"
        >
          <div className="space-y-2.5">
            {settings.providers.length === 0 ? (
              <p className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-muted">
                还没有提供商。添加一个，填好 API Key 与模型 ID 即可开始对话。
              </p>
            ) : null}

            {settings.providers.map((provider) => (
              <div
                key={provider.id}
                className="flex flex-wrap items-center gap-3 rounded-xl border border-line/70 bg-canvas/40 px-3.5 py-3"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[13px] font-medium text-ink">{provider.label}</span>
                    <Badge tone="neutral">{PROVIDER_KIND_LABEL[provider.kind]}</Badge>
                    <span className="font-mono text-[11px] text-muted">
                      {maskKey(provider.apiKey)}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-muted/80">
                    {describeProviderModels(provider)}
                  </p>
                </div>

                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-muted"
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
                    className="text-muted"
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
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              添加提供商
            </Button>
          </div>
        </Section>

        <Section
          icon={<Database className="h-4 w-4" />}
          title="数据存放"
          description="当前版本为纯本地模式：项目、节点、对话与图片都保存在浏览器 IndexedDB 中，清空浏览器数据会一并丢失。"
        >
          <p className="text-[12.5px] leading-relaxed text-muted">
            已选对话模型：
            <span className="ml-1 font-mono text-ink-soft">
              {describeModelRef(settings.providers, settings.defaultChatModelRef) ?? '未设置'}
            </span>
          </p>
        </Section>
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