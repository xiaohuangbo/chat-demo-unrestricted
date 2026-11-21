import { unzlibSync, zlibSync } from 'fflate'
import { dirName, normalizePath, resolvePath, type NanovmFS } from './fs.js'

/**
 * NanoVM Slim 的 Git 实现。
 *
 * 不下载任何东西：对象格式按真 git 来（`"<type> <len>\0<content>"` → zlib），
 * 存在 `/.git/objects/xx/rest`；SHA-1 用 WebCrypto 算，refs / HEAD 也是真格式。
 * 只有索引为了简单用 `.git/index.json`，所以「系统 git 能读懂对象与提交历史，
 * 但读不懂这个仓库的工作区状态」是预期行为。
 *
 * 支持 init / status / add / rm / commit / log / diff / branch / checkout /
 * ls-files / rev-parse / config / help；其余子命令明确报错，不假装成功。
 */

/** `git --version` 报告的版本 */
export const GIT_VERSION = '2.7.7-nanovm'

/** 索引文件名（真实 git 的 index 是二进制，这里用 JSON 便于调试） */
const INDEX_FILE = 'index.json'

/** 对象类型 */
type ObjectType = 'blob' | 'tree' | 'commit'

export type GitIO = {
  fs: NanovmFS
  cwd: string
  env: Record<string, string>
  stdout: (text: string) => void
  stderr: (text: string) => void
  stdin: string
}

type Repo = {
  /** 仓库根目录（绝对路径） */
  root: string
  /** 绝对路径 /.git */
  gitDir: string
}

type IndexEntry = {
  path: string
  sha: string
  mode: string
  size: number
  mtime: number
}

type RepoIndex = {
  version: number
  entries: IndexEntry[]
}

type TreeEntry = { name: string; mode: string; sha: string }

type CommitInfo = {
  sha: string
  tree: string
  parents: string[]
  author: { name: string; email: string; time: number; timezone: string }
  committer: { name: string; email: string; time: number; timezone: string }
  message: string
}

/** 命令失败：带着 git 风格的文案与退出码往上抛 */
class GitFatal extends Error {
  readonly code: number

  constructor(message: string, code = 128) {
    super(message)
    this.name = 'GitFatal'
    this.code = code
  }
}

const fatal: (message: string, code?: number) => never = (message, code = 128) => {
  throw new GitFatal(`fatal: ${message}`, code)
}

// ---------- 小工具 ----------

const encoder = new TextEncoder()
const decoder = new TextDecoder()

const encode = (text: string): Uint8Array => encoder.encode(text)

const decode = (bytes: Uint8Array): string => decoder.decode(bytes)

const concatBytes = (head: Uint8Array, body: Uint8Array): Uint8Array => {
  const out = new Uint8Array(head.byteLength + body.byteLength)
  out.set(head, 0)
  out.set(body, head.byteLength)
  return out
}

const splitLines = (text: string): string[] => {
  const lines = text.split('\n')
  if (lines.at(-1) === '') {
    lines.pop()
  }
  return lines
}

const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`

const ensureDir = (fs: NanovmFS, path: string) => {
  try {
    fs.mkdir(path, true)
  } catch {
    // 已存在或父目录冲突：后面的写入会给出真正的错误
  }
}

const readTextFile = (fs: NanovmFS, path: string): string | null => {
  try {
    return fs.readText(path)
  } catch {
    return null
  }
}

const writeTextFile = (fs: NanovmFS, path: string, text: string) => {
  ensureDir(fs, dirName(path))
  fs.writeText(path, text)
}

const isBinary = (bytes: Uint8Array): boolean => bytes.includes(0)

/** WebCrypto 只收 ArrayBuffer 视图，顺手复制一份避免 subarray 的偏移陷阱 */
const toArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const sha1Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-1', toArrayBuffer(bytes))
  const view = new Uint8Array(digest)
  let hex = ''
  for (const byte of view) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

const timezoneOffset = (date: Date): string => {
  const minutes = -date.getTimezoneOffset()
  const sign = minutes >= 0 ? '+' : '-'
  const absolute = Math.abs(minutes)
  return `${sign}${String(Math.floor(absolute / 60)).padStart(2, '0')}${String(absolute % 60).padStart(2, '0')}`
}

const gitDate = (seconds: number, timezone: string): string => {
  const date = new Date(seconds * 1000)
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
  const months = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ]
  const pad = (value: number) => String(value).padStart(2, '0')
  return [
    days[date.getDay()],
    months[date.getMonth()],
    pad(date.getDate()),
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`,
    String(date.getFullYear()),
    timezone,
  ].join(' ')
}

// ---------- 仓库定位 ----------

const findRepo = (fs: NanovmFS, start: string): Repo | null => {
  let current = normalizePath(start)
  for (let depth = 0; depth < 64; depth += 1) {
    const gitDir = joinPath(current, '.git')
    if (fs.isDirectory(gitDir)) {
      return { root: current, gitDir }
    }
    if (current === '/') {
      return null
    }
    current = dirName(current)
  }
  return null
}

const requireRepo = (fs: NanovmFS, cwd: string): Repo => {
  const repo = findRepo(fs, cwd)
  if (!repo) {
    fatal('not a git repository (or any of the parent directories): .git')
  }
  return repo
}

/** 工作区绝对路径 → 仓库内相对路径 */
const repoRelative = (repo: Repo, absolute: string): string => {
  if (absolute === repo.root) {
    return ''
  }
  if (!absolute.startsWith(`${repo.root}/`)) {
    fatal(`'${absolute}' is outside repository`)
  }
  return absolute.slice(repo.root.length + 1)
}

const isInsideGitDir = (repo: Repo, absolute: string): boolean =>
  absolute === repo.gitDir || absolute.startsWith(`${repo.gitDir}/`)

// ---------- 引用 ----------

const readHead = (fs: NanovmFS, repo: Repo): { branch: string | null; sha: string | null } => {
  const head = readTextFile(fs, joinPath(repo.gitDir, 'HEAD'))?.trim() ?? ''
  if (head.startsWith('ref:')) {
    const ref = head.slice(4).trim()
    const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref
    const sha = readTextFile(fs, joinPath(repo.gitDir, ref))?.trim() || null
    return { branch, sha }
  }
  return { branch: null, sha: head || null }
}

const branchSha = (fs: NanovmFS, repo: Repo, branch: string): string | null =>
  readTextFile(fs, joinPath(repo.gitDir, `refs/heads/${branch}`))?.trim() || null

const listBranches = (fs: NanovmFS, repo: Repo): string[] => {
  const dir = joinPath(repo.gitDir, 'refs/heads')
  if (!fs.isDirectory(dir)) {
    return []
  }
  return fs
    .readdir(dir)
    .filter((entry) => entry.kind === 'file')
    .map((entry) => entry.name)
    .sort()
}

const writeBranch = (fs: NanovmFS, repo: Repo, branch: string, sha: string) => {
  writeTextFile(fs, joinPath(repo.gitDir, `refs/heads/${branch}`), `${sha}\n`)
}

const writeHeadRef = (fs: NanovmFS, repo: Repo, branch: string) => {
  writeTextFile(fs, joinPath(repo.gitDir, 'HEAD'), `ref: refs/heads/${branch}\n`)
}

// ---------- 对象 ----------

const objectPath = (repo: Repo, sha: string): string =>
  joinPath(repo.gitDir, `objects/${sha.slice(0, 2)}/${sha.slice(2)}`)

const writeObject = async (
  fs: NanovmFS,
  repo: Repo,
  type: ObjectType,
  body: Uint8Array
): Promise<string> => {
  const header = encode(`${type} ${body.byteLength}\u0000`)
  const payload = concatBytes(header, body)
  const sha = await sha1Hex(payload)
  const path = objectPath(repo, sha)
  ensureDir(fs, dirName(path))
  fs.write(path, zlibSync(payload, { level: 6 }))
  return sha
}

const writeBlob = async (fs: NanovmFS, repo: Repo, bytes: Uint8Array): Promise<string> =>
  writeObject(fs, repo, 'blob', bytes)

const readObject = (
  fs: NanovmFS,
  repo: Repo,
  sha: string
): { type: ObjectType; body: Uint8Array } | null => {
  const compressed = fs.read(objectPath(repo, sha))
  if (!compressed) {
    return null
  }
  let payload: Uint8Array
  try {
    payload = unzlibSync(compressed)
  } catch {
    return null
  }
  const nul = payload.indexOf(0)
  if (nul < 0) {
    return null
  }
  const header = decode(payload.subarray(0, nul))
  const space = header.indexOf(' ')
  if (space < 0) {
    return null
  }
  const type = header.slice(0, space) as ObjectType
  return { type, body: payload.subarray(nul + 1) }
}

/** 对象是否存在（用于校验 ref 是否指向真实对象） */
const objectExists = (fs: NanovmFS, repo: Repo, sha: string): boolean =>
  fs.exists(objectPath(repo, sha))

/** git 的树排序规则：目录按「名字 + /」参与比较 */
const treeSortKey = (entry: TreeEntry): Uint8Array =>
  encode(entry.mode === '40000' ? `${entry.name}/` : entry.name)

const compareBytes = (left: Uint8Array, right: Uint8Array): number => {
  const length = Math.min(left.length, right.length)
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] - right[index]
    }
  }
  return left.length - right.length
}

const encodeTree = (entries: TreeEntry[]): Uint8Array => {
  const chunks: Uint8Array[] = []
  for (const entry of entries) {
    chunks.push(encode(`${entry.mode} ${entry.name}\u0000`))
    const raw = new Uint8Array(20)
    for (let index = 0; index < 20; index += 1) {
      raw[index] = Number.parseInt(entry.sha.slice(index * 2, index * 2 + 2), 16)
    }
    chunks.push(raw)
  }
  let total = 0
  for (const chunk of chunks) {
    total += chunk.byteLength
  }
  const out = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

const decodeTree = (body: Uint8Array): TreeEntry[] => {
  const entries: TreeEntry[] = []
  let cursor = 0
  while (cursor < body.length) {
    let space = cursor
    while (space < body.length && body[space] !== 0x20) {
      space += 1
    }
    const mode = decode(body.subarray(cursor, space))
    let nul = space + 1
    while (nul < body.length && body[nul] !== 0) {
      nul += 1
    }
    const name = decode(body.subarray(space + 1, nul))
    const raw = body.subarray(nul + 1, nul + 21)
    if (raw.length < 20) {
      break
    }
    let sha = ''
    for (const byte of raw) {
      sha += byte.toString(16).padStart(2, '0')
    }
    entries.push({ name, mode, sha })
    cursor = nul + 21
  }
  return entries
}

/** 把一棵树摊平成 路径 → { sha, mode } */
const flattenTree = (fs: NanovmFS, repo: Repo, treeSha: string): Map<string, IndexEntry> => {
  const files = new Map<string, IndexEntry>()
  const walk = (sha: string, prefix: string) => {
    const object = readObject(fs, repo, sha)
    if (!object || object.type !== 'tree') {
      return
    }
    for (const entry of decodeTree(object.body)) {
      const path = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.mode === '40000') {
        walk(entry.sha, path)
      } else {
        files.set(path, { path, sha: entry.sha, mode: entry.mode, size: 0, mtime: 0 })
      }
    }
  }
  walk(treeSha, '')
  return files
}

/** 某个提交（或未出生分支的 null）里的全部文件 */
const flattenCommit = (
  fs: NanovmFS,
  repo: Repo,
  commitSha: string | null
): Map<string, IndexEntry> => {
  if (!commitSha) {
    return new Map<string, IndexEntry>()
  }
  const commit = readCommit(fs, repo, commitSha)
  if (!commit) {
    return new Map<string, IndexEntry>()
  }
  return flattenTree(fs, repo, commit.tree)
}

/** 从索引写出一棵（可复用的）树；目录自下而上生成 */
const buildTree = async (fs: NanovmFS, repo: Repo, entries: IndexEntry[]): Promise<string> => {
  type DirNode = { files: TreeEntry[]; dirs: Map<string, DirNode> }
  const root: DirNode = { files: [], dirs: new Map() }
  for (const entry of entries) {
    const segments = entry.path.split('/')
    let node = root
    for (const segment of segments.slice(0, -1)) {
      let next = node.dirs.get(segment)
      if (!next) {
        next = { files: [], dirs: new Map() }
        node.dirs.set(segment, next)
      }
      node = next
    }
    node.files.push({ name: segments[segments.length - 1], mode: entry.mode, sha: entry.sha })
  }
  const writeNode = async (node: DirNode): Promise<string> => {
    const treeEntries: TreeEntry[] = [...node.files]
    for (const [name, child] of node.dirs) {
      treeEntries.push({ name, mode: '40000', sha: await writeNode(child) })
    }
    treeEntries.sort((left, right) => compareBytes(treeSortKey(left), treeSortKey(right)))
    return writeObject(fs, repo, 'tree', encodeTree(treeEntries))
  }
  return writeNode(root)
}

const parseCommit = (sha: string, body: Uint8Array): CommitInfo => {
  const text = decode(body)
  const separator = text.indexOf('\n\n')
  const head = separator >= 0 ? text.slice(0, separator) : text
  const message = separator >= 0 ? text.slice(separator + 2) : ''
  let tree = ''
  const parents: string[] = []
  let author: CommitInfo['author'] = { name: '', email: '', time: 0, timezone: '+0000' }
  let committer: CommitInfo['committer'] = { name: '', email: '', time: 0, timezone: '+0000' }
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) {
      tree = line.slice(5).trim()
      continue
    }
    if (line.startsWith('parent ')) {
      parents.push(line.slice(7).trim())
      continue
    }
    if (line.startsWith('author ') || line.startsWith('committer ')) {
      const payload = line.slice(line.indexOf(' ') + 1)
      const match = /^(.*) <(.*)> (\d+) ([+-]\d{4})$/.exec(payload)
      const identity = {
        name: match?.[1] ?? 'Unknown',
        email: match?.[2] ?? 'unknown',
        time: match ? Number(match[3]) : 0,
        timezone: match?.[4] ?? '+0000',
      }
      if (line.startsWith('author ')) {
        author = identity
      } else {
        committer = identity
      }
    }
  }
  return { sha, tree, parents, author, committer, message }
}

const readCommit = (fs: NanovmFS, repo: Repo, sha: string): CommitInfo | null => {
  const object = readObject(fs, repo, sha)
  if (!object || object.type !== 'commit') {
    return null
  }
  return parseCommit(sha, object.body)
}

// ---------- 索引 ----------

const readIndex = (fs: NanovmFS, repo: Repo): RepoIndex => {
  const text = readTextFile(fs, joinPath(repo.gitDir, INDEX_FILE))
  if (!text) {
    return { version: 1, entries: [] }
  }
  try {
    const parsed = JSON.parse(text) as Partial<RepoIndex>
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.filter(
          (entry): entry is IndexEntry =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as IndexEntry).path === 'string' &&
            typeof (entry as IndexEntry).sha === 'string'
        )
      : []
    return { version: 1, entries }
  } catch {
    return { version: 1, entries: [] }
  }
}

const writeIndex = (fs: NanovmFS, repo: Repo, entries: IndexEntry[]) => {
  const sorted = [...entries].sort((left, right) => left.path.localeCompare(right.path))
  writeTextFile(
    fs,
    joinPath(repo.gitDir, INDEX_FILE),
    `${JSON.stringify({ version: 1, entries: sorted }, null, 2)}\n`
  )
}

const indexMap = (index: RepoIndex): Map<string, IndexEntry> => {
  const map = new Map<string, IndexEntry>()
  for (const entry of index.entries) {
    map.set(entry.path, entry)
  }
  return map
}

// ---------- 工作区扫描 ----------

/** 列出一个目录下的所有工作区文件（相对仓库根，跳过 .git） */
const scanWorktree = (fs: NanovmFS, repo: Repo, absolute: string): IndexEntry[] => {
  const found: IndexEntry[] = []
  const walk = (path: string) => {
    if (isInsideGitDir(repo, path)) {
      return
    }
    const stat = fs.stat(path)
    if (!stat) {
      return
    }
    if (stat.kind === 'file') {
      const bytes = fs.read(path) ?? new Uint8Array(0)
      found.push({
        path: repoRelative(repo, path),
        sha: '',
        mode: '100644',
        size: bytes.byteLength,
        mtime: stat.mtime,
      })
      return
    }
    for (const entry of fs.readdir(path)) {
      walk(joinPath(path, entry.name))
    }
  }
  walk(absolute)
  return found
}

/** 计算工作区某个文件的 sha（不落盘，只用于比较） */
const hashWorktreeFile = async (fs: NanovmFS, repo: Repo, path: string): Promise<string | null> => {
  const absolute = joinPath(repo.root, path)
  const bytes = fs.read(absolute)
  if (!bytes) {
    return null
  }
  const header = encode(`blob ${bytes.byteLength}\u0000`)
  return sha1Hex(concatBytes(header, bytes))
}

// ---------- diff ----------

type DiffLine = { kind: 'context' | 'add' | 'del'; text: string; oldLine: number; newLine: number }

/** 行级 LCS；超过阈值退化成整体替换，避免长文件把页面卡住 */
const lcsDiff = (left: string[], right: string[]): DiffLine[] => {
  const n = left.length
  const m = right.length
  const out: DiffLine[] = []
  if (n * m > 250_000) {
    left.forEach((text, index) => {
      out.push({ kind: 'del', text, oldLine: index + 1, newLine: 0 })
    })
    right.forEach((text, index) => {
      out.push({ kind: 'add', text, oldLine: 0, newLine: index + 1 })
    })
    return out
  }
  const width = m + 1
  const table = new Int32Array((n + 1) * width)
  for (let row = n - 1; row >= 0; row -= 1) {
    for (let column = m - 1; column >= 0; column -= 1) {
      table[row * width + column] =
        left[row] === right[column]
          ? table[(row + 1) * width + column + 1] + 1
          : Math.max(table[(row + 1) * width + column], table[row * width + column + 1])
    }
  }
  let row = 0
  let column = 0
  while (row < n && column < m) {
    if (left[row] === right[column]) {
      out.push({ kind: 'context', text: left[row], oldLine: row + 1, newLine: column + 1 })
      row += 1
      column += 1
    } else if (table[(row + 1) * width + column] >= table[row * width + column + 1]) {
      out.push({ kind: 'del', text: left[row], oldLine: row + 1, newLine: 0 })
      row += 1
    } else {
      out.push({ kind: 'add', text: right[column], oldLine: 0, newLine: column + 1 })
      column += 1
    }
  }
  while (row < n) {
    out.push({ kind: 'del', text: left[row], oldLine: row + 1, newLine: 0 })
    row += 1
  }
  while (column < m) {
    out.push({ kind: 'add', text: right[column], oldLine: 0, newLine: column + 1 })
    column += 1
  }
  return out
}

const formatHunks = (lines: DiffLine[], context = 3): string[] => {
  const out: string[] = []
  const changed = lines
    .map((line, index) => (line.kind === 'context' ? -1 : index))
    .filter((index) => index >= 0)
  if (changed.length === 0) {
    return out
  }
  const ranges: [number, number][] = []
  for (const index of changed) {
    const start = Math.max(0, index - context)
    const end = Math.min(lines.length - 1, index + context)
    const last = ranges.at(-1)
    if (last && start <= last[1] + 1) {
      last[1] = Math.max(last[1], end)
    } else {
      ranges.push([start, end])
    }
  }
  for (const [start, end] of ranges) {
    const slice = lines.slice(start, end + 1)
    const oldCount = slice.filter((line) => line.kind !== 'add').length
    const newCount = slice.filter((line) => line.kind !== 'del').length
    const oldStart = slice.find((line) => line.kind !== 'add')?.oldLine ?? 1
    const newStart = slice.find((line) => line.kind !== 'del')?.newLine ?? 1
    out.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`)
    for (const line of slice) {
      const prefix = line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '
      out.push(`${prefix}${line.text}`)
    }
  }
  return out
}

const countChanges = (lines: DiffLine[]): { insertions: number; deletions: number } => {
  let insertions = 0
  let deletions = 0
  for (const line of lines) {
    if (line.kind === 'add') {
      insertions += 1
    }
    if (line.kind === 'del') {
      deletions += 1
    }
  }
  return { insertions, deletions }
}

const diffText = (
  path: string,
  before: { text: string; binary: boolean } | null,
  after: { text: string; binary: boolean } | null
): string[] => {
  if (before?.binary || after?.binary) {
    return [`diff --git a/${path} b/${path}`, `Binary files a/${path} and b/${path} differ`]
  }
  const oldLines = before ? splitLines(before.text) : []
  const newLines = after ? splitLines(after.text) : []
  const hunks = formatHunks(lcsDiff(oldLines, newLines))
  if (hunks.length === 0) {
    return []
  }
  const out = [`diff --git a/${path} b/${path}`]
  if (!before) {
    out.push('new file mode 100644')
    out.push('--- /dev/null')
    out.push(`+++ b/${path}`)
  } else if (!after) {
    out.push('deleted file mode 100644')
    out.push(`--- a/${path}`)
    out.push('+++ /dev/null')
  } else {
    out.push(`--- a/${path}`)
    out.push(`+++ b/${path}`)
  }
  out.push(...hunks)
  return out
}

// ---------- 配置 ----------

type RepoConfig = {
  user: { name: string; email: string }
}

const DEFAULT_CONFIG: RepoConfig = {
  user: { name: 'NanoVM User', email: 'user@nanovm.local' },
}

const readConfig = (fs: NanovmFS, repo: Repo): RepoConfig => {
  const text = readTextFile(fs, joinPath(repo.gitDir, 'config.json'))
  if (!text) {
    return { user: { ...DEFAULT_CONFIG.user } }
  }
  try {
    const parsed = JSON.parse(text) as Partial<RepoConfig>
    return {
      user: {
        name: parsed.user?.name || DEFAULT_CONFIG.user.name,
        email: parsed.user?.email || DEFAULT_CONFIG.user.email,
      },
    }
  } catch {
    return { user: { ...DEFAULT_CONFIG.user } }
  }
}

const writeConfig = (fs: NanovmFS, repo: Repo, config: RepoConfig) => {
  writeTextFile(fs, joinPath(repo.gitDir, 'config.json'), `${JSON.stringify(config, null, 2)}\n`)
}

const identity = (fs: NanovmFS, repo: Repo, env: Record<string, string>) => {
  const config = readConfig(fs, repo)
  const now = new Date()
  const time = Math.floor(now.getTime() / 1000)
  return {
    name: env.GIT_AUTHOR_NAME || config.user.name,
    email: env.GIT_AUTHOR_EMAIL || config.user.email,
    time,
    timezone: timezoneOffset(now),
  }
}

// ---------- 子命令 ----------

type CommandContext = {
  fs: NanovmFS
  repo: Repo
  io: GitIO
  index: RepoIndex
}

const commandInit = async (io: GitIO, args: string[]): Promise<number> => {
  const fs = io.fs
  let target = io.cwd
  let branch = 'main'
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-b' || arg === '--initial-branch') {
      branch = args[index + 1] ?? branch
      index += 1
      continue
    }
    if (arg === '--bare') {
      fatal('NanoVM git 不支持 --bare 仓库')
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    target = resolvePath(io.cwd, arg)
  }
  if (!fs.isDirectory(target)) {
    // 真 git 会 mkdir -p，这里保持一致
    try {
      fs.mkdir(target, true)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      fatal(`cannot mkdir '${target}': ${message}`)
    }
  }
  const gitDir = joinPath(target, '.git')
  const existed = fs.isDirectory(gitDir)
  ensureDir(fs, joinPath(gitDir, 'objects'))
  ensureDir(fs, joinPath(gitDir, 'objects/info'))
  ensureDir(fs, joinPath(gitDir, 'objects/pack'))
  ensureDir(fs, joinPath(gitDir, 'refs'))
  ensureDir(fs, joinPath(gitDir, 'refs/heads'))
  ensureDir(fs, joinPath(gitDir, 'refs/tags'))
  ensureDir(fs, joinPath(gitDir, 'hooks'))
  if (!existed) {
    writeHeadRef(fs, { root: target, gitDir }, branch)
    writeConfig(fs, { root: target, gitDir }, { user: { ...DEFAULT_CONFIG.user } })
    writeTextFile(fs, joinPath(gitDir, 'description'), 'NanoVM Slim 虚拟仓库\n')
  }
  io.stdout(`${existed ? 'Reinitialized' : 'Initialized'} empty Git repository in ${gitDir}/\n`)
  io.stdout(`当前分支：${branch}（对象格式与真 git 一致，索引为 .git/index.json）\n`)
  return 0
}

type StatusEntry = {
  path: string
  indexState: ' ' | 'A' | 'M' | 'D'
  workState: ' ' | 'M' | 'D' | '?'
}

const collectStatus = async (context: CommandContext): Promise<StatusEntry[]> => {
  const { fs, repo, index } = context
  const head = readHead(fs, repo)
  const headFiles = flattenCommit(fs, repo, head.sha)
  const tracked = indexMap(index)
  const worktree = new Map<string, IndexEntry>()
  for (const entry of scanWorktree(fs, repo, repo.root)) {
    worktree.set(entry.path, entry)
  }
  const paths = new Set<string>([...headFiles.keys(), ...tracked.keys(), ...worktree.keys()])
  const statuses: StatusEntry[] = []
  for (const path of [...paths].sort()) {
    const headEntry = headFiles.get(path)
    const indexEntry = tracked.get(path)
    const workEntry = worktree.get(path)
    let indexState: StatusEntry['indexState'] = ' '
    if (indexEntry) {
      if (!headEntry) {
        indexState = 'A'
      } else if (headEntry.sha !== indexEntry.sha) {
        indexState = 'M'
      }
    } else if (headEntry) {
      indexState = 'D'
    }
    let workState: StatusEntry['workState'] = ' '
    if (!indexEntry && workEntry) {
      workState = '?'
    } else if (indexEntry) {
      if (!workEntry) {
        workState = 'D'
      } else {
        const sha = await hashWorktreeFile(fs, repo, path)
        if (sha && sha !== indexEntry.sha) {
          workState = 'M'
        }
      }
    }
    if (indexState === ' ' && workState === ' ') {
      continue
    }
    statuses.push({ path, indexState, workState })
  }
  return statuses
}

const commandStatus = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const long = args.includes('--long')
  const head = readHead(fs, repo)
  const statuses = await collectStatus(context)
  const branch = head.branch ?? 'HEAD'
  if (!long) {
    io.stdout(`## ${branch}${head.sha ? '' : ' (no commits yet)'}\n`)
    for (const entry of statuses) {
      // 暂存了删除、但工作区还留着文件时，真 git 会打两行：D  + ??
      if (entry.indexState !== ' ' || entry.workState !== '?') {
        const second = entry.workState === '?' ? ' ' : entry.workState
        io.stdout(`${entry.indexState}${second} ${entry.path}\n`)
      }
      if (entry.workState === '?') {
        io.stdout(`?? ${entry.path}\n`)
      }
    }
    return 0
  }
  const lines: string[] = []
  lines.push(`On branch ${branch}`)
  if (!head.sha) {
    lines.push('', 'No commits yet')
  }
  const staged = statuses.filter((entry) => entry.indexState !== ' ')
  const unstaged = statuses.filter((entry) => entry.workState === 'M' || entry.workState === 'D')
  const untracked = statuses.filter((entry) => entry.workState === '?')
  const label: Record<string, string> = { A: 'new file:  ', M: 'modified:  ', D: 'deleted:   ' }
  if (staged.length > 0) {
    lines.push('', 'Changes to be committed:')
    lines.push('  (use "git rm --cached <file>..." to unstage)')
    for (const entry of staged) {
      lines.push(`\t${label[entry.indexState]}${entry.path}`)
    }
  }
  if (unstaged.length > 0) {
    lines.push('', 'Changes not staged for commit:')
    lines.push('  (use "git add <file>..." to update what will be committed)')
    for (const entry of unstaged) {
      lines.push(`\t${entry.workState === 'D' ? 'deleted:   ' : 'modified:  '}${entry.path}`)
    }
  }
  if (untracked.length > 0) {
    lines.push('', 'Untracked files:')
    lines.push('  (use "git add <file>..." to include in what will be committed)')
    for (const entry of untracked) {
      lines.push(`\t${entry.path}`)
    }
  }
  if (statuses.length === 0) {
    lines.push('', 'nothing to commit, working tree clean')
  }
  io.stdout(`${lines.join('\n')}\n`)
  return 0
}

const commandAdd = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const operands: string[] = []
  let all = false
  let updateOnly = false
  for (const arg of args) {
    if (arg === '-A' || arg === '--all') {
      all = true
      continue
    }
    if (arg === '-u' || arg === '--update') {
      updateOnly = true
      continue
    }
    if (arg === '--') {
      continue
    }
    if (arg.startsWith('-') && arg !== '-') {
      fatal(`unknown option: ${arg}`)
    }
    operands.push(arg)
  }
  if (!all && operands.length === 0) {
    io.stderr("Nothing specified, nothing added.\nhint: Maybe you wanted to say 'git add .'?\n")
    return 1
  }
  const index = indexMap(context.index)
  const targets = new Set<string>()
  /** 需要顺手把「磁盘上已删除」从索引移除的仓库内目录前缀 */
  const prunePrefixes: string[] = []

  const addFile = async (path: string) => {
    const absolute = joinPath(repo.root, path)
    const stat = fs.stat(absolute)
    if (!stat || stat.kind !== 'file') {
      return
    }
    const bytes = fs.read(absolute) ?? new Uint8Array(0)
    index.set(path, {
      path,
      sha: await writeBlob(fs, repo, bytes),
      mode: '100644',
      size: bytes.byteLength,
      mtime: stat.mtime,
    })
    targets.add(path)
  }

  if (all) {
    for (const entry of scanWorktree(fs, repo, repo.root)) {
      await addFile(entry.path)
    }
    prunePrefixes.push('')
  }

  for (const operand of operands) {
    const absolute = resolvePath(io.cwd, operand)
    if (isInsideGitDir(repo, absolute)) {
      fatal(`pathspec '${operand}' 指向 .git 目录`)
    }
    if (fs.isDirectory(absolute)) {
      const relative = repoRelative(repo, absolute)
      prunePrefixes.push(relative)
      for (const entry of scanWorktree(fs, repo, absolute)) {
        await addFile(entry.path)
      }
      continue
    }
    if (fs.exists(absolute)) {
      await addFile(repoRelative(repo, absolute))
      continue
    }
    if (operand.includes('*') || operand.includes('?')) {
      const matches = fs.glob(absolute)
      if (matches.length === 0) {
        fatal(`pathspec '${operand}' did not match any files`)
      }
      for (const match of matches) {
        if (fs.isDirectory(match)) {
          for (const entry of scanWorktree(fs, repo, match)) {
            await addFile(entry.path)
          }
        } else {
          await addFile(repoRelative(repo, match))
        }
      }
      continue
    }
    // 磁盘上已经没有的路径：如果索引里还在，说明是在暂存删除
    const relative = repoRelative(repo, normalizePath(absolute))
    if (index.has(relative)) {
      index.delete(relative)
      continue
    }
    fatal(`pathspec '${operand}' did not match any files`)
  }

  // `git add .` 与 -u 都要把已删除的文件从索引里去掉（真 git 的行为）
  for (const prefix of prunePrefixes) {
    const match = prefix ? `${prefix}/` : ''
    for (const path of [...index.keys()]) {
      if (prefix && path !== prefix && !path.startsWith(match)) {
        continue
      }
      if (!fs.exists(joinPath(repo.root, path))) {
        index.delete(path)
      }
    }
  }
  if (updateOnly) {
    for (const path of [...index.keys()]) {
      if (!fs.exists(joinPath(repo.root, path))) {
        index.delete(path)
      }
    }
  }
  writeIndex(fs, repo, [...index.values()])
  return 0
}

const commandRemove = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  let cached = false
  let recursive = false
  const operands: string[] = []
  for (const arg of args) {
    if (arg === '--cached') {
      cached = true
      continue
    }
    if (arg === '-r') {
      recursive = true
      continue
    }
    if (arg === '--') {
      continue
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    operands.push(arg)
  }
  if (operands.length === 0) {
    fatal('请指定要删除的路径：git rm [--cached] <path>')
  }
  const index = indexMap(context.index)
  const removals: string[] = []
  for (const operand of operands) {
    const absolute = resolvePath(io.cwd, operand)
    const relative = repoRelative(repo, normalizePath(absolute))
    const prefix = relative ? `${relative}/` : ''
    const matched = [...index.keys()].filter((path) => path === relative || path.startsWith(prefix))
    if (matched.length === 0) {
      fatal(`pathspec '${operand}' did not match any files`)
    }
    if (matched.length > 1 && !recursive) {
      fatal(`not removing '${operand}' recursively without -r`)
    }
    for (const path of matched) {
      const target = joinPath(repo.root, path)
      if (!cached && fs.exists(target)) {
        fs.remove(target)
      }
      index.delete(path)
      removals.push(path)
    }
  }
  writeIndex(fs, repo, [...index.values()])
  for (const path of removals) {
    io.stdout(`rm '${path}'\n`)
  }
  return 0
}

const commandCommit = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const messages: string[] = []
  let quiet = false
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-m' || arg === '--message') {
      const value = args[index + 1]
      if (value === undefined) {
        fatal('switch `m` requires a value')
      }
      messages.push(value)
      index += 1
      continue
    }
    if (arg.startsWith('--message=')) {
      messages.push(arg.slice('--message='.length))
      continue
    }
    if (arg === '-q' || arg === '--quiet') {
      quiet = true
      continue
    }
    if (arg === '--amend') {
      fatal('NanoVM git 不支持 --amend')
    }
    if (arg === '-a' || arg === '--all') {
      fatal('NanoVM git 不支持 -a，请先 git add')
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    fatal(`pathspec '${arg}' 不支持：请先 git add 再 commit`)
  }
  const message = messages.join('\n\n').trim()
  if (!message) {
    fatal('NanoVM git 不支持编辑器，请用 git commit -m "提交信息"')
  }
  const head = readHead(fs, repo)
  const headFiles = flattenCommit(fs, repo, head.sha)
  const index = indexMap(context.index)
  if (index.size === 0) {
    if (headFiles.size === 0) {
      io.stdout('nothing to commit (create/copy files and use "git add" to track)\n')
      return 1
    }
  }
  const same =
    index.size === headFiles.size &&
    [...index].every(([path, entry]) => headFiles.get(path)?.sha === entry.sha)
  if (same) {
    io.stdout('nothing to commit, working tree clean\n')
    return 1
  }
  const tree = await buildTree(fs, repo, [...index.values()])
  const author = identity(fs, repo, io.env)
  const headerLines = [
    `tree ${tree}`,
    head.sha ? `parent ${head.sha}` : '',
    `author ${author.name} <${author.email}> ${author.time} ${author.timezone}`,
    `committer ${author.name} <${author.email}> ${author.time} ${author.timezone}`,
  ].filter(Boolean)
  const body = encode(`${headerLines.join('\n')}\n\n${message}\n`)
  const sha = await writeObject(fs, repo, 'commit', body)
  const branch = head.branch ?? 'main'
  if (!head.branch) {
    writeHeadRef(fs, repo, branch)
  }
  writeBranch(fs, repo, branch, sha)
  // 提交统计：逐文件比较行数增减
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  const paths = new Set<string>([...headFiles.keys(), ...index.keys()])
  for (const path of paths) {
    const before = headFiles.get(path)
    const after = index.get(path)
    if (before?.sha === after?.sha) {
      continue
    }
    filesChanged += 1
    const beforeBytes = before ? readObject(fs, repo, before.sha)?.body : undefined
    const afterBytes = after ? readObject(fs, repo, after.sha)?.body : undefined
    if (isBinary(beforeBytes ?? new Uint8Array(0)) || isBinary(afterBytes ?? new Uint8Array(0))) {
      continue
    }
    const delta = countChanges(
      lcsDiff(
        splitLines(beforeBytes ? decode(beforeBytes) : ''),
        splitLines(afterBytes ? decode(afterBytes) : '')
      )
    )
    insertions += delta.insertions
    deletions += delta.deletions
  }
  if (!quiet) {
    const summary = [`${filesChanged} file${filesChanged === 1 ? '' : 's'} changed`]
    if (insertions > 0) {
      summary.push(`${insertions} insertion${insertions === 1 ? '' : 's'}(+)`)
    }
    if (deletions > 0) {
      summary.push(`${deletions} deletion${deletions === 1 ? '' : 's'}(-)`)
    }
    io.stdout(`[${branch} ${sha.slice(0, 7)}] ${message.split('\n')[0]}\n`)
    io.stdout(` ${summary.join(', ')}\n`)
  }
  return 0
}

const commandLog = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  let oneline = false
  let limit = Number.POSITIVE_INFINITY
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '--oneline') {
      oneline = true
      continue
    }
    if (arg === '-n' || arg === '--max-count') {
      limit = Number(args[index + 1] ?? limit)
      index += 1
      continue
    }
    if (arg.startsWith('-n') && arg.length > 2) {
      limit = Number(arg.slice(2))
      continue
    }
    if (arg.startsWith('--max-count=')) {
      limit = Number(arg.slice('--max-count='.length))
      continue
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    fatal(`NanoVM git 的 log 只支持 HEAD 历史，不支持指定 ${arg}`)
  }
  const head = readHead(fs, repo)
  if (!head.sha) {
    io.stderr(
      `fatal: your current branch '${head.branch ?? 'main'}' does not have any commits yet\n`
    )
    return 128
  }
  let sha: string | null = head.sha
  let printed = 0
  while (sha && printed < limit) {
    const commit = readCommit(fs, repo, sha)
    if (!commit) {
      break
    }
    if (oneline) {
      io.stdout(`${commit.sha.slice(0, 7)} ${commit.message.split('\n')[0]}\n`)
    } else {
      io.stdout(`commit ${commit.sha}\n`)
      io.stdout(`Author: ${commit.author.name} <${commit.author.email}>\n`)
      io.stdout(`Date:   ${gitDate(commit.author.time, commit.author.timezone)}\n`)
      io.stdout('\n')
      for (const line of commit.message.replace(/\n+$/, '').split('\n')) {
        io.stdout(`    ${line}\n`)
      }
      io.stdout('\n')
    }
    printed += 1
    sha = commit.parents[0] ?? null
  }
  return 0
}

const commandDiff = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io, index } = context
  let cached = false
  const pathspecs: string[] = []
  for (const arg of args) {
    if (arg === '--cached' || arg === '--staged') {
      cached = true
      continue
    }
    if (arg === '--name-only') {
      fatal('NanoVM git 的 diff 暂不支持 --name-only')
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    pathspecs.push(arg)
  }
  const tracked = indexMap(index)
  const head = readHead(fs, repo)
  const lines: string[] = []
  if (cached) {
    const headFiles = flattenCommit(fs, repo, head.sha)
    const paths = new Set<string>([...headFiles.keys(), ...tracked.keys()])
    for (const path of [...paths].sort()) {
      if (
        pathspecs.length > 0 &&
        !pathspecs.some((item) => path.startsWith(item.replace(/^\.\//, '')))
      ) {
        continue
      }
      const before = headFiles.get(path)
      const after = tracked.get(path)
      if (before?.sha === after?.sha) {
        continue
      }
      const beforeObject = before ? readObject(fs, repo, before.sha) : null
      const afterObject = after ? readObject(fs, repo, after.sha) : null
      lines.push(
        ...diffText(
          path,
          beforeObject
            ? { text: decode(beforeObject.body), binary: isBinary(beforeObject.body) }
            : null,
          afterObject
            ? { text: decode(afterObject.body), binary: isBinary(afterObject.body) }
            : null
        )
      )
    }
    io.stdout(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    return 0
  }
  for (const [path, entry] of [...tracked].sort(([left], [right]) => left.localeCompare(right))) {
    if (
      pathspecs.length > 0 &&
      !pathspecs.some((item) => path.startsWith(item.replace(/^\.\//, '')))
    ) {
      continue
    }
    const absolute = joinPath(repo.root, path)
    const afterBytes = fs.read(absolute)
    const beforeObject = readObject(fs, repo, entry.sha)
    const beforeBytes = beforeObject?.body
    const same =
      beforeBytes &&
      afterBytes &&
      beforeBytes.byteLength === afterBytes.byteLength &&
      beforeBytes.every((byte, position) => byte === afterBytes[position])
    if (same) {
      continue
    }
    lines.push(
      ...diffText(
        path,
        beforeBytes ? { text: decode(beforeBytes), binary: isBinary(beforeBytes) } : null,
        afterBytes ? { text: decode(afterBytes), binary: isBinary(afterBytes) } : null
      )
    )
  }
  io.stdout(lines.length > 0 ? `${lines.join('\n')}\n` : '')
  return 0
}

const commandBranch = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const operands = args.filter((arg) => !arg.startsWith('-'))
  const deleteMode = args.includes('-d') || args.includes('-D')
  const head = readHead(fs, repo)
  if (operands.length === 0) {
    for (const branch of listBranches(fs, repo)) {
      io.stdout(`${branch === head.branch ? '*' : ' '} ${branch}\n`)
    }
    return 0
  }
  const name = operands[0]
  if (deleteMode) {
    const previous = branchSha(fs, repo, name)
    if (!previous) {
      fatal(`branch '${name}' not found`)
    }
    if (name === head.branch) {
      fatal(`Cannot delete branch '${name}' checked out at '${repo.root}'`)
    }
    fs.remove(joinPath(repo.gitDir, `refs/heads/${name}`))
    io.stdout(`Deleted branch ${name} (was ${previous.slice(0, 7)}).\n`)
    return 0
  }
  if (!head.sha) {
    fatal('Not a valid object name: HEAD（先 commit 一次再建分支）')
  }
  if (branchSha(fs, repo, name)) {
    fatal(`a branch named '${name}' already exists`)
  }
  writeBranch(fs, repo, name, head.sha)
  return 0
}

const commandCheckout = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  let force = false
  let create = false
  const operands: string[] = []
  for (const arg of args) {
    if (arg === '-f' || arg === '--force') {
      force = true
      continue
    }
    if (arg === '-b') {
      create = true
      continue
    }
    if (arg.startsWith('-')) {
      fatal(`unknown option: ${arg}`)
    }
    operands.push(arg)
  }
  if (operands.length !== 1) {
    fatal('用法：git checkout <branch> 或 git checkout -b <branch>')
  }
  const branch = operands[0]
  const head = readHead(fs, repo)
  let targetSha = branchSha(fs, repo, branch)
  if (create) {
    if (targetSha) {
      fatal(`a branch named '${branch}' already exists`)
    }
    if (!head.sha) {
      fatal('Not a valid object name: HEAD（先 commit 一次再建分支）')
    }
    targetSha = head.sha
    writeBranch(fs, repo, branch, targetSha)
  } else if (!targetSha) {
    fatal(`pathspec '${branch}' did not match any file(s) known to git（分支不存在）`)
  }
  if (!force) {
    const status = await collectStatus(context)
    const dirty = status.filter(
      (entry) => entry.indexState !== ' ' || entry.workState === 'M' || entry.workState === 'D'
    )
    if (dirty.length > 0) {
      const list = dirty.map((entry) => `\t${entry.path}`).join('\n')
      fatal(
        `本地有未提交的改动，checkout 会覆盖它们：\n${list}\n请先 git commit，或加 -f 强制切换：git checkout -f ${branch}`
      )
    }
  }
  const previousFiles = flattenCommit(fs, repo, head.sha)
  const nextFiles = flattenCommit(fs, repo, targetSha)
  // 先把要切换的目标版本写进工作区
  for (const [path, entry] of nextFiles) {
    const absolute = joinPath(repo.root, path)
    const object = readObject(fs, repo, entry.sha)
    if (!object) {
      fatal(`object ${entry.sha} 丢失，无法检出 ${path}`)
    }
    const existing = fs.read(absolute)
    const identical =
      existing &&
      existing.byteLength === object.body.byteLength &&
      existing.every((byte, index) => byte === object.body[index])
    if (identical) {
      continue
    }
    ensureDir(fs, dirName(absolute))
    fs.write(absolute, new Uint8Array(object.body))
  }
  // 旧分支有、新分支没有的文件删掉（只动被跟踪过的文件）
  for (const path of previousFiles.keys()) {
    if (nextFiles.has(path)) {
      continue
    }
    const absolute = joinPath(repo.root, path)
    if (fs.exists(absolute)) {
      fs.remove(absolute)
    }
  }
  const checkoutIndex = [...nextFiles.values()].map((entry) => {
    const stat = fs.stat(joinPath(repo.root, entry.path))
    return { ...entry, size: stat?.size ?? 0, mtime: stat?.mtime ?? 0 }
  })
  writeIndex(fs, repo, checkoutIndex)
  writeHeadRef(fs, repo, branch)
  io.stdout(`Switched to branch '${branch}'\n`)
  if (previousFiles.size === 0 && nextFiles.size > 0) {
    io.stdout(`已检出 ${nextFiles.size} 个文件\n`)
  }
  return 0
}

const commandLsFiles = async (context: CommandContext, args: string[]): Promise<number> => {
  const stage = args.includes('-s') || args.includes('--stage')
  for (const entry of [...context.index.entries].sort((left, right) =>
    left.path.localeCompare(right.path)
  )) {
    if (stage) {
      context.io.stdout(`${entry.mode} ${entry.sha} 0\t${entry.path}\n`)
    } else {
      context.io.stdout(`${entry.path}\n`)
    }
  }
  return 0
}

const commandRevParse = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const head = readHead(fs, repo)
  const operands = args.filter((arg) => !arg.startsWith('-'))
  const short = args.includes('--short')
  const abbrevRef = args.includes('--abbrev-ref')
  if (operands.length === 0) {
    fatal('用法：git rev-parse [--short|--abbrev-ref] <ref>')
  }
  for (const operand of operands) {
    if (operand === 'HEAD') {
      if (!head.sha) {
        fatal("ambiguous argument 'HEAD': unknown revision or path not in the working tree")
      }
      if (abbrevRef) {
        io.stdout(`${head.branch ?? 'HEAD'}\n`)
      } else if (short) {
        io.stdout(`${head.sha.slice(0, 7)}\n`)
      } else {
        io.stdout(`${head.sha}\n`)
      }
      continue
    }
    const resolved =
      branchSha(fs, repo, operand) ??
      readTextFile(fs, joinPath(repo.gitDir, operand))?.trim() ??
      (objectExists(fs, repo, operand) ? operand : null)
    if (!resolved) {
      fatal(`ambiguous argument '${operand}': unknown revision or path not in the working tree`)
    }
    io.stdout(`${short ? resolved.slice(0, 7) : resolved}\n`)
  }
  return 0
}

const commandConfig = async (context: CommandContext, args: string[]): Promise<number> => {
  const { fs, repo, io } = context
  const config = readConfig(fs, repo)
  const operands: string[] = []
  let list = false
  let get = false
  for (const arg of args) {
    if (arg === '--list' || arg === '-l') {
      list = true
      continue
    }
    if (arg === '--get') {
      get = true
      continue
    }
    if (arg === '--local' || arg === '--global') {
      continue
    }
    operands.push(arg)
  }
  const values: Record<string, string> = {
    'user.name': config.user.name,
    'user.email': config.user.email,
  }
  if (list) {
    for (const [key, value] of Object.entries(values)) {
      io.stdout(`${key}=${value}\n`)
    }
    return 0
  }
  if (operands.length === 0) {
    fatal('用法：git config user.name [<value>]')
  }
  const key = operands[0]
  if (!(key in values)) {
    fatal(`键 '${key}' 不在 NanoVM git 支持的配置里（支持 user.name / user.email）`)
  }
  if (operands.length === 1) {
    if (!get && values[key] === '') {
      return 1
    }
    io.stdout(`${values[key]}\n`)
    return 0
  }
  const value = operands.slice(1).join(' ')
  if (key === 'user.name') {
    config.user.name = value
  } else {
    config.user.email = value
  }
  writeConfig(fs, repo, config)
  return 0
}

const USAGE = [
  '用法：git <子命令> [参数]',
  '',
  'NanoVM Slim 内置的 git 实现（对象格式与真 git 一致，无需下载）。',
  '',
  '支持的子命令：',
  '  init [-b <branch>]        初始化仓库（默认分支 main）',
  '  status [--long]          短格式两列状态，--long 给人看的完整版',
  '  add <paths>|.            暂存文件（支持通配符与目录）',
  '  rm --cached <paths>      只从索引移除，保留工作区文件',
  '  commit -m "消息"         生成提交对象并更新分支',
  '  log [--oneline] [-n N]   历史记录',
  '  diff [--cached]          工作区与索引（或索引与 HEAD）的差异',
  '  branch [<name>]          列出 / 新建分支',
  '  checkout [-f] [-b] <b>   切换分支',
  '  ls-files [-s]            索引里的文件',
  '  rev-parse HEAD           解析引用',
  '  config user.name/email   读写提交身份',
  '  help                     这份说明',
  '',
  '不支持：push / pull / clone / fetch / merge / rebase / stash / tag / remote。',
  '',
].join('\n')

const SUPPORTED = [
  'init',
  'status',
  'add',
  'rm',
  'commit',
  'log',
  'diff',
  'branch',
  'checkout',
  'ls-files',
  'rev-parse',
  'config',
  'help',
]

/** 执行一条 git 命令；argv 不含 `git` 本身 */
export const runGit = async (argv: string[], io: GitIO): Promise<number> => {
  // 真 git 的 -C <dir> 是全局选项，先把它消化掉再进子命令
  let effectiveIo = io
  let args = [...argv]
  while (args[0] === '-C') {
    const dir = args[1]
    if (!dir) {
      io.stderr('fatal: -C requires an argument\n')
      return 128
    }
    effectiveIo = { ...effectiveIo, cwd: resolvePath(effectiveIo.cwd, dir) }
    args = args.slice(2)
  }
  const subcommand = args[0]
  try {
    if (!subcommand || subcommand === 'help' || subcommand === '--help' || subcommand === '-h') {
      io.stdout(USAGE)
      return 0
    }
    if (subcommand === '--version' || subcommand === 'version') {
      io.stdout(`git version ${GIT_VERSION}\n`)
      return 0
    }
    if (subcommand === 'init') {
      return await commandInit(effectiveIo, args.slice(1))
    }
    if (!SUPPORTED.includes(subcommand)) {
      io.stderr(
        `git: '${subcommand}' 不是 NanoVM Slim 支持的子命令\n` +
          `支持的子命令：${SUPPORTED.join('、')}\n`
      )
      return 1
    }
    const repo = requireRepo(effectiveIo.fs, effectiveIo.cwd)
    const context: CommandContext = {
      fs: effectiveIo.fs,
      repo,
      io: effectiveIo,
      index: readIndex(effectiveIo.fs, repo),
    }
    const rest = args.slice(1)
    switch (subcommand) {
      case 'status':
        return await commandStatus(context, rest)
      case 'add':
        return await commandAdd(context, rest)
      case 'rm':
        return await commandRemove(context, rest)
      case 'commit':
        return await commandCommit(context, rest)
      case 'log':
        return await commandLog(context, rest)
      case 'diff':
        return await commandDiff(context, rest)
      case 'branch':
        return await commandBranch(context, rest)
      case 'checkout':
        return await commandCheckout(context, rest)
      case 'ls-files':
        return await commandLsFiles(context, rest)
      case 'rev-parse':
        return await commandRevParse(context, rest)
      case 'config':
        return await commandConfig(context, rest)
      default:
        io.stderr(`git: '${subcommand}' 暂未实现\n`)
        return 1
    }
  } catch (error) {
    if (error instanceof GitFatal) {
      io.stderr(`${error.message}\n`)
      return error.code
    }
    const message = error instanceof Error ? error.message : String(error)
    io.stderr(`git: ${message}\n`)
    return 1
  }
}
