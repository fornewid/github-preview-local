import { useEffect, useId, useRef, useState, type ReactNode } from 'react'
import {
  BoldIcon,
  CodeIcon,
  CrossReferenceIcon,
  DiffIgnoredIcon,
  HeadingIcon,
  ItalicIcon,
  LinkIcon,
  ListOrderedIcon,
  ListUnorderedIcon,
  MentionIcon,
  QuoteIcon,
  TasklistIcon,
} from '@primer/octicons-react'
import { Textarea } from '@primer/react'
import { ActionBar } from '@primer/react/experimental'
import { Markdown } from './common'

type Format = (sel: { text: string; start: number; end: number }) => { text: string; start: number; end: number }

function wrap(before: string, after = before): Format {
  return ({ text, start, end }) => {
    const sel = text.slice(start, end)
    const out = text.slice(0, start) + before + sel + after + text.slice(end)
    return { text: out, start: start + before.length, end: end + before.length }
  }
}

function prefixLines(prefix: (i: number) => string): Format {
  return ({ text, start, end }) => {
    const ls = start === 0 ? 0 : text.lastIndexOf('\n', start - 1) + 1
    const block = text.slice(ls, end)
    const lines = block.split('\n').map((l, i) => prefix(i) + l)
    const joined = lines.join('\n')
    const out = text.slice(0, ls) + joined + text.slice(end)
    return { text: out, start: start + prefix(0).length, end: ls + joined.length }
  }
}

const insert =
  (s: string): Format =>
  ({ text, start, end }) => ({ text: text.slice(0, start) + s + text.slice(end), start: start + s.length, end: start + s.length })

/**
 * GitHub's comment box (new pull request experience): Write / Preview tabs, the formatting
 * toolbar and a Primer textarea. Cmd/Ctrl+Enter submits.
 */
export function MarkdownEditor({
  value,
  onChange,
  placeholder = 'Leave a comment',
  autoFocus,
  onSubmit,
  rows = 5,
  label = 'Markdown value',
  suggestion,
  footer,
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  autoFocus?: boolean
  onSubmit?: () => void
  /** Visible lines (github.com: 5, i.e. a 121px textarea). */
  rows?: number
  label?: string
  /** Lines to prefill a ```suggestion block with (inline comments only). */
  suggestion?: string[]
  footer?: ReactNode
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write')
  const ref = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  // Overlays move focus to their first control after mounting (e.g. "Finish your review" in its
  // fullscreen form); github.com starts in the text box, so take focus back once they are done.
  useEffect(() => {
    if (!autoFocus) return
    const raf = requestAnimationFrame(() => ref.current?.focus())
    return () => cancelAnimationFrame(raf)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const apply = (f: Format) => {
    const el = ref.current
    const cur = { text: value, start: el?.selectionStart ?? value.length, end: el?.selectionEnd ?? value.length }
    const next = f(cur)
    onChange(next.text)
    requestAnimationFrame(() => {
      if (!ref.current) return
      ref.current.focus()
      ref.current.setSelectionRange(next.start, next.end)
    })
  }

  const tools: Array<[string, typeof BoldIcon, Format]> = [
    ['Heading', HeadingIcon, prefixLines(() => '### ')],
    ['Bold', BoldIcon, wrap('**')],
    ['Italic', ItalicIcon, wrap('_')],
    ['Quote', QuoteIcon, prefixLines(() => '> ')],
    ['Code', CodeIcon, wrap('`')],
    ['Link', LinkIcon, wrap('[', '](url)')],
  ]
  const lists: Array<[string, typeof BoldIcon, Format]> = [
    ['Unordered list', ListUnorderedIcon, prefixLines(() => '- ')],
    ['Numbered list', ListOrderedIcon, prefixLines((i) => `${i + 1}. `)],
    ['Task list', TasklistIcon, prefixLines(() => '- [ ] ')],
  ]
  const extra: Array<[string, typeof BoldIcon, Format]> = [
    ['Mention', MentionIcon, insert('@')],
    ['Reference', CrossReferenceIcon, insert('#')],
  ]
  if (suggestion)
    extra.push([
      'Add a suggestion',
      DiffIgnoredIcon,
      insert(`${value && !value.endsWith('\n') ? '\n' : ''}\`\`\`suggestion\n${suggestion.join('\n')}\n\`\`\`\n`),
    ])

  return (
    <div className="MarkdownEditor">
      <div className="MarkdownEditor-box">
        <div className="MarkdownEditor-header">
          <div className="MarkdownEditor-tabs" role="tablist" aria-label="View mode">
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'write'}
              className={`MarkdownEditor-tab ${mode === 'write' ? 'active' : ''}`}
              onClick={() => setMode('write')}
            >
              Write
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={mode === 'preview'}
              className={`MarkdownEditor-tab ${mode === 'preview' ? 'active' : ''}`}
              onClick={() => setMode('preview')}
            >
              Preview
            </button>
          </div>
          {mode === 'write' && (
            <div className="MarkdownEditor-toolbar">
              <ActionBar aria-label="Formatting tools" size="medium">
                {tools.map(([name, Icon, f]) => (
                  <ActionBar.IconButton key={name} icon={Icon} aria-label={name} onClick={() => apply(f)} />
                ))}
                <ActionBar.Divider />
                {lists.map(([name, Icon, f]) => (
                  <ActionBar.IconButton key={name} icon={Icon} aria-label={name} onClick={() => apply(f)} />
                ))}
                <ActionBar.Divider />
                {extra.map(([name, Icon, f]) => (
                  <ActionBar.IconButton key={name} icon={Icon} aria-label={name} onClick={() => apply(f)} />
                ))}
              </ActionBar>
            </div>
          )}
        </div>
        {mode === 'write' ? (
          <div className="MarkdownEditor-input">
            <Textarea
              ref={ref}
              id={id}
              aria-label={label}
              block
              resize="vertical"
              value={value}
              placeholder={placeholder}
              autoFocus={autoFocus}
              rows={rows}
              onChange={(e) => onChange(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  e.preventDefault()
                  onSubmit?.()
                }
              }}
            />
          </div>
        ) : (
          <div className="MarkdownEditor-preview" style={{ minHeight: rows * 21 + 32 }}>
            {value.trim() ? <Markdown source={value} /> : <span className="fgColor-muted">Nothing to preview</span>}
          </div>
        )}
        {footer}
      </div>
    </div>
  )
}
