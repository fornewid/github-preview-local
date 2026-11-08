// Shared data model between the Rust core (serde, camelCase) and the UI.

export type FileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied' | 'typechange'

export interface RefInfo {
  /** Ref as passed to git, e.g. `origin/main` or `HEAD`. */
  ref: string
  /** Display name, e.g. `main` or `fix/126-intrinsic-measurements`. */
  name: string
  sha: string
}

export interface Commit {
  sha: string
  short: string
  author: string
  email: string
  /** ISO-8601 author date */
  date: string
  subject: string
  body: string
}

export interface FileDiff {
  path: string
  oldPath?: string | null
  status: FileStatus
  additions: number
  deletions: number
  binary: boolean
  generated: boolean
  submodule: boolean
  oldMode?: string | null
  newMode?: string | null
  /** Blob ids (empty for the working tree side). */
  oldSha?: string | null
  newSha?: string | null
  /** Hunks (from the first `@@`) of `git diff`. */
  patch: string
  /** Same, computed with `--ignore-all-space`. */
  patchW: string
  additionsW: number
  deletionsW: number
  /** True when the patch was not loaded because it is too large. */
  tooLarge: boolean
}

export interface ExistingPr {
  number: number
  url: string
  state: string
}

export interface Snapshot {
  repo: {
    name: string
    owner?: string | null
    root: string
    remoteUrl?: string | null
    host?: string | null
  }
  base: RefInfo
  head: RefInfo
  mergeBase: string
  /** Commit range currently shown (all commits when both are null). */
  range: { from?: string | null; to?: string | null }
  author: string
  title: string
  body: string
  commits: Commit[]
  files: FileDiff[]
  /** `committed` = merge-base...HEAD, `worktree` = merge-base vs working tree */
  mode: 'committed' | 'worktree'
  dirty: boolean
  warnings: string[]
  editorconfig?: string | null
  existingPr?: ExistingPr | null
  generatedAt: string
}

export type Side = 'LEFT' | 'RIGHT'

export interface ReviewComment {
  id: string
  path: string
  side: Side
  /** End line (inclusive) on `side`. */
  line: number
  /** Start line for multi-line comments. */
  startLine?: number | null
  body: string
  createdAt: string
  /** Lines the comment refers to, prefixed with ` `, `+` or `-`. */
  snippet: string[]
  /** Commit the comment was made against (HEAD, or the last commit of a range). */
  commit: string
  /** Commit range the comment was made in (`from..to`); empty for "all changes". */
  view?: string | null
}

export interface PersistedState {
  /** path -> key (oldSha:newSha) at the time it was marked viewed */
  viewed: Record<string, string>
  drafts: ReviewComment[]
  prTitle?: string | null
  prBody?: string | null
}

export type ReviewEvent = 'COMMENT' | 'REQUEST_CHANGES' | 'CONFIRM'

export interface ReviewResult {
  event: ReviewEvent
  body: string
  comments: ReviewComment[]
  base: RefInfo
  head: RefInfo
  mergeBase: string
  publish?: { url: string; created: boolean; draft: boolean } | null
}

export type CheckStatus = 'idle' | 'queued' | 'running' | 'success' | 'failure' | 'cancelled'

export interface CheckDef {
  name: string
  run: string
  source: string
  timeout?: number | null
}

export interface CheckState extends CheckDef {
  status: CheckStatus
  exitCode?: number | null
  startedAt?: string | null
  finishedAt?: string | null
  output: string
}

export interface PublishRequest {
  title: string
  body: string
  draft: boolean
}

export interface PublishResult {
  url: string
  created: boolean
  draft: boolean
  log: string
}
