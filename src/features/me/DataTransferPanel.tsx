import { Download, Loader2, Upload } from 'lucide-react'
import { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from '@/components/ui/dialog'
import { getDatabase } from '@/data'
import { errorMessage } from '@/lib/utils'
import { downloadAllData, importAllData, parseDataBackup, type DataBackup } from '@/services/backup'
import { useAccountStore } from '@/stores/account-store'
import { reloadStores } from '@/stores/data-session'
import { useFreeAskStore } from '@/stores/free-ask-store'
import { useReviewSessionStore } from '@/stores/review-session-store'
import { useSyncStore } from '@/stores/sync-store'
import { useWorkspaceStore } from '@/stores/workspace-store'

export function DataTransferPanel({ onImported }: { onImported: () => void }) {
  const { t } = useTranslation('me')
  const input = useRef<HTMLInputElement>(null)
  const operation = useRef(false)
  const [working, setWorking] = useState<'export' | 'read' | 'import' | null>(null)
  const [pending, setPending] = useState<{ backup: DataBackup; name: string; database: string } | null>(null)
  const syncing = useSyncStore((state) => state.phase === 'syncing')
  const transferring = useSyncStore((state) => state.dataTransferBusy)
  const accountStatus = useAccountStore((state) => state.status)
  const chatStreaming = useWorkspaceStore((state) => Boolean(state.streaming))
  const reviewStreaming = useReviewSessionStore((state) => Boolean(state.streaming))
  const freeAskStreaming = useFreeAskStore((state) => Boolean(state.streaming))
  const unavailable = syncing || transferring || chatStreaming || reviewStreaming || freeAskStreaming ||
    accountStatus === 'restoring' || accountStatus === 'uninitialized'
  const busy = working !== null

  const start = (kind: 'export' | 'read' | 'import'): boolean => {
    if (operation.current || unavailable) return false
    operation.current = true
    setWorking(kind)
    useSyncStore.getState().setDataTransferBusy(true)
    return true
  }

  const finish = () => {
    useSyncStore.getState().setDataTransferBusy(false)
    operation.current = false
    setWorking(null)
  }

  const exportData = async () => {
    if (!start('export')) return
    try {
      await downloadAllData()
      toast.success(t('backup.exported'))
    } catch (error) {
      toast.error(t('backup.exportFailed', { message: errorMessage(error) }))
    } finally {
      finish()
    }
  }

  const readFile = async (file: File) => {
    if (!start('read')) return
    const database = getDatabase().name
    try {
      const backup = parseDataBackup(await file.text())
      setPending({ backup, name: file.name, database })
    } catch (error) {
      toast.error(t('backup.importFailed', { message: errorMessage(error) }))
    } finally {
      finish()
    }
  }

  const importData = async () => {
    if (!pending || !start('import')) return
    try {
      const database = getDatabase()
      if (database.name !== pending.database) throw new Error(t('backup.accountChanged'))
      await importAllData(pending.backup, database)
      setPending(null)
      // Persisted review sessions will restore on entry; discard their old memory
      // copies so delayed drafts cannot overwrite the freshly imported records.
      useReviewSessionStore.getState().reset()
      useFreeAskStore.getState().reset()
      await reloadStores()
      await useSyncStore.getState().refreshPending()
      onImported()
      toast.success(t('backup.imported', { count: pending.backup.tables.projects.length }))
    } catch (error) {
      toast.error(t('backup.importFailed', { message: errorMessage(error) }))
    } finally {
      finish()
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-xs leading-relaxed text-muted">{t('backup.description')}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy || unavailable || Boolean(pending)} onClick={() => void exportData()}>
          {working === 'export' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
          {t(working === 'export' ? 'backup.exporting' : 'backup.export')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy || unavailable || Boolean(pending)} onClick={() => input.current?.click()}>
          {working === 'read' || working === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
          {t(working === 'read' || working === 'import' ? 'backup.importing' : 'backup.import')}
        </Button>
        <input
          ref={input}
          type="file"
          accept=".json,application/json"
          aria-label={t('backup.import')}
          className="hidden"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) void readFile(file)
          }}
        />
      </div>
      <p className="text-xs leading-relaxed text-muted">{t('backup.fileHint')}</p>
      <Dialog open={Boolean(pending)} onOpenChange={(open) => { if (!open && !busy) setPending(null) }}>
        <DialogContent showClose={!busy}>
          <DialogHeader>
            <DialogTitle>{t('backup.confirmTitle')}</DialogTitle>
            <DialogDescription>{t('backup.confirmDescription')}</DialogDescription>
          </DialogHeader>
          {pending ? (
            <div className="rounded-md border border-line px-3 py-2.5 text-sm text-ink-soft">
              <p className="break-all">{pending.name}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {t('backup.summary', {
                  projects: pending.backup.tables.projects.length,
                  nodes: pending.backup.tables.nodes.length,
                  messages: pending.backup.tables.messages.length + pending.backup.tables.freeAskMessages.length,
                  images: pending.backup.tables.assets.length,
                })}
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setPending(null)}>{t('backup.cancel')}</Button>
            <Button variant="primary" size="sm" disabled={busy || unavailable} onClick={() => void importData()}>
              {working === 'import' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Upload className="h-3.5 w-3.5" />}
              {t(working === 'import' ? 'backup.importing' : 'backup.confirmImport')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
