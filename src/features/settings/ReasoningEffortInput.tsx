import { Brain, Check, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'
import {
  isValidReasoningLevel,
  loadModelCatalog,
  REASONING_LEVEL_LABEL,
  type CatalogSnapshot,
  unionReasoningCandidates,
} from '@/services/llm/model-catalog'

/**
 * 推理强度控件：候选 + 自由输入。
 *
 * 数据源是 models.dev 模型目录（model-catalog）：用户填的模型 id 能匹配上目录条目
 * 时，候选 = 该模型自声明的 reasoning_options（每个模型支持的档位不一样）；
 * 匹配不到就退回纯自由输入 —— 目录只是增强，不是门槛。
 *
 * 交互：按钮显示当前值，点开是一个可输入的菜单 —— 顶部可直接键入任意档位
 * （合法档位随请求携带），下面列出「自动」与目录候选（带来源标注）。
 */

/** 整页多个实例（模型分配各行 + 对话页）共用一次目录拉取，避免并发重复请求。 */
let sharedCatalog: Promise<CatalogSnapshot> | null = null

function ensureCatalog(): Promise<CatalogSnapshot> {
  if (!sharedCatalog) {
    sharedCatalog = loadModelCatalog().catch(() => ({
      entries: {},
      fetchedAt: 0,
      ok: false,
      cached: false,
    }))
  }
  return sharedCatalog
}

function labelOf(value: string): string {
  if (!value || value === 'auto') return '自动'
  if (isValidReasoningLevel(value)) return REASONING_LEVEL_LABEL[value] ?? value
  return value
}

export function ReasoningEffortInput({
  value,
  onChange,
  models,
  className,
}: {
  /** 当前值：'auto'（跟随提供商）| 合法档位 | 自由输入文本 */
  value: string
  onChange: (value: string) => void
  /** 智能匹配用的模型 id 列表（provider.models 或当前对话所用的模型） */
  models: string[]
  className?: string
}) {
  const [catalog, setCatalog] = useState<CatalogSnapshot | null>(null)
  const [matching, setMatching] = useState(true)
  // 保持 draft 与 value 同步：记录上次看到的 value，变化时重置（纯渲染期派生，不写在 useEffect 里触发二次 render）
  const [prevValue, setPrevValue] = useState(value)
  const [draft, setDraft] = useState(value)
  if (value !== prevValue) {
    setPrevValue(value)
    setDraft(value)
  }

  useEffect(() => {
    let alive = true
    void ensureCatalog().then((snapshot) => {
      if (!alive) return
      setCatalog(snapshot)
      setMatching(false)
    })
    return () => {
      alive = false
    }
  }, [])

  const candidates = useMemo(
    () => unionReasoningCandidates(models, catalog?.entries ?? {}),
    [models, catalog],
  )

  const commit = (next: string) => {
    const trimmed = next.trim()
    onChange(trimmed || 'auto')
  }

  const current = value && value !== 'auto' ? value : null
  const matchedModels = models.filter((model) => model.trim()).length > 0

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            'max-w-[220px] justify-between gap-1.5 text-muted',
            current && isValidReasoningLevel(current) && 'text-ink',
            className,
          )}
        >
          <Brain className="h-3.5 w-3.5 shrink-0 opacity-70" />
          <span className="truncate text-xs">推理·{labelOf(value)}</span>
          <Check className="h-3 w-3 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-[280px]">
        <div className="px-2 pb-1 pt-1.5">
          <Input
            value={draft}
            placeholder="自动，或输入档位（low / high / xhigh…）"
            className="h-7 font-mono text-xs"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                commit(draft)
              }
            }}
            onChange={(event) => setDraft(event.target.value)}
          />
        </div>

        <DropdownMenuSeparator />

        <DropdownMenuItem onSelect={() => commit('auto')}>
          <span className="flex-1 text-xs">自动（跟随提供商默认）</span>
          {!value || value === 'auto' ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
        </DropdownMenuItem>

        {candidates.levels.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-2xs">该模型支持的档位</DropdownMenuLabel>
            {candidates.levels.map((level) => (
              <DropdownMenuItem key={level} onSelect={() => commit(level)}>
                <span className="flex-1 text-xs">{REASONING_LEVEL_LABEL[level] ?? level}</span>
                <span className="mr-2 max-w-[120px] truncate font-mono text-2xs text-faint">
                  {candidates.sources.get(level)}
                </span>
                {current === level ? <Check className="h-3.5 w-3.5 text-accent" /> : null}
              </DropdownMenuItem>
            ))}
          </>
        ) : null}

        {matching ? (
          <div className="flex items-center gap-1.5 px-2 py-2 text-xs text-muted">
            <Loader2 className="h-3 w-3 animate-spin" />
            正在匹配模型目录…
          </div>
        ) : !matchedModels ? (
          <div className="px-2 py-2 text-xs text-faint">还没有模型，先填模型 ID 再匹配</div>
        ) : candidates.levels.length === 0 ? (
          <div className="px-2 py-2 text-xs leading-relaxed text-faint">
            未在模型目录中识别到推理档位（或该模型不支持），可在上方自由输入
          </div>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}