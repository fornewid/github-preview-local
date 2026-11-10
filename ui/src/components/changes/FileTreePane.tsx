import { useEffect, useMemo, useState } from 'react'
import { FileAddedIcon, FileDiffIcon, FileMovedIcon, FileRemovedIcon, FilterIcon, SearchIcon } from '@primer/octicons-react'
import { ActionList, ActionMenu, CounterLabel, IconButton, TextInput, TreeView } from '@primer/react'
import { useStore } from '../../store'
import { buildTree, type TreeNode } from '../../diff/tree'
import type { FileDiff } from '../../types'
import { anchorFor, extOf, viewedKey } from '../../diff/util'
import { scrollToFile } from './Toolbar'

export function FileStatusIcon({ f }: { f: FileDiff }) {
  switch (f.status) {
    case 'added':
      return <FileAddedIcon size={16} className="fgColor-success" aria-label="added" />
    case 'deleted':
      return <FileRemovedIcon size={16} className="fgColor-danger" aria-label="deleted" />
    case 'renamed':
    case 'copied':
      return <FileMovedIcon size={16} className="fgColor-muted" aria-label="renamed" />
    default:
      return <FileDiffIcon size={16} className="fgColor-muted" aria-label="modified" />
  }
}

/** Tracks which file header is at the top of the viewport, for the tree's current item. */
function useCurrentFile(paths: string[]) {
  const [current, setCurrent] = useState<string | null>(null)
  useEffect(() => {
    let raf = 0
    const onScroll = () => {
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        let best: string | null = null
        for (const p of paths) {
          const el = document.getElementById(anchorFor(p))
          if (!el) continue
          if (el.getBoundingClientRect().top - 120 <= 0) best = p
          else break
        }
        setCurrent(best)
      })
    }
    onScroll()
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      window.removeEventListener('scroll', onScroll)
      cancelAnimationFrame(raf)
    }
  }, [paths])
  return current
}

export function FileTreePane({ files, all }: { files: FileDiff[]; all: FileDiff[] }) {
  const text = useStore((st) => st.filter.text)
  const exts = useStore((st) => st.filter.exts)
  const showViewed = useStore((st) => st.filter.showViewed)
  const setFilter = useStore((st) => st.setFilter)
  const viewed = useStore((st) => st.viewed)
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, text])
  const tree = useMemo(() => buildTree(shown), [shown])
  const current = useCurrentFile(useMemo(() => shown.map((f) => f.path), [shown]))
  const extCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of all) {
      const e = extOf(f.path) || 'No extension'
      m.set(e, (m.get(e) ?? 0) + 1)
    }
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [all])

  const toggleExt = (e: string) => {
    const allExts = extCounts.map(([k]) => k)
    const cur = exts ?? allExts
    const next = cur.includes(e) ? cur.filter((x) => x !== e) : [...cur, e]
    setFilter({ exts: next.length === allExts.length ? null : next })
  }

  const render = (nodes: TreeNode[]) =>
    nodes.map((n) => {
      if (n.file) {
        const f = n.file
        const isViewed = viewed[f.path] === viewedKey(f)
        return (
          <TreeView.Item
            key={n.path}
            id={`tree-${n.path}`}
            className="FileTree-file"
            current={current === f.path}
            onSelect={() => {
              useStore.getState().toggleCollapsed(f.path, false)
              scrollToFile(f.path)
            }}
          >
            <TreeView.LeadingVisual>
              <FileStatusIcon f={f} />
            </TreeView.LeadingVisual>
            <span className={`FileTree-name ${isViewed ? 'is-viewed' : ''}`} title={f.path}>
              {n.name}
            </span>
          </TreeView.Item>
        )
      }
      return (
        <TreeView.Item key={n.path} id={`tree-${n.path}`} defaultExpanded>
          <TreeView.LeadingVisual>
            <TreeView.DirectoryIcon />
          </TreeView.LeadingVisual>
          {n.name}
          <TreeView.SubTree>{render(n.children)}</TreeView.SubTree>
        </TreeView.Item>
      )
    })

  return (
    <div className="FileTree" id="pr-file-tree">
      <div className="FileTree-header">
        <TextInput
          id="file-tree-filter"
          className="FileTree-filter"
          leadingVisual={SearchIcon}
          aria-label="Filter files…"
          placeholder="Filter files…"
          value={text}
          onChange={(e) => setFilter({ text: e.target.value })}
        />
        <ActionMenu>
          <ActionMenu.Anchor>
            <IconButton icon={FilterIcon} aria-label="Filter options" className={`FileTree-filterButton ${exts || !showViewed ? 'is-active' : ''}`} />
          </ActionMenu.Anchor>
          <ActionMenu.Overlay>
            <ActionList>
              <ActionList.Group selectionVariant="single">
                <ActionList.GroupHeading>File extensions</ActionList.GroupHeading>
                {extCounts.map(([e, n]) => (
                  <ActionList.Item key={e} selected={!exts || exts.includes(e)} onSelect={() => toggleExt(e)}>
                    {e}
                    <ActionList.TrailingVisual>
                      <CounterLabel>{n}</CounterLabel>
                    </ActionList.TrailingVisual>
                  </ActionList.Item>
                ))}
              </ActionList.Group>
              <ActionList.Divider />
              <ActionList.Group selectionVariant="single">
                <ActionList.Item selected={showViewed} onSelect={() => setFilter({ showViewed: !showViewed })}>
                  Viewed files
                </ActionList.Item>
              </ActionList.Group>
            </ActionList>
          </ActionMenu.Overlay>
        </ActionMenu>
      </div>
      <div className="FileTree-scrollable">
        <h2 className="sr-only">File tree</h2>
        {tree.length ? (
          <TreeView aria-label="File Tree" className="FileTree-tree">
            {render(tree)}
          </TreeView>
        ) : (
          <div className="FileTree-empty">No files match the current filter.</div>
        )}
      </div>
    </div>
  )
}
