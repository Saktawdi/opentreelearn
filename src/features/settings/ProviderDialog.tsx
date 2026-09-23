import { Eye, EyeOff, Loader2, Zap } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
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
import { TagInput } from '@/components/ui/tag-input'
import type { ProviderConfig, ProviderKind } from '@/domain/models'
import { newId } from '@/lib/id'
import { cn, errorMessage } from '@/lib/utils'
import {
  PROVIDER_KIND_BASE_URL,
  PROVIDER_KIND_HINT,
  PROVIDER_KIND_LABEL,
} from '@/services/llm/catalog'
import { testProviderConnection } from '@/services/llm/providers'
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
  const addProvider = useSettingsStore((state) => state.addProvider)
  const updateProvider = useSettingsStore((state) => state.updateProvider)

  const [draft, setDraft] = useState<ProviderConfig>(() => createDraft(provider))
  const [showKey, setShowKey] = useState(false)
  const [testing, setTesting] = useState(false)

  const patch = (values: Partial<ProviderConfig>) => {
    setDraft((previous) => ({ ...previous, ...values }))
  }

  const canSave = draft.label.trim().length > 0 && draft.models.length > 0

  const test = async () => {
    if (!draft.apiKey.trim() || draft.models.length === 0) {
      toast.error('先填写 API Key 与至少一个模型 ID')
      return
    }
    setTesting(true)
    try {
      const probe = await testProviderConnection(draft, draft.models[0])
      // 探测结论写回草稿，保存时一并落库 —— 运行时据此决定带不带工具
      patch({ capabilities: { tools: probe.tools } })
      toast.success(
        probe.tools
          ? `连接成功：${draft.models[0]} 已响应，支持工具调用`
          : `连接成功：${draft.models[0]} 已响应，但未探测到工具调用能力（对话将按无工具模式进行）`,
      )
    } catch (error) {
      toast.error(`连接失败：${errorMessage(error)}`)
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
          <DialogTitle>{provider ? '编辑提供商' : '添加提供商'}</DialogTitle>
          <DialogDescription>API Key 只保存在本机浏览器，不会上传。</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <DialogField label="协议类型">
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
            <DialogField label="名称">
              <Input
                value={draft.label}
                onChange={(event) => patch({ label: event.target.value })}
                placeholder="例如：DeepSeek"
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
            hint="留空使用官方默认地址；兼容协议可指向自建代理。"
          >
            <Input
              value={draft.baseURL ?? ''}
              onChange={(event) => patch({ baseURL: event.target.value })}
              placeholder={PROVIDER_KIND_BASE_URL[draft.kind] || 'https://your-endpoint/v1'}
              className="font-mono text-xs"
            />
          </DialogField>

          <DialogField label="模型 ID" hint="回车或逗号分隔。">
            <TagInput
              value={draft.models}
              onChange={(models) => patch({ models })}
              placeholder="deepseek-chat…"
            />
          </DialogField>
        </div>

        <DialogFooter className="justify-between">
          <Button variant="ghost" onClick={() => void test()} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
            测试连接
          </Button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" onClick={() => void save()} disabled={!canSave}>
              保存
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}