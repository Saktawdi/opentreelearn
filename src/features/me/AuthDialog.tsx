import { Loader2, Mail } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
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
import { cn, errorMessage } from '@/lib/utils'
import { sendRegisterCode } from '@/services/account/client'
import { useAccountStore } from '@/stores/account-store'
import {
  EMAIL_PATTERN,
  EMPTY_AUTH_FORM,
  validateAuthForm,
  type AuthForm,
  type AuthMode,
} from './auth-form'

/** 验证码重发冷却，避免用户连点把上游邮件接口打满。 */
const CODE_COOLDOWN_SECONDS = 60

// labelKey 是 i18n 键：文案在渲染处用 t() 解析，模块级常量只存键
const MODE_TABS = [
  { value: 'login', labelKey: 'auth.mode.login' },
  { value: 'register', labelKey: 'auth.mode.register' },
] as const

export function AuthDialog({
  open,
  onOpenChange,
  initialMode = 'login',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  initialMode?: AuthMode
}) {
  const login = useAccountStore((state) => state.login)
  const register = useAccountStore((state) => state.register)
  const { t } = useTranslation('me')

  const [mode, setMode] = useState<AuthMode>(initialMode)
  const [form, setForm] = useState(EMPTY_AUTH_FORM)
  const [pending, setPending] = useState(false)
  const [sendingCode, setSendingCode] = useState(false)
  const [cooldown, setCooldown] = useState(0)

  // 倒计时用 setTimeout 链而不是 setInterval：每次只剩一次待触发的定时器，
  // 关闭弹窗卸载时不会留下 tick。
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000)
    return () => window.clearTimeout(timer)
  }, [cooldown])

  const setField = (key: keyof AuthForm, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const sendCode = async () => {
    const email = form.email.trim().toLowerCase()
    if (!EMAIL_PATTERN.test(email)) {
      toast.error(t('auth.sendCode.invalidEmail'))
      return
    }

    setSendingCode(true)
    try {
      await sendRegisterCode(email)
      setCooldown(CODE_COOLDOWN_SECONDS)
      toast.success(t('auth.sendCode.sent'))
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setSendingCode(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (pending) return

    const problem = validateAuthForm(mode, form)
    if (problem) {
      toast.error(problem)
      return
    }

    setPending(true)
    try {
      if (mode === 'login') {
        await login({ username: form.loginName.trim(), password: form.password })
        toast.success(t('auth.toast.loginSuccess'))
      } else {
        await register(
          {
            loginName: form.loginName.trim(),
            password: form.password,
            email: form.email.trim().toLowerCase(),
            userName: form.userName.trim() || undefined,
          },
          form.emailCode.trim(),
        )
        toast.success(t('auth.toast.registerSuccess'))
      }
      onOpenChange(false)
    } catch (error) {
      toast.error(errorMessage(error))
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent aria-describedby={undefined}>
        <DialogHeader>
          <DialogTitle>{mode === 'login' ? t('auth.mode.login') : t('auth.mode.register')}</DialogTitle>
          <DialogDescription>
            {mode === 'login'
              ? t('auth.subtitle.login')
              : t('auth.subtitle.register')}
          </DialogDescription>
        </DialogHeader>

        <div className="mb-4 flex items-center gap-1 rounded-md border border-line bg-canvas/60 p-0.5">
          {MODE_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              onClick={() => setMode(tab.value)}
              className={cn(
                'rounded px-2.5 py-1 text-xs transition-colors duration-150',
                mode === tab.value ? 'bg-elevated text-ink' : 'text-muted hover:text-ink',
              )}
            >
              {t(tab.labelKey)}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogField label={t('auth.field.loginName')}>
            <Input
              value={form.loginName}
              onChange={(event) => setField('loginName', event.target.value)}
              placeholder={t('auth.field.loginNamePlaceholder')}
              autoComplete="username"
              autoFocus
            />
          </DialogField>

          <DialogField label={t('auth.field.password')}>
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setField('password', event.target.value)}
              placeholder={mode === 'register' ? t('auth.field.passwordPlaceholder') : ''}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </DialogField>

          {mode === 'register' ? (
            <>
              <DialogField label={t('auth.field.nickname')} hint={t('auth.field.nicknameHint')}>
                <Input
                  value={form.userName}
                  onChange={(event) => setField('userName', event.target.value)}
                />
              </DialogField>

              <DialogField label={t('auth.field.email')}>
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => setField('email', event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </DialogField>

              <DialogField label={t('auth.field.emailCode')}>
                <div className="flex items-center gap-2">
                  <Input
                    value={form.emailCode}
                    inputMode="numeric"
                    onChange={(event) => setField('emailCode', event.target.value)}
                    placeholder={t('auth.field.emailCodePlaceholder')}
                    className="flex-1"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    onClick={() => void sendCode()}
                    disabled={sendingCode || cooldown > 0}
                  >
                    {sendingCode ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Mail className="h-3.5 w-3.5" />
                    )}
                    {cooldown > 0
                      ? t('auth.sendCode.cooldown', { seconds: cooldown })
                      : t('auth.sendCode.button')}
                  </Button>
                </div>
              </DialogField>
            </>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              {t('auth.action.cancel')}
            </Button>
            <Button variant="primary" type="submit" disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {mode === 'login' ? t('auth.mode.login') : t('auth.mode.register')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}