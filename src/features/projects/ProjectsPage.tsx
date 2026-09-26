import { Download, Loader2, MoreHorizontal, Pencil, Plus, Search, Trash2, Upload } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
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
import { TodayReviewPanel } from './TodayReviewPanel'
import { useImportProject } from './useImportProject'

const ALL_TAGS = '__all__'

export function ProjectsPage() {
  const { t } = useTranslation('projects')
  const navigate = useNavigate()
  const projects = useProjectsStore((state) => state.projects)
  const removeProject = useProjectsStore((state) => state.remove)
  const { handleFile, importing } = useImportProject(t)

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
      // 说明清楚导出的是学习树：本机复习会话（未做完的那一批）不参与导出，也不是完整备份
      toast.success(t('export.success', { name: project.name }), {
        description: t('export.successDescription'),
      })
    } catch (error) {
      toast.error(t('export.failed', { message: errorMessage(error) }))
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

  const openCreate = () => {
    setEditing(null)
    setDialogOpen(true)
  }

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
        <div className="pointer-events-none absolute inset-4 z-40 flex items-center justify-center rounded-lg border border-dashed border-accent bg-canvas/90 p-8 text-center">
          <div>
            <Upload className="mx-auto h-5 w-5 text-accent" />
            <p className="mt-2 text-sm font-medium text-ink">{t('dropzone.release')}</p>
          </div>
        </div>
      ) : null}

      <div className="mx-auto w-full max-w-5xl px-6 py-7">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('page.title')}</h1>
          {projects.length > 0 ? (
            <p className="mt-1 text-xs text-muted">{t('page.projectCount', { count: projects.length })}</p>
          ) : null}
        </div>

        {projects.length > 0 ? <TodayReviewPanel projects={projects} /> : null}

        <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            {projects.length > 0 ? (
              <>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-faint" />
                  <Input
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('search.placeholder')}
                    className="w-56 pl-8"
                  />
                </div>

                {tags.length > 0 ? (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <TagChip active={activeTag === ALL_TAGS} onClick={() => setActiveTag(ALL_TAGS)}>
                      {t('tags.all')}
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
                ) : null}
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="secondary"
              disabled={importing}
              onClick={() => fileInputRef.current?.click()}
            >
              {importing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              {t('actions.import')}
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
            <Button variant="primary" onClick={openCreate}>
              <Plus className="h-4 w-4" />
              {t('actions.create')}
            </Button>
          </div>
        </div>

        {projects.length === 0 ? (
          <EmptyState />
        ) : (
          <>
            {visible.length === 0 ? (
              <p className="py-20 text-center text-sm text-muted">{t('page.noMatches')}</p>
            ) : (
              <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {visible.map((project) => (
                  <div
                    key={project.id}
                    onClick={() => navigate(`/p/${project.id}`)}
                    className="group cursor-pointer rounded-lg border border-line bg-surface p-4 transition-colors duration-150 hover:border-line-strong hover:bg-elevated"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h2 className="line-clamp-1 text-base font-medium text-ink">{project.name}</h2>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon-sm"
                            className="-mr-1 -mt-1 shrink-0 text-muted opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100 data-[state=open]:opacity-100"
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
                            {t('actions.edit')}
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
                            {t('actions.export')}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            className="text-danger focus:text-danger"
                            onSelect={() => setDeleting(project)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                            {t('actions.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>

                    {project.description ? (
                      <p className="mt-1.5 line-clamp-2 text-sm leading-relaxed text-muted">
                        {project.description}
                      </p>
                    ) : null}

                    <div className="mt-3 flex min-h-[20px] flex-wrap items-center gap-1.5">
                      {project.tags.map((tag) => (
                        <Badge key={tag} tone="neutral">
                          {tag}
                        </Badge>
                      ))}
                    </div>

                    <p className="mt-3 border-t border-line pt-2.5 text-xs text-faint flex items-center justify-between">
                      <span>{t('card.updatedAt', { time: formatRelativeTime(project.updatedAt) })}</span>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation()
                          navigate(`/p/${project.id}?view=review`)
                        }}
                        className="text-2xs text-muted hover:text-accent transition-colors"
                      >
                        {t('card.enterReview')}
                      </button>
                    </p>
                  </div>
                ))}
              </div>
            )}
          </>
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
        <DialogContent className="w-[min(420px,100%)]">
          <DialogHeader>
            <DialogTitle>{t('delete.title')}</DialogTitle>
            <DialogDescription>
              {t('delete.description', { name: deleting?.name ?? '' })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setDeleting(null)}>
              {t('actions.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                if (deleting) void removeProject(deleting.id)
                setDeleting(null)
              }}
            >
              {t('actions.delete')}
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
        'rounded-full border px-2.5 py-1 text-xs transition-colors duration-150',
        active
          ? 'border-line-strong bg-elevated text-ink'
          : 'border-line text-muted hover:border-line-strong hover:text-ink-soft',
      )}
    >
      {children}
    </button>
  )
}

/** 空态：一句话说明这是什么，动作交给页头的「新建项目」。 */
function EmptyState() {
  const { t } = useTranslation('projects')
  return (
    <div className="mt-14 rounded-lg border border-line/70 px-6 py-10">
      <h2 className="text-base font-medium text-ink">{t('empty.title')}</h2>
      <p className="mt-2 max-w-md text-sm leading-relaxed text-muted">{t('empty.description')}</p>
    </div>
  )
}
