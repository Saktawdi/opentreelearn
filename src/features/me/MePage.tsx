import { Loader2, LogIn, LogOut, UserPlus } from 'lucide-react'
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Section } from '@/components/ui/section'
import { Skeleton } from '@/components/ui/skeleton'
import { Textarea } from '@/components/ui/textarea'
import { resolveAvatarUrl, type AccountUser } from '@/services/account/client'
import { useAccountStore } from '@/stores/account-store'
import { useSettingsStore } from '@/stores/settings-store'
import { AuthDialog } from './AuthDialog'
import { SyncPanel } from './SyncPanel'
import type { AuthMode } from './auth-form'

function AccountAvatar({ user }: { user: AccountUser }) {
  const url = resolveAvatarUrl(user.avatar)
  if (url) {
    return (
      <img
        src={url}
        alt=""
        className="h-9 w-9 shrink-0 rounded-full border border-line object-cover"
      />
    )
  }

  const initial = (user.userName || user.loginName || '?').trim().charAt(0).toUpperCase()
  return (
    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-line bg-elevated text-sm text-muted">
      {initial}
    </span>
  )
}

function AccountSkeleton() {
  return (
    <div className="flex items-center gap-3 rounded-md border border-line px-3 py-2.5">
      <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
      <div className="flex-1 space-y-1.5">
        <Skeleton className="h-3 w-28" />
        <Skeleton className="h-3 w-44" />
      </div>
    </div>
  )
}

export function MePage() {
  const status = useAccountStore((state) => state.status)
  const user = useAccountStore((state) => state.user)
  const restoreError = useAccountStore((state) => state.restoreError)
  const restore = useAccountStore((state) => state.restore)
  const logout = useAccountStore((state) => state.logout)

  const settings = useSettingsStore((state) => state.settings)
  const patch = useSettingsStore((state) => state.patch)
  const { t } = useTranslation('me')

  const [profile, setProfile] = useState(() => settings.backgroundProfile)
  const [authOpen, setAuthOpen] = useState(false)
  const [authMode, setAuthMode] = useState<AuthMode>('login')
  const [signingOut, setSigningOut] = useState(false)

  // 账号恢复与同步触发都不在本页：启动阶段就会绑库并后台校验 token，此后由
  // 壳上的 useSyncRuntime 持续保持同步，本页只保留「重试」这一处手动入口。
  const profileDirty = profile !== settings.backgroundProfile

  const saveProfile = async () => {
    await patch({ backgroundProfile: profile })
    toast.success(t('page.toast.saved'))
  }

  const openAuth = (mode: AuthMode) => {
    setAuthMode(mode)
    setAuthOpen(true)
  }

  const signOut = async () => {
    setSigningOut(true)
    try {
      await logout()
      toast.success(t('page.toast.signedOut'))
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-6 px-4 sm:px-6 py-5 sm:py-7 pb-safe">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink">{t('page.title')}</h1>
          <p className="mt-1 text-xs text-muted">{t('page.subtitle')}</p>
        </div>

        <Section title={t('page.account.title')} description={t('page.account.description')}>
          {status === 'authenticated' && user ? (
            <div className="flex flex-wrap items-center gap-3 rounded-md border border-line px-3 py-2.5">
              <AccountAvatar user={user} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-ink">
                  {user.userName || user.loginName || t('page.account.unnamed')}
                </p>
                <p className="mt-0.5 truncate text-xs text-muted">
                  {[user.loginName ? `@${user.loginName}` : '', user.email ?? '']
                    .filter(Boolean)
                    .join(' · ')}
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                disabled={signingOut}
                onClick={() => void signOut()}
              >
                {signingOut ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <LogOut className="h-3.5 w-3.5" />
                )}
                {t('page.account.signOut')}
              </Button>
            </div>
          ) : status === 'restoring' || status === 'uninitialized' ? (
            <AccountSkeleton />
          ) : (
            <div className="rounded-md border border-dashed border-line px-4 py-5 text-center">
              <p className="text-sm text-ink-soft">{t('page.account.notSignedIn')}</p>
              <p className="mt-1 text-xs leading-relaxed text-muted">
                {t('page.account.credentialsHint')}
              </p>
              <div className="mt-3 flex items-center justify-center gap-2">
                <Button variant="primary" size="sm" onClick={() => openAuth('login')}>
                  <LogIn className="h-3.5 w-3.5" />
                  {t('page.account.login')}
                </Button>
                <Button variant="secondary" size="sm" onClick={() => openAuth('register')}>
                  <UserPlus className="h-3.5 w-3.5" />
                  {t('page.account.register')}
                </Button>
              </div>
            </div>
          )}

          {restoreError ? (
            <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-danger/35 bg-danger-soft px-3 py-2">
              <p className="text-xs leading-relaxed text-danger">{restoreError}</p>
              <Button variant="ghost" size="sm" onClick={() => void restore()}>
                {t('page.account.retry')}
              </Button>
            </div>
          ) : null}
        </Section>

        <Section
          title={t('page.profile.title')}
          description={t('page.profile.description')}
        >
          <Textarea
            value={profile}
            rows={5}
            onChange={(event) => setProfile(event.target.value)}
            placeholder={t('page.profile.placeholder')}
          />
          <div className="mt-3 flex justify-end">
            <Button
              variant="primary"
              size="sm"
              disabled={!profileDirty}
              onClick={() => void saveProfile()}
            >
              {t('page.profile.save')}
            </Button>
          </div>
        </Section>

        {status === 'authenticated' ? (
          <Section title={t('page.sync.title')}>
            <SyncPanel />
          </Section>
        ) : null}

        <p className="border-t border-line pt-5 text-xs leading-relaxed text-muted">
          {status === 'authenticated'
            ? t('page.footer.authenticated')
            : t('page.footer.guest')}
        </p>
      </div>

      {/* 用 key 重挂载重置草稿（与项目弹窗同一约定），不在 effect 里同步 props → state */}
      <AuthDialog
        key={`${authMode}:${String(authOpen)}`}
        open={authOpen}
        onOpenChange={setAuthOpen}
        initialMode={authMode}
      />
    </div>
  )
}