import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react'
import { useStore } from '../../store'
import type { FileDiff } from '../../types'
import type { ContentSide } from '../../diff/util'

/**
 * An image file in the diff, as github.com shows it (its image view, measured): an added or
 * deleted image alone; a changed one side by side (2-up), with a swipe handle (Swipe) or blended
 * (Onion Skin). The images come from the repository as data URLs, so nothing is loaded from elsewhere.
 */
type Mode = '2-up' | 'swipe' | 'onion'
type Loaded = { url: string; width: number; height: number }

const MODES: Array<[Mode, string]> = [
  ['2-up', '2-up'],
  ['swipe', 'Swipe'],
  ['onion', 'Onion Skin'],
]
/** github.com: each image of the 2-up view is at most 414px wide; Swipe and Onion Skin 846px. */
const STACK_MAX = 846

/** One side's image and its natural size: undefined while loading, null when unavailable. */
function useImage(file: FileDiff, side: ContentSide, wanted: boolean): Loaded | null | undefined {
  const transport = useStore((st) => st.transport)
  const [image, setImage] = useState<Loaded | null | undefined>(wanted ? undefined : null)
  useEffect(() => {
    if (!wanted || !transport) return
    let live = true
    transport
      .getImage(file, side)
      .then((url) => {
        if (!url) return live && setImage(null)
        const img = new Image()
        img.onload = () => live && setImage({ url, width: img.naturalWidth, height: img.naturalHeight })
        img.onerror = () => live && setImage(null)
        img.src = url
      })
      .catch(() => live && setImage(null))
    return () => {
      live = false
    }
  }, [transport, file, side, wanted])
  return image
}

/** The element's content width, kept up to date. */
function useWidth() {
  const ref = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(0)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const ro = new ResizeObserver(([e]) => setWidth(e.contentRect.width))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return [ref, width] as const
}

export function ImageDiff({ file, fallback }: { file: FileDiff; fallback: ReactNode }) {
  const hasOld = file.status !== 'added'
  const hasNew = file.status !== 'deleted'
  const before = useImage(file, 'old', hasOld)
  const after = useImage(file, 'new', hasNew)
  const [mode, setMode] = useState<Mode>('2-up')
  if (before === undefined || after === undefined) return <div className="ImageDiff ImageDiff--loading">Loading image…</div>
  if ((hasOld && !before) || (hasNew && !after)) return <>{fallback}</>
  if (!before || !after) {
    const only = (before ?? after)!
    return (
      <div className="ImageDiff">
        <span className="ImageDiff-single">
          <img src={only.url} alt={file.path} />
        </span>
      </div>
    )
  }
  return (
    <div className="ImageDiff ImageDiff--modes">
      {mode === '2-up' && <TwoUp before={before} after={after} path={file.path} />}
      {mode === 'swipe' && <Swipe before={before} after={after} path={file.path} />}
      {mode === 'onion' && <OnionSkin before={before} after={after} path={file.path} />}
      <div className="ImageDiff-modes" role="radiogroup" aria-label="Image view">
        {MODES.map(([key, label]) => (
          <button key={key} type="button" role="radio" aria-checked={mode === key} className="ImageDiff-mode" onClick={() => setMode(key)}>
            {label}
          </button>
        ))}
      </div>
    </div>
  )
}

type Pair = { before: Loaded; after: Loaded; path: string }

function TwoUp({ before, after, path }: Pair) {
  return (
    <div className="ImageDiff-twoUp">
      <span className="ImageDiff-label ImageDiff-label--deleted">Deleted</span>
      <span className="ImageDiff-label ImageDiff-label--added">Added</span>
      <span className="ImageDiff-frame ImageDiff-frame--deleted">
        <img src={before.url} alt={`${path} (before)`} />
      </span>
      <span className="ImageDiff-frame ImageDiff-frame--added">
        <img src={after.url} alt={`${path} (after)`} />
      </span>
      <Size image={before} />
      <Size image={after} />
    </div>
  )
}

function Size({ image }: { image: Loaded }) {
  return (
    <p className="ImageDiff-meta">
      <strong>W:</strong> {image.width}px | <strong>H:</strong> {image.height}px
    </p>
  )
}

/** Both images on one scale, fitted to the width available (at most 846px, never enlarged). */
function useStack(before: Loaded, after: Loaded) {
  const [ref, available] = useWidth()
  const width = Math.max(before.width, after.width)
  const height = Math.max(before.height, after.height)
  // 4px: the frame's and the image's borders.
  const scale = Math.min(1, Math.min(STACK_MAX, Math.max(available - 4, 1)) / width)
  const size = (img: Loaded) => ({ width: Math.round(img.width * scale), height: Math.round(img.height * scale) })
  return { ref, box: { width: Math.round(width * scale) + 4, height: Math.round(height * scale) + 4 }, size }
}

function Swipe({ before, after, path }: Pair) {
  const { ref, box, size } = useStack(before, after)
  // Where the added image starts, from the left (0: all of it shows).
  const [at, setAt] = useState(0)
  const stack = useRef<HTMLDivElement>(null)
  const moveTo = (clientX: number) => {
    const r = stack.current!.getBoundingClientRect()
    setAt(Math.min(1, Math.max(0, (clientX - r.left) / r.width)))
  }
  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    moveTo(e.clientX)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    const step = e.key === 'ArrowLeft' ? -0.05 : e.key === 'ArrowRight' ? 0.05 : 0
    if (!step) return
    e.preventDefault()
    setAt((v) => Math.min(1, Math.max(0, v + step)))
  }
  return (
    <div ref={ref} className="ImageDiff-view">
      <div
        ref={stack}
        className="ImageDiff-stack ImageDiff-swipe"
        style={box}
        onPointerDown={onPointerDown}
        onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && moveTo(e.clientX)}
      >
        <span className="ImageDiff-frame ImageDiff-frame--deleted">
          <img src={before.url} alt={`${path} (before)`} style={size(before)} draggable={false} />
        </span>
        <span className="ImageDiff-swipeShell" style={{ width: `${(1 - at) * 100}%` }}>
          <span className="ImageDiff-frame ImageDiff-frame--added">
            <img src={after.url} alt={`${path} (after)`} style={size(after)} draggable={false} />
          </span>
        </span>
        <span
          className="ImageDiff-swipeBar"
          style={{ left: `${at * 100}%` }}
          role="slider"
          tabIndex={0}
          aria-label="Swipe between the deleted and the added image"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(at * 100)}
          onKeyDown={onKeyDown}
        >
          <span className="ImageDiff-handle ImageDiff-handle--top" />
          <span className="ImageDiff-handle ImageDiff-handle--bottom" />
        </span>
      </div>
    </div>
  )
}

function OnionSkin({ before, after, path }: Pair) {
  const { ref, box, size } = useStack(before, after)
  const [opacity, setOpacity] = useState(100)
  return (
    <div ref={ref} className="ImageDiff-view">
      <div className="ImageDiff-stack" style={box}>
        <span className="ImageDiff-frame ImageDiff-frame--deleted">
          <img src={before.url} alt={`${path} (before)`} style={size(before)} />
        </span>
        <span className="ImageDiff-frame ImageDiff-frame--added" style={{ opacity: opacity / 100 }}>
          <img src={after.url} alt={`${path} (after)`} style={size(after)} />
        </span>
      </div>
      <div className="ImageDiff-onion">
        <span className="ImageDiff-transparent" aria-hidden />
        <input
          type="range"
          min={0}
          max={100}
          value={opacity}
          aria-label="Opacity of the added image"
          onChange={(e) => setOpacity(Number(e.target.value))}
        />
        <span className="ImageDiff-opaque" aria-hidden />
      </div>
    </div>
  )
}
