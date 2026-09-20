import { useState } from 'react'
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
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{project ? '编辑项目' : '新建学习项目'}</DialogTitle>
          <DialogDescription>
            一个项目对应一张画布，用来把「怎么一步步学会的」这条路走完并沉淀下来。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <DialogField label="项目名称">
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="例如：线性代数 · 从矩阵到特征值"
              autoFocus
              onKeyDown={(event) => {
                if (event.key === 'Enter' && !event.nativeEvent.isComposing) void submit()
              }}
            />
          </DialogField>

          <DialogField label="一句话描述" hint="可选，帮助你在项目列表里快速认出来。">
            <Textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              rows={2}
              placeholder="想解决什么问题、学到什么程度"
            />
          </DialogField>

          <DialogField label="标签" hint="回车或逗号分隔，例如：数学、考研、机器学习">
            <TagInput value={tags} onChange={setTags} placeholder="添加标签" />
          </DialogField>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button variant="primary" onClick={() => void submit()} disabled={!name.trim() || saving}>
            {project ? '保存' : '创建并开始'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}