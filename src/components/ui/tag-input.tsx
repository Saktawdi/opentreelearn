import { X } from 'lucide-react'
import { useState } from 'react'
import { Badge } from '@/components/ui/badge'

export function TagInput({
  value,
  onChange,
  placeholder,
  splitOnSpace = true,
}: {
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  splitOnSpace?: boolean
}) {
  const [draft, setDraft] = useState('')

  const commit = () => {
    const parts = draft
      .split(splitOnSpace ? /[,，\s]+/ : /[,，]+/)
      .map((part) => part.trim())
      .filter(Boolean)

    if (parts.length > 0) {
      const next = [...value]
      for (const part of parts) {
        if (!next.includes(part)) next.push(part)
      }
      onChange(next)
    }
    setDraft('')
  }

  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-line bg-canvas/60 px-2 py-1.5 transition-colors focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/20">
      {value.map((item) => (
        <Badge key={item} tone="neutral" className="gap-1 pr-1">
          <span className="font-mono text-[11px]">{item}</span>
          <button
            type="button"
            onClick={() => onChange(value.filter((entry) => entry !== item))}
            className="rounded-full p-0.5 text-muted transition-colors hover:text-ink"
          >
            <X className="h-3 w-3" />
          </button>
        </Badge>
      ))}
      <input
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
            event.preventDefault()
            commit()
            return
          }
          if (event.key === 'Backspace' && draft.length === 0 && value.length > 0) {
            onChange(value.slice(0, -1))
          }
        }}
        onBlur={commit}
        placeholder={value.length > 0 ? '' : placeholder}
        className="min-w-[90px] flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-muted/70"
      />
    </div>
  )
}