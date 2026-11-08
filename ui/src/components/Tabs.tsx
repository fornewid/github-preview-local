import { useMemo, useState } from 'react'
import {
  CheckCircleFillIcon,
  CircleIcon,
  DotFillIcon,
  GitCommitIcon,
  GitPullRequestIcon,
  PlayIcon,
  StopIcon,
  SyncIcon,
  XCircleFillIcon,
  CommentIcon,
} from '@primer/octicons-react'
import { useStore } from '../store'
import { Avatar, CommentBox, CopyButton, Markdown } from './common'
import { longDate, plural, relativeTime } from '../diff/util'
import type { CheckState, CheckStatus } from '../types'

export function CheckStatusIcon({ status }: { status: CheckStatus }) {
  switch (status) {
    case 'success':
      return <CheckCircleFillIcon size={16} className="check-icon-success" fill="var(--fgColor-success)" />
    case 'failure':
      return <XCircleFillIcon size={16} className="check-icon-failure" fill="var(--fgColor-danger)" />
    case 'running':
      return <SyncIcon size={16} className="anim-rotate" fill="var(--fgColor-attention)" />
    case 'queued':
      return <DotFillIcon size={16} fill="var(--fgColor-attention)" />
    case 'cancelled':
      return <StopIcon size={16} fill="var(--fgColor-muted)" />
    default:
      return <CircleIcon size={16} fill="var(--fgColor-muted)" />
  }
}

export function ConversationTab() {
  const s = useStore((st) => st.snapshot)!
  const prBody = useStore((st) => st.prBody)
  const drafts = useStore((st) => st.drafts)
  const checks = useStore((st) => st.checks)
  const setPr = useStore((st) => st.setPr)
  const setTab = useStore((st) => st.setTab)
  const [editing, setEditing] = useState(false)
  const [body, setBody] = useState(prBody)
  const passed = checks.filter((c) => c.status === 'success').length
  const failed = checks.filter((c) => c.status === 'failure').length
  return (
    <div className="timeline">
      <div>
        <div className="timeline-comment">
          <span className="avatar-abs">
            <Avatar name={s.author} size={40} />
          </span>
          <div className="timeline-comment-header">
            <strong>{s.author}</strong> commented
            <span style={{ marginLeft: 'auto' }}>
              <span className="Label Label--secondary">Author</span>{' '}
              {!editing && (
                <button
                  type="button"
                  className="btn btn-sm btn-invisible"
                  onClick={() => {
                    setBody(prBody)
                    setEditing(true)
                  }}
                >
                  Edit
                </button>
              )}
            </span>
          </div>
          <div className="timeline-comment-body">
            {editing ? (
              <div className="comment-form" style={{ padding: 0 }}>
                <CommentBox value={body} onChange={setBody} autoFocus minHeight={200} />
                <div className="comment-form-actions">
                  <button type="button" className="btn btn-sm" onClick={() => setEditing(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm btn-primary"
                    onClick={() => {
                      setPr(null, body)
                      setEditing(false)
                    }}
                  >
                    Update comment
                  </button>
                </div>
              </div>
            ) : prBody.trim() ? (
              <Markdown source={prBody} />
            ) : (
              <span className="color-fg-muted">
                <em>No description provided.</em>
              </span>
            )}
          </div>
        </div>
        <div className="TimelineItem">
          <div className="TimelineItem-badge">
            <GitCommitIcon size={16} />
          </div>
          <div className="TimelineItem-body">
            <strong style={{ color: 'var(--fgColor-default)' }}>{s.author}</strong> added {plural(s.commits.length, 'commit')}
          </div>
        </div>
        {s.commits.map((c) => (
          <div key={c.sha} className="TimelineItem TimelineItem--condensed">
            <div className="TimelineItem-badge">
              <GitCommitIcon size={16} />
            </div>
            <div className="TimelineItem-body" style={{ display: 'flex', gap: 8 }}>
              <span style={{ color: 'var(--fgColor-default)', flex: 'auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {c.subject}
              </span>
              <code className="text-mono" style={{ fontSize: 12 }}>
                {c.short}
              </code>
            </div>
          </div>
        ))}
        {drafts.length > 0 && (
          <div className="TimelineItem">
            <div className="TimelineItem-badge">
              <CommentIcon size={16} />
            </div>
            <div className="TimelineItem-body">
              {plural(drafts.length, 'pending review comment')} ·{' '}
              <a href="#files" onClick={(e) => (e.preventDefault(), setTab('files'))}>
                view in Files changed
              </a>
            </div>
          </div>
        )}
        <div className="merge-box">
          <div className="row">
            <CheckStatusIcon status={failed ? 'failure' : checks.length && passed === checks.length ? 'success' : 'idle'} />
            <div>
              <h3>
                {checks.length === 0
                  ? 'No local checks configured'
                  : failed
                    ? `${plural(failed, 'check')} failed`
                    : passed === checks.length
                      ? 'All checks have passed'
                      : 'Some checks haven’t completed yet'}
              </h3>
              <div className="sub">
                {checks.length ? `${passed} successful, ${failed} failing, ${checks.length - passed - failed} not run` : 'Add a .prv.toml to define checks.'}
              </div>
            </div>
            <button type="button" className="btn btn-sm" style={{ marginLeft: 'auto' }} onClick={() => setTab('checks')}>
              Show checks
            </button>
          </div>
          <div className="row">
            <GitPullRequestIcon size={16} />
            <div>
              <h3>{s.existingPr ? `Pull request #${s.existingPr.number} is open` : 'Ready to open a pull request?'}</h3>
              <div className="sub">Use “Review changes → Confirm” on the Files changed tab to push and open the pull request.</div>
            </div>
          </div>
        </div>
      </div>
      <aside>
        <div className="sidebar-item">
          <h3>Base</h3>
          <span className="commit-ref">{s.base.name}</span> <span className="text-mono">{s.base.sha.slice(0, 7)}</span>
        </div>
        <div className="sidebar-item">
          <h3>Compare</h3>
          <span className="commit-ref">{s.head.name}</span> <span className="text-mono">{s.head.sha.slice(0, 7)}</span>
        </div>
        <div className="sidebar-item">
          <h3>Merge base</h3>
          <span className="text-mono">{s.mergeBase.slice(0, 7)}</span>
        </div>
        {s.warnings.map((w, i) => (
          <div key={i} className="flash flash-warn" style={{ fontSize: 12 }}>
            {w}
          </div>
        ))}
      </aside>
    </div>
  )
}

export function CommitsTab() {
  const s = useStore((st) => st.snapshot)!
  const groups = useMemo(() => {
    const m = new Map<string, typeof s.commits>()
    for (const c of [...s.commits].reverse()) {
      const k = longDate(c.date)
      m.set(k, [...(m.get(k) ?? []), c])
    }
    return [...m.entries()]
  }, [s.commits])
  if (!s.commits.length)
    return (
      <div className="Box blankslate">
        <h3>No commits</h3>
        <p>The head branch has no commits ahead of the base branch.</p>
      </div>
    )
  return (
    <div>
      {groups.map(([date, commits]) => (
        <div key={date}>
          <div className="commit-group-title">
            <GitCommitIcon size={16} /> Commits on {date}
          </div>
          <div className="Box">
            {commits.map((c) => (
              <div key={c.sha} className="Box-row commit-row">
                <div style={{ minWidth: 0, flex: 'auto' }}>
                  <div className="title">{c.subject}</div>
                  <div className="meta" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <Avatar name={c.author} size={16} />
                    <strong style={{ color: 'var(--fgColor-default)' }}>{c.author}</strong> committed {relativeTime(c.date)}
                  </div>
                </div>
                <span className="sha">{c.short}</span>
                <CopyButton text={c.sha} label="Copy full SHA" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

export function ChecksTab() {
  const checks = useStore((st) => st.checks)
  const checksError = useStore((st) => st.checksError)
  const transport = useStore((st) => st.transport)!
  const { runCheck, runAllChecks, cancelCheck } = useStore.getState()
  const [selected, setSelected] = useState<string | null>(null)
  if (!transport.capabilities.checks)
    return (
      <div className="Box blankslate">
        <h3>Local checks run in the native window</h3>
        <p>
          Open this preview with <code>prv</code> to run checks.
        </p>
      </div>
    )
  if (checksError)
    return (
      <div className="Box blankslate">
        <h3>Could not read the checks configuration</h3>
        <pre className="text-mono" style={{ textAlign: 'left', display: 'inline-block', fontSize: 12, whiteSpace: 'pre-wrap' }}>
          {checksError}
        </pre>
      </div>
    )
  if (!checks.length)
    return (
      <div className="Box blankslate">
        <h3>No checks found</h3>
        <p>
          Add <code>.prv.toml</code> to the repository root, for example:
        </p>
        <p style={{ fontSize: 12 }}>Checks run commands from this repository on your machine — only run them in repositories you trust.</p>
        <pre className="text-mono" style={{ textAlign: 'left', display: 'inline-block', fontSize: 12 }}>
          {'[[checks]]\nname = "lint"\nrun = "npm run lint"\n\n[[checks]]\nname = "test"\nrun = "./gradlew test"'}
        </pre>
      </div>
    )
  const cur: CheckState = checks.find((c) => c.name === selected) ?? checks[0]
  const running = checks.some((c) => c.status === 'running' || c.status === 'queued')
  return (
    <div className="checks-layout">
      <div>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <strong style={{ flex: 'auto' }}>Local checks</strong>
          <button type="button" className="btn btn-sm" disabled={running} onClick={() => void runAllChecks()}>
            <PlayIcon size={16} /> Run all
          </button>
        </div>
        <div className="check-list">
          {checks.map((c) => (
            <div
              key={c.name}
              className={`check-item ${cur.name === c.name ? 'selected' : ''}`}
              onClick={() => setSelected(c.name)}
            >
              <CheckStatusIcon status={c.status} />
              <span>{c.name}</span>
              <span className="src">{c.source}</span>
            </div>
          ))}
        </div>
      </div>
      <div className="CheckRun">
        <div className="CheckRun-header">
          <CheckStatusIcon status={cur.status} />
          <div style={{ flex: 'auto', minWidth: 0 }}>
            <h2>{cur.name}</h2>
            <div className="sub text-mono">$ {cur.run}</div>
          </div>
          {cur.status === 'running' || cur.status === 'queued' ? (
            <button type="button" className="btn btn-sm" onClick={() => void cancelCheck(cur.name)}>
              Cancel
            </button>
          ) : (
            <button type="button" className="btn btn-sm" disabled={running} onClick={() => void runCheck(cur.name)}>
              {cur.status === 'idle' ? 'Run' : 'Re-run'}
            </button>
          )}
        </div>
        <pre className="CheckRun-log">
          {cur.output || (cur.status === 'idle' ? 'This check has not run yet.' : '')}
          {cur.status === 'success' || cur.status === 'failure'
            ? `\n\nProcess exited with code ${cur.exitCode ?? '(killed)'}`
            : ''}
        </pre>
      </div>
    </div>
  )
}
