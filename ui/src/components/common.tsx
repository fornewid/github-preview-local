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

// github.com's sanitization allowlist (html-pipeline's SanitizationFilter): every other element
// and attribute is dropped, so repository text (PR templates, commit messages) cannot pose as the
// page: no dialog, label, form controls, class, style, id or SVG; `name` gets the `user-content-`
// prefix. Task list checkboxes come from marked and stay read-only.
const ALLOWED_TAGS = [
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'br', 'b', 'i', 'strong', 'em', 'a', 'pre', 'code', 'img', 'tt',
  'div', 'ins', 'del', 'sup', 'sub', 'p', 'ol', 'ul', 'table', 'thead', 'tbody', 'tfoot', 'blockquote',
  'dl', 'dt', 'dd', 'kbd', 'q', 'samp', 'var', 'hr', 'ruby', 'rt', 'rp', 'li', 'tr', 'td', 'th', 's',
  'strike', 'summary', 'details', 'caption', 'figure', 'figcaption', 'abbr', 'bdo', 'cite', 'dfn',
  'mark', 'small', 'span', 'time', 'wbr', 'input',
]
const ALLOWED_ATTR = [
  'abbr', 'accept', 'accept-charset', 'accesskey', 'action', 'align', 'alt', 'aria-describedby',
  'aria-hidden', 'aria-label', 'aria-labelledby', 'axis', 'border', 'cellpadding', 'cellspacing', 'char',
  'charoff', 'charset', 'checked', 'clear', 'cols', 'colspan', 'color', 'compact', 'coords', 'datetime',
  'dir', 'disabled', 'enctype', 'for', 'frame', 'headers', 'height', 'hreflang', 'hspace', 'ismap',
  'label', 'lang', 'maxlength', 'media', 'method', 'multiple', 'name', 'nohref', 'noshade', 'nowrap',
  'open', 'progress', 'prompt', 'readonly', 'rel', 'rev', 'role', 'rows', 'rowspan', 'rules', 'scope',
  'selected', 'shape', 'size', 'span', 'start', 'summary', 'tabindex', 'target', 'title', 'type',
  'usemap', 'valign', 'value', 'vspace', 'width', 'itemprop',
  // Only on some elements (checked in the hook below).
  'href', 'src', 'longdesc', 'cite', 'itemscope', 'itemtype',
]
const ONLY_ON: Record<string, string[]> = {
  href: ['A'],
  src: ['IMG'],
  longdesc: ['IMG'],
  cite: ['BLOCKQUOTE', 'DEL', 'INS', 'Q'],
  itemscope: ['DIV'],
  itemtype: ['DIV'],
}

function sanitize(html: string): string {
  const onElement = (node: Node, data: { tagName: string }) => {
    if (data.tagName !== 'input') return
    const el = node as Element
    if (el.getAttribute('type') !== 'checkbox') el.remove()
    else el.setAttribute('disabled', '')
  }
  const onAttributes = (node: Element) => {
    for (const [attr, tags] of Object.entries(ONLY_ON)) {
      if (node.hasAttribute?.(attr) && !tags.includes(node.tagName)) node.removeAttribute(attr)
    }
    // Still in DOMPurify's inert document: an <img> with a src must never reach the page's
    // document, where it would start loading.
    if (node.tagName === 'IMG') {
      node.setAttribute('data-src', node.getAttribute('src') ?? '')
      node.removeAttribute('src')
    }
  }
  DOMPurify.addHook('uponSanitizeElement', onElement)
  DOMPurify.addHook('afterSanitizeAttributes', onAttributes)
  let fragment: DocumentFragment
  try {
    fragment = DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      SANITIZE_NAMED_PROPS: true,
      // github.com: http(s), mailto and relative URLs only.
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
      RETURN_DOM_FRAGMENT: true,
    })
  } finally {
    DOMPurify.removeHook('uponSanitizeElement', onElement)
    DOMPurify.removeHook('afterSanitizeAttributes', onAttributes)
  }
  for (const img of fragment.querySelectorAll('img')) img.replaceWith(blockedImage(img))
  const out = document.createElement('div')
  out.append(fragment)
  return out.innerHTML
}

/**
 * gh-prv-local loads nothing from other hosts (github.com shows images through its camo proxy;
 * gh-prv-local would have to ask the image's host directly). An image becomes a link to it
 * instead, which opens in the browser only when clicked; a relative path (a file in the
 * repository) is just named.
 */
function blockedImage(img: HTMLImageElement): Element {
  // Protocol-relative (//host/x.png) means https here: the page itself is tauri: or file:.
  // data: images are not shown either (github.com drops them).
  const src = (img.getAttribute('data-src') ?? '').replace(/^\/\//, 'https://').replace(/^data:.*/is, '')
  const remote = /^https?:\/\//i.test(src)
  const label = img.getAttribute('alt') || (src && src.split(/[?#]/)[0]!.split('/').filter(Boolean).pop()) || 'image'
  const inLink = !!img.closest('a')
  const el = document.createElement(remote && !inLink ? 'a' : 'span')
  el.className = 'BlockedImage'
  el.textContent = label
  el.title = remote
    ? `Image not loaded (gh-prv-local loads nothing from other hosts): ${src}`
    : src
      ? `Image in the repository: ${src}`
      : 'Image not shown'
  if (remote && !inLink) el.setAttribute('href', src)
  return el
}

export function Markdown({ source, className = '' }: { source: string; className?: string }) {
  const html = useMemo(() => sanitize(marked.parse(source, { async: false, gfm: true, breaks: true }) as string), [source])
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
