import { useMemo, useState } from 'react'
import { CheckIcon, CopyIcon } from '@primer/octicons-react'
import { IconButton } from '@primer/react'
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

export function CopyButton({
  text,
  label = 'Copy',
  className = '',
  size = 'small',
}: {
  text: string
  label?: string
  className?: string
  size?: 'small' | 'medium'
}) {
  const [done, setDone] = useState(false)
  return (
    <IconButton
      className={className}
      size={size}
      variant="invisible"
      icon={done ? CheckIcon : CopyIcon}
      aria-label={done ? 'Copied!' : label}
      onClick={(e) => {
        e.stopPropagation()
        void copyText(text).then(() => {
          setDone(true)
          setTimeout(() => setDone(false), 2000)
        })
      }}
    />
  )
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  // Repository-controlled text (PR templates, commit messages): no inline styles or form controls,
  // so nothing can be laid over the page's own buttons.
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }) as string, {
        FORBID_ATTR: ['style'],
        FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea', 'iframe'],
      }),
    [source],
  )
  return <div className={`markdown-body ${className}`} dangerouslySetInnerHTML={{ __html: html }} />
}

/** GitHub's five diffstat squares. */
export function DiffSquares({ add, del }: { add: number; del: number }) {
  return (
    <span className="DiffSquares" aria-hidden>
      {diffstatBlocks(add, del).map((b, i) => (
        <span key={i} className={`DiffSquare ${b === 'added' ? 'addition' : b === 'deleted' ? 'deletion' : 'neutral'}`} />
      ))}
    </span>
  )
}
