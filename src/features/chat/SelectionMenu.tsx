import { Check, Copy, GitBranch, Loader2, MessageSquareQuote } from 'lucide-react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { toast } from 'sonner'
import { Tooltip } from '@/components/ui/tooltip'
import type { Id } from '@/domain/models'
import { cn, errorMessage } from '@/lib/utils'
import { useWorkspaceStore } from '@/stores/workspace-store'

interface SelectionTarget {
  text: string
  messageId: Id
  /** 选区最后一个行框的视口坐标（不是整个选区外接矩形，多行选区才不会飘到中间） */
  rect: { top: number; bottom: number; left: number; width: number }
}

interface MenuState extends SelectionTarget {
  left: number
  top: number
}

const GAP = 10
const EDGE = 12

/**
 * 「月牙盘」排布：三个圆形图标按钮沿一段圆弧铺开，中间一枚抬到弧顶、两侧沿弧线下沉，
 * 整体是一弯月牙。常量都在这里算，容器尺寸只用于定位与量尺寸。
 */
const BUTTON = 30
const ARC_RADIUS = 46
const ARC_SPREAD = 50
const ARC_WIDTH = Math.round(2 * (Math.sin((ARC_SPREAD * Math.PI) / 180) * ARC_RADIUS + BUTTON / 2))
const ARC_HEIGHT = Math.round(ARC_RADIUS * (1 - Math.cos((ARC_SPREAD * Math.PI) / 180)) + BUTTON)

/** 选区锚点所在的消息气泡 id；落在输入框、画布等非消息区域时返回 null（不弹菜单）。 */
function ownerMessageId(node: globalThis.Node | null): Id | null {
  const element = node instanceof Element ? node : (node?.parentElement ?? null)
  return element?.closest('[data-message-id]')?.getAttribute('data-message-id') ?? null
}

function readSelection(): SelectionTarget | null {
  const selection = window.getSelection()
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null

  const text = selection.toString().trim()
  if (!text) return null

  const range = selection.getRangeAt(0)
  const messageId = ownerMessageId(range.startContainer)
  if (!messageId) return null

  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 && rect.height > 0,
  )
  const rect = rects.at(-1) ?? range.getBoundingClientRect()
  if (rect.width === 0 && rect.height === 0) return null

  return {
    text,
    messageId,
    rect: { top: rect.top, bottom: rect.bottom, left: rect.left, width: rect.width },
  }
}

function ArcAction({
  icon,
  label,
  angle,
  busy,
  onSelect,
}: {
  icon: ReactNode
  label: string
  /** 相对中轴的夹角（度），负左正右；三个圆盘沿弧线铺开成一弯月牙 */
  angle: number
  busy?: boolean
  onSelect: () => void
}) {
  const radians = (angle * Math.PI) / 180
  return (
    <Tooltip label={label}>
      <button
        type="button"
        aria-label={label}
        disabled={busy}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSelect}
        style={{
          width: BUTTON,
          height: BUTTON,
          left: Math.round(ARC_WIDTH / 2 + Math.sin(radians) * ARC_RADIUS - BUTTON / 2),
          top: Math.round(ARC_RADIUS - Math.cos(radians) * ARC_RADIUS),
        }}
        className="absolute grid place-items-center rounded-full border border-line/80 bg-surface/95 text-ink-soft shadow-node ring-1 ring-white/[0.04] backdrop-blur transition-colors hover:border-accent/40 hover:bg-elevated hover:text-accent disabled:opacity-60"
      >
        {icon}
      </button>
    </Tooltip>
  )
}

/**
 * 消息正文框选后的悬浮菜单（月牙盘）：三个圆形图标按钮 —— 新建子分支节点 / 引用到对话 / 复制。
 *
 * 菜单常驻挂载（隐藏态）而不是按需挂载 —— 位置要按自身实际宽高算，先量再定位，
 * 才能在视口边缘正确避让；量尺寸必须在事件里做（不能在 render/effect 里读 DOM）。
 * 父组件用 `key={nodeId}` 重挂载，切换节点时状态自然归零。
 */
export function SelectionMenu({
  nodeId,
  onQuote,
}: {
  nodeId: Id
  onQuote: (text: string) => void
}) {
  const applyAction = useWorkspaceStore((state) => state.applyAction)
  const sendMessage = useWorkspaceStore((state) => state.sendMessage)

  const menuRef = useRef<HTMLDivElement>(null)
  const copiedTimer = useRef<number | null>(null)
  const [menu, setMenu] = useState<MenuState | null>(null)
  const [busy, setBusy] = useState(false)
  const [copied, setCopied] = useState(false)

  useEffect(() => {
    const place = () => {
      const element = menuRef.current
      const target = readSelection()
      // 选区滚出视口（例如切换节点后重排）就别再弹了，菜单是贴着文字出现的
      const onScreen =
        target !== null && target.rect.bottom > 0 && target.rect.top < window.innerHeight
      if (!target || !element || !onScreen) {
        setMenu(null)
        return
      }

      const width = element.offsetWidth
      const height = element.offsetHeight
      const above = target.rect.top - GAP - height
      const center = target.rect.left + target.rect.width / 2

      setMenu({
        ...target,
        top: above >= EDGE ? above : target.rect.bottom + GAP,
        left: Math.min(
          Math.max(center, EDGE + width / 2),
          window.innerWidth - EDGE - width / 2,
        ),
      })
    }

    const dismiss = () => setMenu(null)

    const handleMouseUp = (event: MouseEvent) => {
      // 点在菜单自己身上不算「重新选区」，否则按钮的 mousedown 会先把菜单关掉
      if (menuRef.current?.contains(event.target as globalThis.Node)) return
      place()
    }

    const handleSelectionChange = () => {
      const selection = window.getSelection()
      if (!selection || selection.isCollapsed) setMenu(null)
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setMenu(null)
    }

    document.addEventListener('mouseup', handleMouseUp)
    document.addEventListener('keyup', place)
    document.addEventListener('selectionchange', handleSelectionChange)
    document.addEventListener('keydown', handleKeyDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)

    return () => {
      document.removeEventListener('mouseup', handleMouseUp)
      document.removeEventListener('keyup', place)
      document.removeEventListener('selectionchange', handleSelectionChange)
      document.removeEventListener('keydown', handleKeyDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
    }
  }, [])

  const createBranch = async () => {
    if (!menu || busy) return
    setBusy(true)
    try {
      // 分支节点：落在当前节点下方，并从选中文字所在的那条消息处继承上下文
      const node = await applyAction('branch', nodeId, menu.messageId)
      if (!node) throw new Error('未能创建节点')
      setMenu(null)
      await sendMessage(node.id, [{ type: 'text', text: menu.text }])
    } catch (error) {
      toast.error(`新建分支失败：${errorMessage(error)}`)
    } finally {
      setBusy(false)
    }
  }

  const quoteToComposer = () => {
    if (!menu) return
    onQuote(menu.text)
    // 交棒给输入框：清掉页面选区，否则接下来打字时菜单会被 keyup 重新唤起
    window.getSelection()?.removeAllRanges()
    setMenu(null)
  }

  const copy = async () => {
    if (!menu) return
    try {
      await navigator.clipboard.writeText(menu.text)
      setCopied(true)
      if (copiedTimer.current !== null) window.clearTimeout(copiedTimer.current)
      copiedTimer.current = window.setTimeout(() => setCopied(false), 1400)
    } catch {
      toast.error('复制失败，请手动复制')
    }
  }

  return (
    <div
      // 隐藏态常驻用于量尺寸；key 变化让每次弹出重放 pop-in 动画
      key={menu ? 'open' : 'idle'}
      ref={menuRef}
      style={{ width: ARC_WIDTH, height: ARC_HEIGHT, ...(menu ? { left: menu.left, top: menu.top } : {}) }}
      onMouseDown={(event) => event.preventDefault()}
      className={cn('menu-pop fixed z-50 -translate-x-1/2', menu ? '' : 'invisible pointer-events-none')}
    >
      <ArcAction
        angle={-ARC_SPREAD}
        icon={
          busy ? (
            <Loader2 className="h-4 w-4 animate-spin text-accent" />
          ) : (
            <GitBranch className="h-4 w-4" />
          )
        }
        label="新建子分支节点"
        busy={busy}
        onSelect={() => void createBranch()}
      />
      <ArcAction
        angle={0}
        icon={<MessageSquareQuote className="h-4 w-4" />}
        label="引用到对话"
        onSelect={quoteToComposer}
      />
      <ArcAction
        angle={ARC_SPREAD}
        icon={
          copied ? <Check className="h-4 w-4 text-success" /> : <Copy className="h-4 w-4" />
        }
        label={copied ? '已复制' : '复制'}
        onSelect={() => void copy()}
      />
    </div>
  )
}
