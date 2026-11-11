/// <reference lib="webworker" />
// Syntax highlighting with starry-night: the same TextMate grammars (linguist)
// and the same `pl-*` classes GitHub uses. Runs off the main thread.

import { createStarryNight, common } from '@wooorm/starry-night'
import onigUrl from 'vscode-oniguruma/release/onig.wasm?url'
import type { Run } from './highlight'
import { stripCr } from './parse'

interface Req {
  id: number
  content: string
  path: string
}

let sn: Awaited<ReturnType<typeof createStarryNight>> | null = null
const ready = createStarryNight(common, {
  getOnigurumaUrlFetch: () => new URL(onigUrl, self.location.href),
}).then((s) => (sn = s))

const NAME_FLAGS: Record<string, string> = {
  makefile: 'makefile',
  gnumakefile: 'makefile',
  dockerfile: 'shell',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  '.bashrc': 'shell',
  '.zshrc': 'shell',
  'cmakelists.txt': 'makefile',
}

const EXT_ALIASES: Record<string, string> = {
  '.kts': '.kt',
  '.gradle': '.kt',
  '.mjs': '.js',
  '.cjs': '.js',
  '.mts': '.ts',
  '.cts': '.ts',
  '.jsx': '.js',
  '.yml': '.yaml',
  '.h': '.c',
  '.hpp': '.cpp',
  '.mm': '.m',
  '.zsh': '.sh',
  '.bash': '.sh',
  '.properties': '.ini',
  '.toml': '.ini',
  '.svg': '.xml',
}

function scopeFor(path: string): string | undefined {
  if (!sn) return undefined
  const base = path.split('/').pop()!.toLowerCase()
  if (NAME_FLAGS[base]) return sn.flagToScope(NAME_FLAGS[base])
  const dot = base.lastIndexOf('.')
  if (dot < 0) return undefined
  let ext = base.slice(dot)
  ext = EXT_ALIASES[ext] ?? ext
  return sn.flagToScope(ext) ?? sn.flagToScope(ext.slice(1))
}

interface HastNode {
  type: string
  value?: string
  properties?: { className?: string[] }
  children?: HastNode[]
}

function flatten(tree: HastNode): Run[][] {
  const lines: Run[][] = [[]]
  const walk = (node: HastNode, cls: string) => {
    if (node.type === 'text') {
      const parts = (node.value ?? '').split('\n')
      parts.forEach((p, i) => {
        if (i > 0) lines.push([])
        if (p) lines[lines.length - 1].push([stripCr(p), cls])
      })
      return
    }
    let next = cls
    if (node.type === 'element') {
      const c = (node.properties?.className ?? []).join(' ')
      if (c) next = cls ? `${cls}|${c}` : c
    }
    for (const ch of node.children ?? []) walk(ch, next)
  }
  walk(tree, '')
  return lines
}

self.onmessage = async (e: MessageEvent<Req>) => {
  const { id, content, path } = e.data
  try {
    await ready
    const scope = scopeFor(path)
    if (!scope || content.length > 1_000_000) {
      self.postMessage({ id, lines: null })
      return
    }
    const tree = sn!.highlight(content, scope) as unknown as HastNode
    self.postMessage({ id, lines: flatten(tree) })
  } catch (err) {
    self.postMessage({ id, lines: null, error: String(err) })
  }
}
