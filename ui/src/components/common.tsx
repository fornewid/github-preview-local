import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { CheckIcon, CopyIcon } from '@primer/octicons-react'
import { marked } from 'marked'
import DOMPurify from 'dompurify'
import { diffstatBlocks } from '../diff/util'

export function Avatar({ name, size = 20 }: { name: string; size?: number }) {
  const initials = (name || '?')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]!.toUpperCase())
    .join('')
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: Math.max(9, size * 0.42) }} aria-hidden>
      {initials || '?'}
    </span>
  )
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
}

export function CopyButton({ text, label = 'Copy', className = '' }: { text: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className={`copy-btn ${className}`}
      aria-label={label}
      title={done ? 'Copied!' : label}
      onClick={(e) => {
        e.stopPropagation()
        void copyText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 2000)
        })
      }}
    >
      {done ? <CheckIcon size={16} className="color-fg-success" fill="var(--fgColor-success)" /> : <CopyIcon size={16} />}
    </button>
  )
}

/**
 * `<details>` based dropdown, like GitHub's classic `details-overlay` menus:
 * closes on outside click and Escape.
 */
export function Menu({
  className,
  summary,
  summaryClassName,
  children,
  label,
}: {
  className?: string
  summary: ReactNode
  summaryClassName?: string
  label?: string
  children: (close: () => void) => ReactNode
}) {
  const ref = useRef<HTMLDetailsElement>(null)
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      const d = ref.current
      if (d && !d.contains(e.target as Node)) d.open = false
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && ref.current) ref.current.open = false
    }
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])
  const close = () => {
    if (ref.current) ref.current.open = false
  }
  return (
    <details ref={ref} className={`details-reset ${className ?? ''}`} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className={summaryClassName} aria-haspopup="menu" aria-label={label}>
        {summary}
      </summary>
      {open && children(close)}
    </details>
  )
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }) as string), [source])
  return <div className={`markdown-body ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}

export function DiffStatBlocks({ add, del }: { add: number; del: number }) {
  return (
    <>
      {diffstatBlocks(add, del).map((b, i) => (
        <span key={i} className={`diffstat-block-${b}`} />
      ))}
    </>
  )
}

/** GitHub-style comment box with Write / Preview tabs. */
export function CommentBox({
  value,
  onChange,
  placeholder = 'Leave a comment',
  autoFocus,
  onSubmitShortcut,
  minHeight,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onSubmitShortcut?: () => void
  minHeight?: number
}) {
  const [tab, setTab] = useState<'write' | 'preview'>('write')
  return (
    <div className="comment-box">
      <div className="comment-form-head">
        <button type="button" className={`comment-form-tab ${tab === 'write' ? 'selected' : ''}`} onClick={() => setTab('write')}>
          Write
        </button>
        <button
          type="button"
          className={`comment-form-tab ${tab === 'preview' ? 'selected' : ''}`}
          onClick={() => setTab('preview')}
        >
          Preview
        </button>
      </div>
      {tab === 'write' ? (
        <textarea
          value={value}
          placeholder={placeholder}
          autoFocus={autoFocus}
          style={minHeight ? { minHeight } : undefined}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
              e.preventDefault()
              onSubmitShortcut?.()
            }
          }}
        />
      ) : (
        <div className="preview">
          {value.trim() ? <Markdown source={value} /> : <span className="color-fg-muted">Nothing to preview</span>}
        </div>
      )}
    </div>
  )
}
