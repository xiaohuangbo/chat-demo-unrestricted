import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate'
import { ERRNO_TEXT, VmError } from './types.js'

/**
 * NanoVM Slim 的虚拟文件系统。
 *
 * 内存里是一棵路径树，落盘用 OPFS（没有则 localStorage）。整体很小：文件按字节存，
 * 目录显式记录（支持空目录），权限位只用于 `ls -l` / `chmod` 的展示。
 *
 * 容量由 NanoVM Slim 控制台里的「虚拟磁盘」决定，写满抛 ENOSPC，
 * 文件数超限抛 EMFILE——shell 与 Agent 工具都靠这两个错误码给出提示。
 */

const LS_KEY = 'chat-demo:nanovm-fs'
const OPFS_DIR = 'chat-demo-nanovm'
const FORMAT_VERSION = 2
const DEFAULT_MAX_FILES = 20_000

type FileNode = {
  kind: 'file'
  bytes: Uint8Array
  mtime: number
  mode: number
}

type DirNode = {
  kind: 'dir'
  mtime: number
  mode: number
}

type Node = FileNode | DirNode

/** 落盘格式：一个 JSON 清单 + 文件内容，OPFS 里按路径拆文件 */
type Snapshot = {
  version: number
  dirs: { path: string; mtime: number; mode: number }[]
  files: { path: string; mtime: number; mode: number; b64: string }[]
}

export type FsLimits = {
  /** 虚拟磁盘容量（MB） */
  diskMB: number
  /** 单文件上限（MB） */
  fileMB: number
  /** 文件数上限 */
  maxFiles: number
}

export type FsEntry = {
  path: string
  name: string
  kind: 'file' | 'dir'
  size: number
  mtime: number
  mode: number
}

export type FsUsage = {
  bytes: number
  files: number
  dirs: number
  /** 是否已持久化到 OPFS */
  opfs: boolean
}

// ---------- 路径 ----------

/** 折叠重复斜杠、处理 . 与 ..，返回绝对路径（不带结尾斜杠，根为 /） */
export const normalizePath = (input: string): string => {
  const parts: string[] = []
  for (const part of input.split('/')) {
    if (!part || part === '.') {
      continue
    }
    if (part === '..') {
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return `/${parts.join('/')}`
}

/** 相对路径按 cwd 解析成绝对路径 */
export const resolvePath = (cwd: string, input: string): string => {
  if (input === '~' || input.startsWith('~/')) {
    return normalizePath(`/home/user${input.slice(1)}`)
  }
  if (input.startsWith('/')) {
    return normalizePath(input)
  }
  return normalizePath(`${cwd}/${input}`)
}

export const baseName = (path: string): string => {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export const dirName = (path: string): string => {
  const normalized = normalizePath(path)
  if (normalized === '/') {
    return '/'
  }
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

const joinPath = (dir: string, name: string): string =>
  dir === '/' ? `/${name}` : `${dir}/${name}`

/** 把 glob 模式编译成正则：支持 * ? [abc] [!abc] 与 ** */
const globToRegExp = (pattern: string): RegExp => {
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          source += '(?:.*/)?'
        } else {
          source += '.*'
        }
      } else {
        source += '[^/]*'
      }
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) {
        let body = pattern.slice(index + 1, end)
        if (body.startsWith('!')) {
          body = `^${body.slice(1)}`
        }
        source += `[${body.replace(/\\/g, '\\\\')}]`
        index = end
        continue
      }
    }
    source += char.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`${source}$`)
}

export const hasGlob = (word: string): boolean => /[*?[]/.test(word)

// ---------- 默认目录树 ----------

const DEFAULT_DIRS = ['/bin', '/dev', '/etc', '/home', '/home/user', '/tmp', '/usr', '/usr/bin']

const MOTD = [
  ' __   __                   __     __  __  ____     ____  _ _',
  ' \\ \\ / /_ _ _ __   ___  \\ \\   / / |  \\/  |  _ \\  / ___|| (_)_ __ ___',
  "  \\ V / _` | '_ \\ / _ \\  \\ \\ / /  | |\\/| | |_) | \\___ \\| | | '_ ` _ \\",
  '   | | (_| | | | | (_) |  \\ V /   | |  | |  _ <   ___) | | | | | | | |',
  '   |_|\\__,_|_| |_|\\___/    \\_/    |_|  |_|_| \\_\\ |____/|_|_|_| |_| |_|',
  '',
  '  NanoVM Slim · WASM Shell Engine · 输入 help 查看内置命令',
  '',
].join('\n')

const PROFILE = [
  '# ~/.profile —— NanoVM Slim 启动时读取',
  "export PATH='/usr/bin:/bin'",
  "export HOME='/home/user'",
  "export HOSTNAME='nanovm'",
  "export PS1='\\u@nanovm:\\w$ '",
  "export LANG='zh_CN.UTF-8'",
  "alias ll='ls -l'",
  "alias la='ls -a'",
  '',
].join('\n')

const readmeText = [
  '# NanoVM Slim',
  '',
  '浏览器里的轻量 POSIX 环境。文件、目录、权限都在虚拟文件系统里，和本机磁盘无关。',
  '',
  '常用命令：',
  '  ls -l        列出文件',
  '  cat /etc/motd   查看欢迎信息',
  '  grep -rn TODO . 递归搜索',
  '  vm info      查看引擎状态与内存占用',
  '  help         全部内置命令',
  '',
  '需要 Python / Node.js / Git 时执行 vm install python，运行时按需加载。',
  '',
].join('\n')

// ---------- 文件系统 ----------

class NanoFs {
  private nodes = new Map<string, Node>()
  private ready = false
  private hydrating: Promise<void> | null = null
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private opfsRoot: FileSystemDirectoryHandle | null = null
  private opfsReady = false
  private limits: FsLimits = { diskMB: 64, fileMB: 32, maxFiles: DEFAULT_MAX_FILES }
  private listeners = new Set<() => void>()

  // ---------- 生命周期 ----------

  /** 首次使用时挂载默认目录树并从存储里恢复 */
  hydrate = async (): Promise<void> => {
    if (this.ready) {
      return
    }
    if (this.hydrating) {
      return this.hydrating
    }
    this.hydrating = (async () => {
      this.mountDefaults()
      try {
        await this.restore()
      } catch {
        // 存储损坏时保留默认树，保证还能用
      }
      this.ready = true
      this.emit()
    })()
    return this.hydrating
  }

  /** 更新容量限制（控制台里改内存 / 磁盘时调用） */
  setLimits = (limits: Partial<FsLimits>) => {
    this.limits = { ...this.limits, ...limits }
    // 用量条按新配额重算
    this.emit()
  }

  getLimits = (): FsLimits => this.limits

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit = () => {
    for (const listener of this.listeners) {
      listener()
    }
  }

  private mountDefaults = () => {
    const now = Date.now()
    // 根目录显式挂上，stat('/') / readdir('/') 才能工作
    this.nodes.set('/', { kind: 'dir', mtime: now, mode: 0o755 })
    for (const path of DEFAULT_DIRS) {
      this.nodes.set(path, { kind: 'dir', mtime: now, mode: 0o755 })
    }
    this.writeDefault('/etc/motd', MOTD, 0o644, now)
    this.writeDefault('/etc/hostname', 'nanovm\n', 0o644, now)
    this.writeDefault(
      '/etc/os-release',
      'NAME="NanoVM Slim"\nID=nanovm\nVERSION_ID="2.7.8"\n',
      0o644,
      now
    )
    this.writeDefault('/home/user/.profile', PROFILE, 0o644, now)
    this.writeDefault('/home/user/README.md', readmeText, 0o644, now)
    this.mkdir('/tmp', true)
  }

  private writeDefault = (path: string, text: string, mode: number, mtime: number) => {
    if (!this.nodes.has(path)) {
      this.nodes.set(path, { kind: 'file', bytes: strToU8(text), mtime, mode })
    }
  }

  // ---------- 读取 ----------

  /** 路径是否存在 */
  exists = (inputPath: string): boolean => this.nodes.has(normalizePath(inputPath))

  /** 是否为目录 */
  isDirectory = (inputPath: string): boolean =>
    this.nodes.get(normalizePath(inputPath))?.kind === 'dir'

  stat = (inputPath: string): FsEntry | null => {
    const path = normalizePath(inputPath)
    const node = this.nodes.get(path)
    if (!node) {
      return null
    }
    return {
      path,
      name: baseName(path),
      kind: node.kind,
      size: node.kind === 'file' ? node.bytes.byteLength : 0,
      mtime: node.mtime,
      mode: node.mode,
    }
  }

  read = (inputPath: string): Uint8Array | null => {
    const node = this.nodes.get(normalizePath(inputPath))
    if (!node) {
      return null
    }
    if (node.kind === 'dir') {
      throw new VmError('EISDIR', ERRNO_TEXT.EISDIR)
    }
    return node.bytes
  }

  readText = (inputPath: string): string | null => {
    const bytes = this.read(inputPath)
    return bytes ? strFromU8(bytes) : null
  }

  /** 列目录；path 为文件时抛 ENOTDIR */
  readdir = (inputPath: string, options: { all?: boolean } = {}): FsEntry[] => {
    const path = normalizePath(inputPath)
    const node = this.nodes.get(path)
    if (!node) {
      throw new VmError('ENOENT', ERRNO_TEXT.ENOENT)
    }
    if (node.kind !== 'dir') {
      throw new VmError('ENOTDIR', ERRNO_TEXT.ENOTDIR)
    }
    const prefix = path === '/' ? '/' : `${path}/`
    const entries: FsEntry[] = []
    for (const [entryPath, entryNode] of this.nodes) {
      if (entryPath === path || !entryPath.startsWith(prefix)) {
        continue
      }
      const rest = entryPath.slice(prefix.length)
      if (rest.includes('/')) {
        continue
      }
      if (!options.all && rest.startsWith('.')) {
        continue
      }
      entries.push({
        path: entryPath,
        name: rest,
        kind: entryNode.kind,
        size: entryNode.kind === 'file' ? entryNode.bytes.byteLength : 0,
        mtime: entryNode.mtime,
        mode: entryNode.mode,
      })
    }
    return entries.sort((left, right) => left.name.localeCompare(right.name))
  }

  /** 递归列出所有路径（含目录） */
  walk = (inputPath = '/'): FsEntry[] => {
    const prefix = normalizePath(inputPath)
    const out: FsEntry[] = []
    for (const [path, node] of this.nodes) {
      if (path === prefix) {
        continue
      }
      if (prefix !== '/' && !path.startsWith(`${prefix}/`)) {
        continue
      }
      out.push({
        path,
        name: baseName(path),
        kind: node.kind,
        size: node.kind === 'file' ? node.bytes.byteLength : 0,
        mtime: node.mtime,
        mode: node.mode,
      })
    }
    return out.sort((left, right) => left.path.localeCompare(right.path))
  }

  /** 通配符展开：返回命中的绝对路径，未命中返回空数组 */
  glob = (pattern: string): string[] => {
    const normalized = normalizePath(pattern)
    if (!hasGlob(normalized)) {
      return this.nodes.has(normalized) ? [normalized] : []
    }
    const matcher = globToRegExp(normalized)
    const out: string[] = []
    for (const path of this.nodes.keys()) {
      if (matcher.test(path)) {
        out.push(path)
      }
    }
    return out.sort()
  }

  usage = (): FsUsage => {
    let bytes = 0
    let files = 0
    let dirs = 0
    for (const node of this.nodes.values()) {
      if (node.kind === 'file') {
        bytes += node.bytes.byteLength
        files += 1
      } else {
        dirs += 1
      }
    }
    return { bytes, files, dirs, opfs: this.opfsReady }
  }

  // ---------- 写入 ----------

  private assertParent = (path: string) => {
    const parent = dirName(path)
    const node = this.nodes.get(parent)
    if (!node) {
      throw new VmError('ENOENT', `cannot create '${path}': No such file or directory`)
    }
    if (node.kind !== 'dir') {
      throw new VmError('ENOTDIR', `cannot create '${path}': Not a directory`)
    }
    return parent
  }

  private assertSpace = (path: string, size: number) => {
    const limit = this.limits.diskMB * 1024 * 1024
    const fileLimit = this.limits.fileMB * 1024 * 1024
    const usage = this.usage()
    const existing = this.nodes.get(path)
    const previous = existing?.kind === 'file' ? existing.bytes.byteLength : 0
    if (size > fileLimit) {
      throw new VmError(
        'ENOSPC',
        `cannot write '${path}': exceeds per-file limit (${this.limits.fileMB} MB)`
      )
    }
    if (usage.bytes - previous + size > limit) {
      throw new VmError('ENOSPC', `cannot write '${path}': No space left on device`)
    }
    if (!existing && usage.files + 1 > this.limits.maxFiles) {
      throw new VmError('EMFILE', `cannot create '${path}': Too many open files`)
    }
  }

  write = (inputPath: string, bytes: Uint8Array, options: { mode?: number } = {}) => {
    const path = normalizePath(inputPath)
    if (path === '/') {
      throw new VmError('EISDIR', ERRNO_TEXT.EISDIR)
    }
    this.assertParent(path)
    const existing = this.nodes.get(path)
    if (existing?.kind === 'dir') {
      throw new VmError('EISDIR', `cannot write '${path}': Is a directory`)
    }
    this.assertSpace(path, bytes.byteLength)
    this.nodes.set(path, {
      kind: 'file',
      // 复制一份，避免调用方复用同一 buffer 时内容被改
      bytes: new Uint8Array(bytes),
      mtime: Date.now(),
      mode: options.mode ?? existing?.mode ?? 0o644,
    })
    this.touch(dirName(path))
    this.schedulePersist()
    this.emit()
  }

  writeText = (inputPath: string, text: string, options: { mode?: number } = {}) => {
    this.write(inputPath, strToU8(text), options)
  }

  mkdir = (inputPath: string, recursive = false) => {
    const path = normalizePath(inputPath)
    if (path === '/') {
      return
    }
    if (this.nodes.has(path)) {
      if (recursive && this.nodes.get(path)?.kind === 'dir') {
        return
      }
      throw new VmError('EEXIST', `cannot create directory '${path}': File exists`)
    }
    if (recursive) {
      const segments = path.split('/').filter(Boolean)
      let current = ''
      for (const segment of segments) {
        current = `${current}/${segment}`
        const node = this.nodes.get(current)
        if (!node) {
          this.nodes.set(current, { kind: 'dir', mtime: Date.now(), mode: 0o755 })
        } else if (node.kind !== 'dir') {
          throw new VmError('ENOTDIR', `cannot create directory '${current}': Not a directory`)
        }
      }
    } else {
      this.assertParent(path)
      this.nodes.set(path, { kind: 'dir', mtime: Date.now(), mode: 0o755 })
    }
    this.schedulePersist()
    this.emit()
  }

  remove = (inputPath: string, recursive = false) => {
    const path = normalizePath(inputPath)
    if (path === '/') {
      throw new VmError('EPERM', "cannot remove '/': Operation not permitted")
    }
    const node = this.nodes.get(path)
    if (!node) {
      throw new VmError('ENOENT', `cannot remove '${path}': No such file or directory`)
    }
    if (node.kind === 'dir') {
      if (!recursive) {
        const children = this.readdir(path, { all: true })
        if (children.length > 0) {
          throw new VmError('ENOTEMPTY', `cannot remove '${path}': Directory not empty`)
        }
      } else {
        for (const entry of this.walk(path)) {
          this.nodes.delete(entry.path)
        }
      }
    }
    this.nodes.delete(path)
    this.touch(dirName(path))
    this.schedulePersist()
    this.emit()
  }

  /** 复制：递归复制目录，保留权限位 */
  copy = (from: string, to: string, options: { recursive?: boolean } = {}) => {
    const source = normalizePath(from)
    const target = normalizePath(to)
    const node = this.nodes.get(source)
    if (!node) {
      throw new VmError('ENOENT', `cannot stat '${source}': No such file or directory`)
    }
    if (target !== '/' && this.isDirectory(target)) {
      throw new VmError('EISDIR', `cannot overwrite directory '${target}' with non-directory`)
    }
    if (node.kind === 'dir') {
      if (!options.recursive) {
        throw new VmError('EISDIR', `-r not specified; omitting directory '${source}'`)
      }
      this.mkdir(target, true)
      for (const entry of this.walk(source)) {
        const relative = entry.path.slice(source.length)
        const destination = `${target}${relative}`
        if (entry.kind === 'dir') {
          this.mkdir(destination, true)
        } else {
          const bytes = this.read(entry.path)
          if (bytes) {
            this.write(destination, bytes, { mode: entry.mode })
          }
        }
      }
      return
    }
    // 目标是已存在的目录：复制到目录里
    const finalTarget = this.isDirectory(target) ? joinPath(target, baseName(source)) : target
    const bytes = node.bytes
    this.write(finalTarget, bytes, { mode: node.mode })
  }

  /** 移动：同一文件系统里先复制再删除 */
  move = (from: string, to: string) => {
    const source = normalizePath(from)
    let target = normalizePath(to)
    const node = this.nodes.get(source)
    if (!node) {
      throw new VmError('ENOENT', `cannot stat '${source}': No such file or directory`)
    }
    if (this.isDirectory(target)) {
      target = joinPath(target, baseName(source))
    }
    this.copy(source, target, { recursive: true })
    this.nodes.delete(source)
    if (node.kind === 'dir') {
      for (const entry of this.walk(source)) {
        this.nodes.delete(entry.path)
      }
    }
    this.schedulePersist()
    this.emit()
  }

  chmod = (inputPath: string, mode: number) => {
    const path = normalizePath(inputPath)
    const node = this.nodes.get(path)
    if (!node) {
      throw new VmError('ENOENT', `cannot access '${path}': No such file or directory`)
    }
    node.mode = mode
    this.schedulePersist()
    this.emit()
  }

  truncate = (inputPath: string) => {
    this.write(inputPath, new Uint8Array(0))
  }

  private touch = (path: string) => {
    const node = this.nodes.get(path)
    if (node) {
      node.mtime = Date.now()
    }
  }

  // ---------- 持久化 ----------

  private schedulePersist = () => {
    if (this.persistTimer) {
      return
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      void this.persist()
    }, 300)
  }

  private snapshot = (): Snapshot => {
    const dirs: Snapshot['dirs'] = []
    const files: Snapshot['files'] = []
    for (const [path, node] of this.nodes) {
      if (node.kind === 'dir') {
        dirs.push({ path, mtime: node.mtime, mode: node.mode })
      } else {
        files.push({ path, mtime: node.mtime, mode: node.mode, b64: bytesToBase64(node.bytes) })
      }
    }
    return { version: FORMAT_VERSION, dirs, files }
  }

  /** 立即落盘（导出、切换页面前调用） */
  persist = async (): Promise<void> => {
    const snapshot = this.snapshot()
    const text = JSON.stringify(snapshot)
    const root = await this.opfsRootDirectory()
    if (root) {
      try {
        const manifest = await root.getFileHandle('manifest.json', { create: true })
        const writable = await manifest.createWritable()
        await writable.write(text)
        await writable.close()
        this.opfsReady = true
        try {
          localStorage.removeItem(LS_KEY)
        } catch {
          // 忽略
        }
        return
      } catch {
        this.opfsRoot = null
      }
    }
    try {
      localStorage.setItem(LS_KEY, text)
    } catch {
      // 本地存储也满时只能保留内存态
    }
  }

  private opfsRootDirectory = async (): Promise<FileSystemDirectoryHandle | null> => {
    if (this.opfsRoot) {
      return this.opfsRoot
    }
    if (typeof navigator === 'undefined' || typeof navigator.storage?.getDirectory !== 'function') {
      return null
    }
    try {
      const root = await navigator.storage.getDirectory()
      this.opfsRoot = await root.getDirectoryHandle(OPFS_DIR, { create: true })
      return this.opfsRoot
    } catch {
      return null
    }
  }

  private restore = async (): Promise<void> => {
    let text: string | null = null
    const root = await this.opfsRootDirectory()
    if (root) {
      try {
        const handle = await root.getFileHandle('manifest.json')
        text = await (await handle.getFile()).text()
        this.opfsReady = true
        if (text) {
          this.applySnapshot(text)
          return
        }
      } catch {
        // 没有就回落到 localStorage
      }
    }
    try {
      text = localStorage.getItem(LS_KEY)
    } catch {
      text = null
    }
    if (text) {
      this.applySnapshot(text)
    }
  }

  private applySnapshot = (text: string): void => {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== 'object' || parsed === null) {
      return
    }
    const snapshot = parsed as Partial<Snapshot>
    const dirs = Array.isArray(snapshot.dirs) ? snapshot.dirs : []
    const files = Array.isArray(snapshot.files) ? snapshot.files : []
    // 保留默认目录树的系统文件，不覆盖用户数据
    for (const dir of dirs) {
      if (typeof dir.path !== 'string') {
        continue
      }
      const path = normalizePath(dir.path)
      if (path === '/' || this.nodes.has(path)) {
        continue
      }
      this.nodes.set(path, { kind: 'dir', mtime: dir.mtime || Date.now(), mode: dir.mode ?? 0o755 })
    }
    for (const file of files) {
      if (typeof file.path !== 'string' || typeof file.b64 !== 'string') {
        continue
      }
      const path = normalizePath(file.path)
      if (path === '/' || this.nodes.has(path)) {
        continue
      }
      try {
        this.nodes.set(path, {
          kind: 'file',
          bytes: base64ToBytes(file.b64),
          mtime: file.mtime || Date.now(),
          mode: file.mode ?? 0o644,
        })
      } catch {
        // 单个文件坏了不影响其他文件
      }
    }
  }

  // ---------- 导入导出 ----------

  /** 导出虚拟机镜像（zip：manifest + 文件树） */
  exportImage = async (): Promise<Blob> => {
    await this.persist()
    const snapshot = this.snapshot()
    const files: Record<string, Uint8Array> = {}
    files['manifest.json'] = strToU8(
      JSON.stringify(
        {
          name: 'nanovm-slim',
          version: FORMAT_VERSION,
          exportAt: new Date().toISOString(),
          limits: this.limits,
          files: snapshot.files.length,
          bytes: snapshot.files.reduce(
            (sum, file) => sum + Math.floor((file.b64.length * 3) / 4),
            0
          ),
        },
        null,
        2
      )
    )
    for (const file of snapshot.files) {
      files[`root${file.path}`] = base64ToBytes(file.b64)
    }
    // 空目录也要带上，导入后结构一致
    const dirs = snapshot.dirs.map((dir) => dir.path).filter((path) => path !== '/')
    files['dirs.json'] = strToU8(JSON.stringify(dirs))
    return new Blob([zipSync(files, { level: 6 }) as Uint8Array<ArrayBuffer>], {
      type: 'application/zip',
    })
  }

  /** 导入虚拟机镜像，replace 会先清空现有文件 */
  importImage = async (bytes: Uint8Array, mode: 'merge' | 'replace'): Promise<number> => {
    const entries = unzipSync(bytes)
    let manifest: { version?: number } = {}
    const manifestBytes = entries['manifest.json']
    if (manifestBytes) {
      try {
        manifest = JSON.parse(strFromU8(manifestBytes)) as { version?: number }
      } catch {
        throw new VmError('EINVAL', 'invalid VM image: manifest.json is not JSON')
      }
    }
    const dirsBytes = entries['dirs.json']
    const dirs: string[] = dirsBytes ? (JSON.parse(strFromU8(dirsBytes)) as string[]) : []
    if (mode === 'replace') {
      this.nodes.clear()
      this.mountDefaults()
    }
    for (const dir of dirs) {
      if (typeof dir !== 'string') {
        continue
      }
      try {
        this.mkdir(normalizePath(dir), true)
      } catch {
        // 冲突时跳过
      }
    }
    let imported = 0
    for (const [path, data] of Object.entries(entries)) {
      if (!path.startsWith('root/') || path.endsWith('/') || path.includes('__MACOSX')) {
        continue
      }
      const target = normalizePath(path.slice('root'.length))
      try {
        this.mkdir(dirName(target), true)
        this.write(target, data)
        imported += 1
      } catch {
        // 超出容量或路径冲突时跳过，导入数量如实返回
      }
    }
    await this.persist()
    void manifest
    return imported
  }

  /** 清空所有用户文件，回到出厂状态 */
  reset = async (): Promise<void> => {
    this.nodes.clear()
    this.mountDefaults()
    await this.persist()
    this.emit()
  }
}

// ---------- base64 ----------

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export const base64ToBytes = (text: string): Uint8Array => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

export type NanovmFS = NanoFs

/** 全局唯一的虚拟文件系统 */
export const vmFs = new NanoFs()

/** 启动时恢复文件系统；失败也不阻塞应用 */
export const hydrateNanovmFs = async (): Promise<void> => {
  try {
    await vmFs.hydrate()
  } catch {
    // 忽略：默认目录树已经挂好
  }
}
