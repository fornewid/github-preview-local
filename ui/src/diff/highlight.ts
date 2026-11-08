import HlWorker from './hl.worker?worker&inline'

/** A text run and its nested `pl-*` classes, nesting levels separated by `|`. */
export type Run = [text: string, cls: string]
export type HlLines = Run[][]

let worker: Worker | null = null
let seq = 0
const pending = new Map<number, (v: HlLines | null) => void>()

function getWorker() {
  if (!worker) {
    worker = new HlWorker()
    worker.onmessage = (e: MessageEvent<{ id: number; lines: HlLines | null; error?: string }>) => {
      if (e.data.error) console.warn('[prv] highlight failed:', e.data.error)
      pending.get(e.data.id)?.(e.data.lines)
      pending.delete(e.data.id)
    }
    worker.onerror = (e) => {
      console.warn('[prv] highlighter unavailable:', e.message)
      for (const r of pending.values()) r(null)
      pending.clear()
    }
  }
  return worker
}

export function highlightFile(content: string, path: string): Promise<HlLines | null> {
  const id = ++seq
  return new Promise((resolve) => {
    pending.set(id, resolve)
    getWorker().postMessage({ id, content, path })
  })
}
