import { Loader2, Mail } from 'lucide-react'
import { useEffect, useState, type FormEvent } from 'react'
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

const MODE_TABS: { value: AuthMode; label: string }[] = [
  { value: 'login', label: '登录' },
  { value: 'register', label: '注册' },
]

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
      toast.error('请先填写有效邮箱')
      return
    }

    setSendingCode(true)
    try {
      await sendRegisterCode(email)
      setCooldown(CODE_COOLDOWN_SECONDS)
      toast.success('验证码已发送，请查收邮箱')
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
        toast.success('登录成功')
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
        toast.success('注册成功，已自动登录')
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
          <DialogTitle>{mode === 'login' ? '登录' : '注册'}</DialogTitle>
          <DialogDescription>
            {mode === 'login'
              ? '使用账号系统的登录账号与密码。'
              : '注册需要邮箱与 6 位邮箱验证码，注册成功后自动登录。'}
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
              {tab.label}
            </button>
          ))}
        </div>

        <form onSubmit={(event) => void submit(event)} className="space-y-4">
          <DialogField label="登录账号">
            <Input
              value={form.loginName}
              onChange={(event) => setField('loginName', event.target.value)}
              placeholder="2–20 个字符"
              autoComplete="username"
              autoFocus
            />
          </DialogField>

          <DialogField label="密码">
            <Input
              type="password"
              value={form.password}
              onChange={(event) => setField('password', event.target.value)}
              placeholder={mode === 'register' ? '5–20 个字符' : ''}
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
            />
          </DialogField>

          {mode === 'register' ? (
            <>
              <DialogField label="昵称" hint="可选，留空则用登录账号。">
                <Input
                  value={form.userName}
                  onChange={(event) => setField('userName', event.target.value)}
                />
              </DialogField>

              <DialogField label="邮箱">
                <Input
                  type="email"
                  value={form.email}
                  onChange={(event) => setField('email', event.target.value)}
                  placeholder="you@example.com"
                  autoComplete="email"
                />
              </DialogField>

              <DialogField label="邮箱验证码">
                <div className="flex items-center gap-2">
                  <Input
                    value={form.emailCode}
                    inputMode="numeric"
                    onChange={(event) => setField('emailCode', event.target.value)}
                    placeholder="6 位数字"
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
                    {cooldown > 0 ? `${cooldown} 秒` : '发送验证码'}
                  </Button>
                </div>
              </DialogField>
            </>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              取消
            </Button>
            <Button variant="primary" type="submit" disabled={pending}>
              {pending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
              {mode === 'login' ? '登录' : '注册'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}