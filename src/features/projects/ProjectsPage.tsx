import {
  ArrowUpRight,
  Download,
  Loader2,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Trash2,
  Upload,
} from 'lucide-react'
import { motion } from 'motion/react'
import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import type { Project } from '@/domain/models'
import { formatRelativeTime } from '@/lib/time'
import { cn, errorMessage } from '@/lib/utils'
import { exportProjectAsTreeFile } from '@/services/export'
import { collectTags, useProjectsStore } from '@/stores/projects-store'
import { ProjectDialog } from './ProjectDialog'
import { useImportProject } from './useImportProject'

const ALL_TAGS = '__all__'

export function ProjectsPage() {
  const navigate = useNavigate()
  const projects = useProjectsStore((state) => state.projects)
  const removeProject = useProjectsStore((state) => state.remove)
  const { handleFile, importing } = useImportProject()

  const fileInputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery] = useState('')
  const [activeTag, setActiveTag] = useState<string>(ALL_TAGS)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editing, setEditing] = useState<Project | null>(null)
  const [deleting, setDeleting] = useState<Project | null>(null)
  const [exportingId, setExportingId] = useState<string | null>(null)
  const [draggingFile, setDraggingFile] = useState(false)

  const handleExport = async (project: Project) => {
    if (exportingId) return
    setExportingId(project.id)
    try {
      await exportProjectAsTreeFile(project)
      toast.success(`项目「${project.name}」已成功导出`)
    } catch (error) {
      toast.error(`导出失败：${errorMessage(error)}`)
    } finally {
      setExportingId(null)
    }
  }

  const tags = useMemo(() => collectTags(projects), [projects])

  const visible = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return projects.filter((project) => {
      if (activeTag !== ALL_TAGS && !project.tags.includes(activeTag)) return false
      if (!keyword) return true
      return (
        project.name.toLowerCase().includes(keyword) ||
        (project.description ?? '').toLowerCase().includes(keyword) ||
        project.tags.some((tag) => tag.toLowerCase().includes(keyword))
      )
    })
  }, [projects, query, activeTag])

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault()
        setDraggingFile(true)
      }}
      onDragLeave={() => setDraggingFile(false)}
      onDrop={(event) => {
        event.preventDefault()
        setDraggingFile(false)
        const file = event.dataTransfer.files?.[0]
        if (file) void handleFile(file)
      }}
      className="relative flex-1 overflow-y-auto"
    >
      {draggingFile ? (
        <div className="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-2xl border-2 border-dashed border-accent bg-canvas/85 p-8 text-center backdrop-blur-sm">
          <div>
            <Upload className="mx-auto h-8 w-8 text-accent" />
            <p className="mt-2 text-[14px] font-medium text-ink">松开以导入 .tree 项目</p>
            <p className="mt-1 text-[12px] text-muted">自动重建树结构、对话与上下文</p>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-ink">学习项目</h1>
            <p className="mt-1 text-[13px] text-muted">
              {projects.length > 0
                ? `共 ${projects.length} 个项目，挑一个继续往下走。`
                : '还没有项目。建一个，从一个问题开始。'}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              导入 .tree
            </Button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".tree,.json,application/json"
              className="hidden"
              onChange={(event) => {
                const file = event.target.files?.[0]
                if (file) void handleFile(file)
                event.target.value = ''
              }}
            />
            <Button
              variant="primary"
              onClick={() => {
                setEditing(null)
                setDialogOpen(true)
              }}
            >
              <Plus className="h-4 w-4" />
              新建项目
            </Button>
          </div>
        </div>

        <div className="mt-6 flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索项目"
              className="h-8 w-56 pl-8 text-[13px]"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <TagChip active={activeTag === ALL_TAGS} onClick={() => setActiveTag(ALL_TAGS)}>
              全部
            </TagChip>
            {tags.map((tag) => (
              <TagChip
                key={tag}
                active={activeTag === tag}
                onClick={() => setActiveTag(tag === activeTag ? ALL_TAGS : tag)}
              >
                {tag}
              </TagChip>
            ))}
          </div>
        </div>

        {projects.length === 0 ? (
          <EmptyState
            onAction={() => {
              setEditing(null)
              setDialogOpen(true)
            }}
          />
        ) : visible.length === 0 ? (
          <div className="mt-16 text-center text-[13px] text-muted">没有匹配的项目</div>
        ) : (
          <motion.div
            layout
            className="mt-6 grid gap-4 sm:grid-cols-2 lg:grid-cols-3"
          >
            {visible.map((project) => (
              <motion.div
                key={project.id}
                layout
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
                onClick={() => navigate(`/p/${project.id}`)}
                className="group cursor-pointer rounded-2xl border border-line bg-surface p-4 transition-[border-color,background-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:border-line-strong hover:bg-elevated hover:shadow-node"
              >
                <div className="flex items-start justify-between gap-2">
                  <h2 className="line-clamp-1 text-[14.5px] font-medium text-ink">{project.name}</h2>
                  <div className="flex items-center gap-1">
                    <ArrowUpRight className="h-4 w-4 text-muted opacity-0 transition-opacity group-hover:opacity-100" />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          className="opacity-0 transition-opacity group-hover:opacity-100 data-[state=open]:opacity-100"
                          onClick={(event) => event.stopPropagation()}
                        >
                          <MoreHorizontal className="h-4 w-4" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
                        <DropdownMenuItem
                          onSelect={() => {
                            setEditing(project)
                            setDialogOpen(true)
                          }}
                        >
                          <Pencil className="h-3.5 w-3.5" />
                          编辑
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          disabled={exportingId === project.id}
                          onSelect={() => void handleExport(project)}
                        >
                          {exportingId === project.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Download className="h-3.5 w-3.5" />
                          )}
                          导出为 .tree
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          className="text-danger focus:text-danger"
                          onSelect={() => setDeleting(project)}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                          删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>

                {project.description ? (
                  <p className="mt-2 line-clamp-2 text-[12.5px] leading-relaxed text-muted">
                    {project.description}
                  </p>
                ) : null}

                <div className="mt-3 flex min-h-[22px] flex-wrap items-center gap-1.5">
                  {project.tags.map((tag) => (
                    <Badge key={tag} tone="neutral">
                      {tag}
                    </Badge>
                  ))}
                </div>

                <div className="mt-3 border-t border-line pt-3 text-[11.5px] text-muted/80">
                  {formatRelativeTime(project.updatedAt)} 更新
                </div>
              </motion.div>
            ))}
          </motion.div>
        )}
      </div>

      <ProjectDialog
        key={`${editing?.id ?? 'new'}:${dialogOpen}`}
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        project={editing}
        onCreated={(project) => navigate(`/p/${project.id}`)}
      />

      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent className="w-[min(440px,100%)]">
          <DialogHeader>
            <DialogTitle>删除项目</DialogTitle>
            <DialogDescription>
              将永久删除「{deleting?.name}」及其全部节点与对话，无法恢复。
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) void removeProject(deleting.id)
                setDeleting(null)
              }}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function TagChip({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-2.5 py-1 text-[12px] transition-colors duration-150',
        active
          ? 'border-accent/40 bg-accent-soft text-accent'
          : 'border-line bg-surface text-muted hover:border-line-strong hover:text-ink-soft',
      )}
    >
      {children}
    </button>
  )
}

function EmptyState({ onAction }: { onAction: () => void }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
      className="mt-10 flex flex-col items-center justify-center rounded-2xl border border-dashed border-line px-6 py-16 text-center"
    >
      <div className="mb-4 flex h-11 w-11 items-center justify-center rounded-xl border border-line bg-surface text-accent">
        <Plus className="h-5 w-5" />
      </div>
      <h2 className="text-[15px] font-medium text-ink">从一个问题开始</h2>
      <p className="mt-2 max-w-sm text-[13px] leading-relaxed text-muted">
        每个项目是一张画布。你在节点里和 AI 对话，从某条消息分出新的支线，
        这棵树会长成你独一无二的学习路径。
      </p>
      <Button variant="primary" className="mt-5" onClick={onAction}>
        <Plus className="h-4 w-4" />
        新建项目
      </Button>
    </motion.div>
  )
}