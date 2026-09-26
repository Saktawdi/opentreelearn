import type { TFunction } from 'i18next'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { toast } from 'sonner'
import { errorMessage } from '@/lib/utils'
import { importTreeFile } from '@/services/import'
import { useProjectsStore } from '@/stores/projects-store'

export function useImportProject(t: TFunction<'projects'>) {
  const navigate = useNavigate()
  const loadProjects = useProjectsStore((state) => state.load)
  const [importing, setImporting] = useState(false)

  const handleFile = async (file: File) => {
    if (importing) return
    setImporting(true)
    try {
      const result = await importTreeFile(file)
      await loadProjects()
      const extra: string[] = []
      if (result.stats.notes > 0) extra.push(t('import.notes', { count: result.stats.notes }))
      if (result.stats.images > 0) extra.push(t('import.imagesSkipped', { count: result.stats.images }))

      const description = extra.length > 0 ? extra.join(' · ') : undefined
      toast.success(
        t('import.success', {
          name: result.project.name,
          cards: t('import.nodes', { count: result.stats.cards }),
          messages: t('import.messages', { count: result.stats.messages }),
        }),
        description ? { description } : undefined,
      )
      navigate(`/p/${result.project.id}`)
    } catch (error) {
      toast.error(t('import.failed', { message: errorMessage(error) }))
    } finally {
      setImporting(false)
    }
  }

  return { handleFile, importing }
}