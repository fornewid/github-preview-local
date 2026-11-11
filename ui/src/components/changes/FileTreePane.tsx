import { memo, useEffect, useMemo, useState } from 'react'
import { FileAddedIcon, FileDiffIcon, FileMovedIcon, FileRemovedIcon, FilterIcon, SearchIcon } from '@primer/octicons-react'
import { ActionList, ActionMenu, CounterLabel, Dialog, IconButton, TextInput, TreeView } from '@primer/react'
import { useStore } from '../../store'
import { buildTree, type TreeNode } from '../../diff/tree'
import type { FileDiff } from '../../types'
import { anchorFor, extLabel, isViewed } from '../../diff/util'
import { revealFile } from './DiffEntry'

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

export function FileTreePane({ files, all, onNavigate }: { files: FileDiff[]; all: FileDiff[]; onNavigate?: () => void }) {
  const text = useStore((st) => st.filter.text)
  const exts = useStore((st) => st.filter.exts)
  const showViewed = useStore((st) => st.filter.showViewed)
  const setFilter = useStore((st) => st.setFilter)
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, text])
  const tree = useMemo(() => buildTree(shown), [shown])
  const current = useCurrentFile(useMemo(() => shown.map((f) => f.path), [shown]))
  const extCounts = useMemo(() => {
    const m = new Map<string, number>()
    for (const f of all) {
      const e = extLabel(f.path)
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

  return (
    <div className={`FileTree ${onNavigate ? 'FileTree--dialog' : ''}`} id="pr-file-tree">
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
            <TreeItems nodes={tree} current={current} onNavigate={onNavigate} />
          </TreeView>
        ) : (
          <div className="FileTree-empty">No files match the current filter.</div>
        )}
      </div>
    </div>
  )
}

/**
 * Tree items. Memoized, so scrolling (the current file) or marking a file viewed re-renders only
 * the items that changed: a directory gets `current` only while the current file is inside it.
 */
function TreeItems({ nodes, current, onNavigate }: { nodes: TreeNode[]; current: string | null; onNavigate?: () => void }) {
  return nodes.map((n) =>
    n.file ? (
      <FileItem key={n.path} file={n.file} name={n.name} current={current === n.path} onNavigate={onNavigate} />
    ) : (
      <DirItem key={n.path} node={n} current={current?.startsWith(n.path + '/') ? current : null} onNavigate={onNavigate} />
    ),
  )
}

const DirItem = memo(function DirItem({ node, current, onNavigate }: { node: TreeNode; current: string | null; onNavigate?: () => void }) {
  return (
    <TreeView.Item id={`tree-${node.path}`} defaultExpanded>
      <TreeView.LeadingVisual>
        <TreeView.DirectoryIcon />
      </TreeView.LeadingVisual>
      {node.name}
      <TreeView.SubTree>
        <TreeItems nodes={node.children} current={current} onNavigate={onNavigate} />
      </TreeView.SubTree>
    </TreeView.Item>
  )
})

const FileItem = memo(function FileItem({
  file,
  name,
  current,
  onNavigate,
}: {
  file: FileDiff
  name: string
  current: boolean
  onNavigate?: () => void
}) {
  const viewed = useStore((st) => isViewed(st.viewed, file))
  return (
    <TreeView.Item
      id={`tree-${file.path}`}
      className="FileTree-file"
      current={current}
      onSelect={() => {
        // In the dialog, it closes first, then the page scrolls to the file.
        onNavigate?.()
        revealFile(file.path)
      }}
    >
      <TreeView.LeadingVisual>
        <FileStatusIcon f={file} />
      </TreeView.LeadingVisual>
      <span className={`FileTree-name ${viewed ? 'is-viewed' : ''}`} title={file.path}>
        {name}
      </span>
    </TreeView.Item>
  )
})

const closeTreeDialog = () => useStore.getState().setTreeDialog(false)

/** Narrow windows: github.com opens the tree as a "Files" dialog from the left (fullscreen below 768px). */
export function FileTreeDialog({ files, all }: { files: FileDiff[]; all: FileDiff[] }) {
  return (
    <Dialog title="Files" width="xlarge" position={{ narrow: 'fullscreen', regular: 'left' }} onClose={closeTreeDialog} className="FileTreeDialog">
      <FileTreePane files={files} all={all} onNavigate={closeTreeDialog} />
    </Dialog>
  )
}
