import type { FileDiff } from '../types'

export interface TreeNode {
  name: string
  path: string
  children: TreeNode[]
  file?: FileDiff
}

/** Builds the file tree with single-child directories compacted (`a/b/c`). */
export function buildTree(files: FileDiff[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] }
  for (const f of files) {
    const parts = f.path.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const p = parts.slice(0, i + 1).join('/')
      let child = node.children.find((c) => !c.file && c.path === p)
      if (!child) {
        child = { name: parts[i], path: p, children: [] }
        node.children.push(child)
      }
      node = child
    }
    node.children.push({ name: parts[parts.length - 1], path: f.path, children: [], file: f })
  }
  const compact = (n: TreeNode): TreeNode => {
    let cur = n
    while (!cur.file && cur.children.length === 1 && !cur.children[0].file) {
      const only = cur.children[0]
      cur = { name: `${cur.name}/${only.name}`, path: only.path, children: only.children }
    }
    return { ...cur, children: cur.children.map(compact) }
  }
  return root.children.map(compact)
}
