import { useMemo, useState } from 'react'
import {
  ChevronDownIcon,
  ChevronRightIcon,
  DiffAddedIcon,
  DiffModifiedIcon,
  DiffRemovedIcon,
  DiffRenamedIcon,
  FileDirectoryFillIcon,
  FileIcon,
  SearchIcon,
} from '@primer/octicons-react'
import { useStore } from '../store'
import { buildTree, type TreeNode } from '../diff/tree'
import type { FileDiff } from '../types'
import { viewedKey } from '../diff/util'
import { scrollToFile } from './Toolbar'

export function StatusIcon({ f }: { f: FileDiff }) {
  switch (f.status) {
    case 'added':
      return <DiffAddedIcon size={16} fill="var(--fgColor-success)" aria-label="added" />
    case 'deleted':
      return <DiffRemovedIcon size={16} fill="var(--fgColor-danger)" aria-label="deleted" />
    case 'renamed':
    case 'copied':
      return <DiffRenamedIcon size={16} fill="var(--fgColor-muted)" aria-label="renamed" />
    default:
      return <DiffModifiedIcon size={16} fill="var(--fgColor-attention)" aria-label="modified" />
  }
}

export function FileTree({ files }: { files: FileDiff[] }) {
  const text = useStore((st) => st.filter.text)
  const setFilter = useStore((st) => st.setFilter)
  const viewed = useStore((st) => st.viewed)
  const [closed, setClosed] = useState<Record<string, boolean>>({})
  const [active, setActive] = useState<string | null>(null)
  const shown = useMemo(() => {
    const q = text.trim().toLowerCase()
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files
  }, [files, text])
  const tree = useMemo(() => buildTree(shown), [shown])

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((n) => {
      if (n.file) {
        const f = n.file
        const isViewed = viewed[f.path] === viewedKey(f)
        return (
          <li key={n.path} role="treeitem" aria-level={depth + 1}>
            <a
              href={`#${f.path}`}
              className={`ActionList-content ${active === f.path ? 'is-active' : ''}`}
              style={{ ['--depth' as string]: depth }}
              title={f.path}
              onClick={(e) => {
                e.preventDefault()
                setActive(f.path)
                useStore.getState().toggleCollapsed(f.path, false)
                requestAnimationFrame(() => scrollToFile(f.path))
              }}
            >
              <span className="ActionList-spacer" />
              <FileIcon size={16} fill="var(--fgColor-muted)" />
              <span className={`ActionList-item-label ${isViewed ? 'viewed' : ''}`}>{n.name}</span>
              <StatusIcon f={f} />
            </a>
          </li>
        )
      }
      const isClosed = closed[n.path]
      return (
        <li key={n.path} role="treeitem" aria-level={depth + 1} aria-expanded={!isClosed}>
          <button
            type="button"
            className="ActionList-content"
            style={{ ['--depth' as string]: depth }}
            title={n.name}
            onClick={() => setClosed((c) => ({ ...c, [n.path]: !c[n.path] }))}
          >
            <span className="ActionList-chevron">{isClosed ? <ChevronRightIcon size={16} /> : <ChevronDownIcon size={16} />}</span>
            <FileDirectoryFillIcon size={16} className="icon-directory" fill="var(--treeViewItem-leadingVisual-iconColor-rest, #54aeff)" />
            <span className="ActionList-item-label">{n.name}</span>
            <span />
          </button>
          {!isClosed && (
            <ul role="group" style={{ ['--depth' as string]: depth }}>
              {render(n.children, depth + 1)}
            </ul>
          )}
        </li>
      )
    })

  return (
    <nav aria-label="File Tree Navigation">
      <div className="tree-filter">
        <SearchIcon size={16} />
        <input
          type="text"
          placeholder="Filter changed files"
          aria-label="Filter changed files"
          value={text}
          onChange={(e) => setFilter({ text: e.target.value })}
        />
      </div>
      {tree.length === 0 ? (
        <div className="tree-empty">No files match.</div>
      ) : (
        <ul className="ActionList--tree" role="tree" aria-label="File Tree">
          {render(tree, 0)}
        </ul>
      )}
    </nav>
  )
}
