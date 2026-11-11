import type { ReviewResult, Snapshot } from './types'
import { extOf } from './diff/util'

const FENCE_LANG: Record<string, string> = {
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.java': 'java',
  '.ts': 'ts',
  '.tsx': 'tsx',
  '.js': 'js',
  '.jsx': 'jsx',
  '.py': 'python',
  '.rs': 'rust',
  '.go': 'go',
  '.swift': 'swift',
  '.rb': 'ruby',
  '.md': 'markdown',
  '.json': 'json',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.sh': 'bash',
  '.css': 'css',
  '.html': 'html',
  '.xml': 'xml',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.cs': 'csharp',
  '.php': 'php',
}

const HEADLINE: Record<ReviewResult['event'], string> = {
  COMMENT: 'Review comments',
  REQUEST_CHANGES: 'Changes requested',
  CONFIRM: 'Confirmed',
}

/** Human- and agent-readable review summary printed by `gh-prv-local` on exit. */
export function formatReview(r: ReviewResult, s: Snapshot): string {
  const out: string[] = []
  const n = r.comments.length
  out.push(`# Pull request preview: ${HEADLINE[r.event]}`)
  out.push('')
  out.push(
    `\`${r.head.name}\` (${r.head.sha.slice(0, 7)}) → \`${r.base.name}\` (merge-base ${r.mergeBase.slice(0, 7)}) · ` +
      `${s.files.length} file${s.files.length === 1 ? '' : 's'} · ${n} comment${n === 1 ? '' : 's'}`,
  )
  out.push('')
  if (r.event === 'CONFIRM') {
    if (r.publish) {
      out.push(
        r.publish.created
          ? `The reviewer confirmed the changes. Branch \`${r.head.name}\` was pushed and a ${r.publish.draft ? 'draft ' : ''}pull request was opened: ${r.publish.url}`
          : `The reviewer confirmed the changes. Branch \`${r.head.name}\` was pushed to the existing pull request: ${r.publish.url}`,
      )
    } else out.push('The reviewer confirmed the changes.')
  } else if (r.event === 'REQUEST_CHANGES') {
    out.push('The reviewer requested changes. Address every comment below, then run `gh-prv-local` again to request another review.')
  } else {
    out.push('The reviewer left comments. Consider each one; reply in your summary if you decide not to change something.')
  }
  if (r.body.trim()) {
    out.push('', '## Review summary', '', r.body.trim())
  }
  if (n) {
    out.push('', '## Comments')
    r.comments.forEach((c, i) => {
      const at = c.view ? ` in commit range ${c.view}` : c.commit !== r.head.sha ? ` at commit ${c.commit.slice(0, 7)}` : ''
      if (c.line === 0) out.push('', `### ${i + 1}. \`${c.path}\` (whole file)${at}`)
      else {
        const lines = c.startLine && c.startLine !== c.line ? `lines ${c.startLine}-${c.line}` : `line ${c.line}`
        const side = c.side === 'LEFT' ? 'old/deleted side' : 'new side'
        out.push('', `### ${i + 1}. \`${c.path}\` ${lines} (${side})${at}`)
      }
      if (c.snippet.length) {
        const lang = FENCE_LANG[extOf(c.path)] ?? ''
        const allSame = c.snippet.every((l) => l[0] === ' ')
        // The fence must be longer than any backtick run inside the snippet.
        const longest = Math.max(0, ...c.snippet.flatMap((l) => (l.match(/`+/g) ?? []).map((m) => m.length)))
        const fence = '`'.repeat(Math.max(3, longest + 1))
        out.push(fence + (allSame ? lang : 'diff'))
        for (const l of c.snippet) out.push(allSame ? l.slice(1) : l)
        out.push(fence)
      }
      out.push('', c.body.trim())
    })
  }
  out.push('')
  return out.join('\n')
}
