import {
  deleteWorkspaceFile,
  listWorkspaceFiles,
  readWorkspaceFile,
  saveWorkspaceFile,
  workspaceFileBytes,
  type WorkspaceFile,
} from '../workspace/store.js'

/**
 * 把应用的工作区暴露成 unkernel 的 9p 文件系统。
 *
 * unkernel 的 Fs 接口是结构类型：getattr/readdir/open 必选，其余写操作
 * 可选。这里直接读写 chat-demo 的工作区仓库，guest 里对
 * /mnt/workspace 的改动会立刻落回工作区，Agent 和用户看到同一份文件。
 */

class FsError extends Error {
  readonly code: string

  constructor(code: string, message?: string) {
    super(message ?? code)
    this.name = 'FsError'
    this.code = code
  }
}

const DIR_MODE = 0o755
const FILE_MODE = 0o644
const OWNER = 1000

type Attr = {
  type: 'file' | 'dir'
  mode: number
  size: number
  uid: number
  gid: number
  mtimeMs: number
  ctimeMs: number
  atimeMs: number
  version: number
}

const clean = (path: string): string => {
  if (!path.startsWith('/')) {
    path = `/${path}`
  }
  const normalized = path.replace(/\/+/g, '/').replace(/\/$/, '') || '/'
  if (normalized.includes('..')) {
    throw new FsError('EINVAL')
  }
  return normalized
}

const toWorkspacePath = (path: string): string => clean(path).replace(/^\/+/, '')

const fileBytes = (file: WorkspaceFile): Uint8Array => workspaceFileBytes(file)

class WorkspaceFs {
  private dirs = new Set<string>(['/'])
  private openFiles = new Set<WorkspaceOpenFile>()

  constructor() {
    this.rebuildDirs()
  }

  private rebuildDirs() {
    this.dirs = new Set(['/'])
    for (const file of listWorkspaceFiles()) {
      this.addParents(`/${file.path}`)
    }
  }

  private addParents(path: string) {
    const parts = clean(path).split('/').filter(Boolean)
    let current = ''
    for (let index = 0; index < parts.length - 1; index += 1) {
      current += `/${parts[index]}`
      this.dirs.add(current)
    }
  }

  private file(path: string): WorkspaceFile | null {
    const workspacePath = toWorkspacePath(path)
    return workspacePath ? readWorkspaceFile(workspacePath) : null
  }

  getattr(path: string): Attr {
    const normalized = clean(path)
    if (this.dirs.has(normalized)) {
      return {
        type: 'dir',
        mode: DIR_MODE,
        size: 0,
        uid: OWNER,
        gid: OWNER,
        mtimeMs: Date.now(),
        ctimeMs: Date.now(),
        atimeMs: Date.now(),
        version: 1,
      }
    }
    const file = this.file(normalized)
    if (!file) {
      throw new FsError('ENOENT')
    }
    return {
      type: 'file',
      mode: FILE_MODE,
      size: file.size,
      uid: OWNER,
      gid: OWNER,
      mtimeMs: file.updatedAt,
      ctimeMs: file.updatedAt,
      atimeMs: file.updatedAt,
      version: file.updatedAt,
    }
  }

  readdir(path: string): Array<{ name: string; type: 'file' | 'dir' }> {
    const normalized = clean(path)
    if (!this.dirs.has(normalized)) {
      throw new FsError(this.file(normalized) ? 'ENOTDIR' : 'ENOENT')
    }
    const prefix = normalized === '/' ? '/' : `${normalized}/`
    const entries = new Map<string, 'file' | 'dir'>()
    for (const dir of this.dirs) {
      if (dir !== normalized && dir.startsWith(prefix)) {
        const rest = dir.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          entries.set(rest, 'dir')
        }
      }
    }
    for (const file of listWorkspaceFiles()) {
      const filePath = `/${file.path}`
      if (filePath.startsWith(prefix)) {
        const rest = filePath.slice(prefix.length)
        if (rest && !rest.includes('/')) {
          entries.set(rest, 'file')
        }
      }
    }
    return [...entries.entries()]
      .map(([name, type]) => ({ name, type }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  open(path: string, flags: { read: boolean; write: boolean; truncate: boolean; append: boolean }) {
    const normalized = clean(path)
    if (this.dirs.has(normalized)) {
      throw new FsError('EISDIR')
    }
    const file = this.file(normalized)
    if (!file) {
      throw new FsError('ENOENT')
    }
    let bytes = fileBytes(file)
    if (flags.truncate && flags.write) {
      bytes = new Uint8Array(0)
    }
    const handle = new WorkspaceOpenFile(normalized, bytes, this)
    this.openFiles.add(handle)
    return handle
  }

  create(path: string) {
    const normalized = clean(path)
    if (this.dirs.has(normalized)) {
      throw new FsError('EISDIR')
    }
    if (this.file(normalized)) {
      throw new FsError('EEXIST')
    }
    const result = saveWorkspaceFile(toWorkspacePath(normalized), { bytes: new Uint8Array(0) })
    if (!result.ok) {
      throw new FsError(result.reason === 'quota' ? 'ENOSPC' : 'EIO')
    }
    this.addParents(normalized)
    const handle = new WorkspaceOpenFile(normalized, new Uint8Array(0), this)
    this.openFiles.add(handle)
    return handle
  }

  mkdir(path: string) {
    const normalized = clean(path)
    if (this.dirs.has(normalized)) {
      throw new FsError('EEXIST')
    }
    if (this.file(normalized)) {
      throw new FsError('ENOTDIR')
    }
    this.addParents(`${normalized}/x`)
    this.dirs.add(normalized)
  }

  remove(path: string, dir: boolean) {
    const normalized = clean(path)
    if (dir) {
      if (!this.dirs.has(normalized)) {
        throw new FsError('ENOENT')
      }
      const prefix = `${normalized}/`
      if ([...this.dirs].some((item) => item !== normalized && item.startsWith(prefix)) ||
          listWorkspaceFiles().some((file) => `/${file.path}`.startsWith(prefix))) {
        throw new FsError('ENOTEMPTY')
      }
      this.dirs.delete(normalized)
      return
    }
    const file = this.file(normalized)
    if (!file) {
      throw new FsError('ENOENT')
    }
    if (!deleteWorkspaceFile(file.path)) {
      throw new FsError('EIO')
    }
    this.rebuildDirs()
  }

  rename(from: string, to: string) {
    const source = clean(from)
    const target = clean(to)
    const file = this.file(source)
    if (!file) {
      throw new FsError('ENOENT')
    }
    if (this.file(target) || this.dirs.has(target)) {
      throw new FsError('EEXIST')
    }
    const result = saveWorkspaceFile(toWorkspacePath(target), { bytes: fileBytes(file) })
    if (!result.ok) {
      throw new FsError(result.reason === 'quota' ? 'ENOSPC' : 'EIO')
    }
    deleteWorkspaceFile(file.path)
    this.rebuildDirs()
  }

  setattr(path: string, attr: { size?: number }) {
    if (attr.size === undefined) {
      return
    }
    const file = this.file(clean(path))
    if (!file) {
      throw new FsError('ENOENT')
    }
    const bytes = fileBytes(file)
    const size = Math.max(0, Math.trunc(attr.size))
    const next = new Uint8Array(size)
    next.set(bytes.subarray(0, Math.min(size, bytes.length)))
    saveWorkspaceFile(file.path, { bytes: next })
    this.rebuildDirs()
  }

  statfs() {
    const files = listWorkspaceFiles()
    const used = files.reduce((sum, file) => sum + file.size, 0)
    const total = 4 * 1024 * 1024 * 1024
    return {
      bsize: 4096,
      blocks: Math.ceil(total / 4096),
      bfree: Math.max(0, Math.ceil((total - used) / 4096)),
      files: files.length,
      ffree: Math.max(0, 2000 - files.length),
      namelen: 200,
    }
  }

  saveFile(path: string, bytes: Uint8Array) {
    const result = saveWorkspaceFile(toWorkspacePath(path), { bytes })
    if (!result.ok) {
      throw new FsError(result.reason === 'quota' ? 'ENOSPC' : 'EIO')
    }
    this.addParents(path)
  }

  close() {
    for (const handle of [...this.openFiles]) {
      try {
        handle.close()
      } catch {
        // ignore save errors at unmount
      }
    }
  }
}

class WorkspaceOpenFile {
  private data: Uint8Array
  private dirty = false

  constructor(
    private path: string,
    data: Uint8Array,
    private fs: WorkspaceFs
  ) {
    this.data = data.slice()
  }

  read(offset: number, length: number) {
    return this.data.slice(offset, offset + length)
  }

  write(offset: number, data: Uint8Array) {
    const end = offset + data.length
    if (end > this.data.length) {
      const next = new Uint8Array(end)
      next.set(this.data)
      this.data = next
    }
    this.data.set(data, offset)
    this.dirty = true
    return data.length
  }

  getattr() {
    return {
      type: 'file' as const,
      mode: FILE_MODE,
      size: this.data.length,
      uid: OWNER,
      gid: OWNER,
      mtimeMs: Date.now(),
      ctimeMs: Date.now(),
      atimeMs: Date.now(),
      version: Date.now(),
    }
  }

  setattr(attr: { size?: number }) {
    if (attr.size === undefined) {
      return
    }
    const size = Math.max(0, Math.trunc(attr.size))
    const next = new Uint8Array(size)
    next.set(this.data.subarray(0, Math.min(size, this.data.length)))
    this.data = next
    this.dirty = true
  }

  fsync() {
    this.flush()
  }

  close() {
    this.flush()
  }

  private flush() {
    if (!this.dirty) {
      return
    }
    this.fs.saveFile(this.path, this.data)
    this.dirty = false
  }
}

export const createWorkspaceFs = () => new WorkspaceFs()
