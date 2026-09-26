import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogField,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { TagInput } from '@/components/ui/tag-input'
import { Textarea } from '@/components/ui/textarea'
import type { Project } from '@/domain/models'
import { useProjectsStore } from '@/stores/projects-store'

export function ProjectDialog({
  open,
  onOpenChange,
  project,
  onCreated,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  project?: Project | null
  onCreated?: (project: Project) => void
}) {
  const createProject = useProjectsStore((state) => state.create)
  const updateProject = useProjectsStore((state) => state.update)
  const { t } = useTranslation('projects')

  const [name, setName] = useState(() => project?.name ?? '')
  const [description, setDescription] = useState(() => project?.description ?? '')
  const [tags, setTags] = useState<string[]>(() => project?.tags ?? [])
  const [saving, setSaving] = useState(false)

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed) return

    setSaving(true)
    try {
      if (project) {
        await updateProject(project.id, {
          name: trimmed,
          description: description.trim() || undefined,
          tags,
        })
      } else {
        const created = await createProject({
          name: trimmed,
          description: description.trim() || undefined,
          tags,
        })
        onCreated?.(created)
      }
      onOpenChange(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* 没有描述文本时显式置空 describedby，避免 radix 在控制台告警 */}
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{project ? t('dialog.editTitle') : t('dialog.createTitle')}</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          <DialogField label={t('dialog.name')}>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder={t('dialog.namePlaceholder')}
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit()
              }}
            />
          </DialogField>

          <DialogField label={t('dialog.description')} hint={t('dialog.optional')}>
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder={t('dialog.descriptionPlaceholder')}
            />
          </DialogField>

          <DialogField label={t('dialog.tags')} hint={t('dialog.tagsHint')}>
            <TagInput value={tags} onChange={setTags} placeholder={t('dialog.tagsPlaceholder')} />
          </DialogField>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('actions.cancel')}
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim() || saving}>
            {project ? t('dialog.save') : t('dialog.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}