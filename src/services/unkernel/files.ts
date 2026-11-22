import { getUnkernelVm, waitForUnkernelVm, type UnkernelVm } from './session.js'
import { mimeForPath, saveWorkspaceFile, uniqueWorkspacePath } from '../workspace/store.js'

/**
 * Unkernel 的文件导入 / 导出。
 *
 * 导入走 vm.exec 的 stdin（cat > 文件），导出走 encoding: 'buffer' 的
 * stdout，两边都不经过 base64 命令行，二进制文件原样进出。目录导出会
 * 在 guest 里用 tar 打包成 .tar.gz。
 */

/** 单次导入的文件上限 */
export const MAX_IMPORT_BYTES = 32 * 1024 * 1024
/** 单次导出的文件 / 压缩包上限 */
export const MAX_EXPORT_BYTES = 48 * 1024 * 1024
/** Agent 单次读取文本的上限 */
export const MAX_READ_BYTES = 64 * 1024

export type GuestPathKind = 'file' | 'dir' | 'none'

export type GuestExport = {
  name: string
  mime: string
  bytes: Uint8Array
  kind: 'file' | 'dir'
  source: string
}

export type GuestImportOutcome = {
  name: string
  path: string
  bytes: number
  ok: boolean
  skipped?: boolean
  error?: string
}

export type GuestTextRead = {
  text: string
  base64?: string
  size: number
  offset: number
  bytesRead: number
  truncated: boolean
  binary: boolean
}

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

export const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let index = 0
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024
    index += 1
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[index]}`
}

/** 规范化 guest 绝对路径；拒绝相对路径、NUL 和越过根目录的 .. */
export const normalizeGuestPath = (input: string): string | null => {
  const raw = input.trim()
  if (!raw || raw.includes('\0') || !raw.startsWith('/')) {
    return null
  }
  const parts: string[] = []
  for (const segment of raw.split('/')) {
    if (!segment || segment === '.') {
      continue
    }
    if (segment === '..') {
      if (!parts.length) {
        return null
      }
      parts.pop()
      continue
    }
    parts.push(segment)
  }
  return `/${parts.join('/')}`
}

export const basenameOf = (path: string): string => {
  const normalized = normalizeGuestPath(path)
  if (!normalized || normalized === '/') {
    return ''
  }
  return normalized.slice(normalized.lastIndexOf('/') + 1)
}

export const parentOf = (path: string): string => {
  const normalized = normalizeGuestPath(path)
  if (!normalized || normalized === '/') {
    return '/'
  }
  const index = normalized.lastIndexOf('/')
  return index <= 0 ? '/' : normalized.slice(0, index)
}

const sanitizeName = (name: string): string =>
  Array.from(name.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '')
    .filter((char) => char.charCodeAt(0) >= 0x20)
    .join('')
    .trim()
    .slice(0, 180)

/** 目标目录 + 文件名；文件名始终只取 basename，避免 ../ 越界 */
export const joinGuestPath = (dir: string, name: string): string | null => {
  const base = normalizeGuestPath(dir)
  const file = sanitizeName(name)
  if (!base || !file) {
    return null
  }
  return base === '/' ? `/${file}` : `${base}/${file}`
}

const runSh = (
  vm: UnkernelVm,
  script: string,
  args: string[],
  options: {
    input?: string | Uint8Array
    timeoutMs?: number
    signal?: AbortSignal
    maxBuffer?: number
  } = {}
) =>
  vm.exec('/bin/sh', ['-c', script, 'sh', ...args], {
    input: options.input,
    timeout: options.timeoutMs ?? 30_000,
    signal: options.signal,
    maxBuffer: options.maxBuffer,
  })

const runShBytes = (
  vm: UnkernelVm,
  script: string,
  args: string[],
  options: {
    input?: string | Uint8Array
    timeoutMs?: number
    signal?: AbortSignal
    maxBuffer?: number
  } = {}
) =>
  vm.exec('/bin/sh', ['-c', script, 'sh', ...args], {
    encoding: 'buffer',
    input: options.input,
    timeout: options.timeoutMs ?? 30_000,
    signal: options.signal,
    maxBuffer: options.maxBuffer ?? MAX_EXPORT_BYTES + 1024 * 1024,
  })

const errorText = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const stderrText = (value: string | Uint8Array): string =>
  typeof value === 'string' ? value : decoder.decode(value)

export const probeGuestPath = async (
  vm: UnkernelVm,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<GuestPathKind> => {
  const result = await runSh(
    vm,
    'if [ -d "$1" ]; then echo dir; elif [ -e "$1" ]; then echo file; else echo none; fi',
    [path],
    { signal: options.signal, timeoutMs: 15_000 }
  )
  const kind = result.stdout.trim()
  return kind === 'dir' || kind === 'file' ? kind : 'none'
}

export const ensureGuestDir = async (vm: UnkernelVm, dir: string): Promise<void> => {
  const result = await vm.exec('/bin/mkdir', ['-p', dir], { timeout: 15_000 })
  if (result.exitCode !== 0) {
    throw new Error(stderrText(result.stderr).trim() || `无法创建目录 ${dir}`)
  }
}

/** 文件大小（字节）；不存在或不是文件时返回 null */
export const guestFileSize = async (
  vm: UnkernelVm,
  path: string,
  options: { signal?: AbortSignal } = {}
): Promise<number | null> => {
  const result = await runSh(vm, 'stat -c %s "$1" 2>/dev/null', [path], {
    signal: options.signal,
    timeoutMs: 15_000,
  })
  const size = Number(result.stdout.trim())
  return result.exitCode === 0 && Number.isFinite(size) ? size : null
}

/** 把字节写入 guest 文件；默认不覆盖 */
export const writeGuestBytes = async (
  vm: UnkernelVm,
  path: string,
  bytes: Uint8Array,
  options: { overwrite?: boolean; signal?: AbortSignal; mode?: number } = {}
): Promise<void> => {
  const target = normalizeGuestPath(path)
  if (!target) {
    throw new Error(`无效的 guest 路径：${path}`)
  }
  const dir = parentOf(target)
  await ensureGuestDir(vm, dir)
  const kind = await probeGuestPath(vm, target, { signal: options.signal })
  if (kind === 'dir') {
    throw new Error(`目标是目录：${target}`)
  }
  if (kind === 'file' && !options.overwrite) {
    throw new Error(`目标已存在：${target}（勾选“覆盖同名文件”后可覆盖）`)
  }
  const result = await runShBytes(vm, 'cat > "$1"', [target], {
    input: bytes,
    signal: options.signal,
    timeoutMs: 60_000,
  })
  if (result.exitCode !== 0) {
    throw new Error(stderrText(result.stderr).trim() || `写入 ${target} 失败`)
  }
  if (options.mode !== undefined) {
    await vm.exec('/bin/chmod', [options.mode.toString(8), target], { timeout: 15_000 })
  }
}

/** 读取 guest 文件的原始字节 */
export const readGuestBytes = async (
  vm: UnkernelVm,
  path: string,
  options: { signal?: AbortSignal; maxBytes?: number } = {}
): Promise<Uint8Array> => {
  const target = normalizeGuestPath(path)
  if (!target) {
    throw new Error(`无效的 guest 路径：${path}`)
  }
  const kind = await probeGuestPath(vm, target, { signal: options.signal })
  if (kind === 'none') {
    throw new Error(`文件不存在：${target}`)
  }
  if (kind === 'dir') {
    throw new Error(`这是一个目录：${target}`)
  }
  const limit = options.maxBytes ?? MAX_EXPORT_BYTES
  const size = await guestFileSize(vm, target, { signal: options.signal })
  if (size !== null && size > limit) {
    throw new Error(`文件太大（${formatBytes(size)}），上限 ${formatBytes(limit)}`)
  }
  const result = await vm.exec('/bin/cat', [target], {
    encoding: 'buffer',
    timeout: 60_000,
    signal: options.signal,
    maxBuffer: limit + 1024 * 1024,
  })
  if (result.exitCode !== 0) {
    throw new Error(stderrText(result.stderr).trim() || `读取 ${target} 失败`)
  }
  return result.stdout
}

/** 读取一段文本（或 base64），供 Agent 查看文件 */
export const readGuestText = async (
  vm: UnkernelVm,
  path: string,
  options: {
    offset?: number
    maxBytes?: number
    base64?: boolean
    signal?: AbortSignal
  } = {}
): Promise<GuestTextRead> => {
  const target = normalizeGuestPath(path)
  if (!target) {
    throw new Error(`无效的 guest 路径：${path}`)
  }
  const kind = await probeGuestPath(vm, target, { signal: options.signal })
  if (kind !== 'file') {
    throw new Error(kind === 'dir' ? `这是一个目录：${target}` : `文件不存在：${target}`)
  }
  const size = (await guestFileSize(vm, target, { signal: options.signal })) ?? 0
  const offset = Math.max(0, Math.min(size, Math.round(options.offset ?? 0)))
  const maxBytes = Math.max(
    1,
    Math.min(
      options.base64 ? MAX_EXPORT_BYTES : MAX_READ_BYTES,
      Math.round(options.maxBytes ?? MAX_READ_BYTES)
    )
  )
  const count = Math.min(maxBytes, Math.max(0, size - offset))
  if (count === 0) {
    return { text: '', size, offset, bytesRead: 0, truncated: offset < size, binary: false }
  }
  const result = await runShBytes(
    vm,
    'tail -c +"$2" "$1" | head -c "$3"',
    [target, String(offset + 1), String(count)],
    { signal: options.signal, timeoutMs: 30_000, maxBuffer: count + 1024 * 1024 }
  )
  if (result.exitCode !== 0) {
    throw new Error(stderrText(result.stderr).trim() || `读取 ${target} 失败`)
  }
  const bytes = result.stdout
  const binary = bytes.includes(0)
  if (options.base64) {
    return {
      text: '',
      base64: bytesToBase64(bytes),
      size,
      offset,
      bytesRead: bytes.length,
      truncated: offset + bytes.length < size,
      binary,
    }
  }
  let text: string
  try {
    text = decoder.decode(bytes)
  } catch {
    text = ''
  }
  return {
    text,
    size,
    offset,
    bytesRead: bytes.length,
    truncated: offset + bytes.length < size,
    binary: binary || text.includes('\uFFFD'),
  }
}

/** 导出 guest 文件（目录打包为 .tar.gz），返回可直接下载的字节 */
export const exportGuestPath = async (
  vm: UnkernelVm,
  inputPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<GuestExport> => {
  const target = normalizeGuestPath(inputPath)
  if (!target) {
    throw new Error(`无效的 guest 路径：${inputPath}`)
  }
  const kind = await probeGuestPath(vm, target, { signal: options.signal })
  if (kind === 'none') {
    throw new Error(`路径不存在：${target}`)
  }
  if (kind === 'file') {
    const size = await guestFileSize(vm, target, { signal: options.signal })
    if (size !== null && size > MAX_EXPORT_BYTES) {
      throw new Error(
        `文件太大（${formatBytes(size)}），单次导出上限 ${formatBytes(MAX_EXPORT_BYTES)}`
      )
    }
    const bytes = await readGuestBytes(vm, target, {
      signal: options.signal,
      maxBytes: MAX_EXPORT_BYTES,
    })
    const name = basenameOf(target) || 'file'
    return { name, mime: mimeForPath(name), bytes, kind: 'file', source: target }
  }

  const base = target === '/' ? 'root' : basenameOf(target)
  const parent = target === '/' ? '/' : parentOf(target)
  const args = target === '/' ? ['-czf', '-', '-C', '/', '.'] : ['-czf', '-', '-C', parent, base]
  const result = await vm.exec('/bin/tar', args, {
    encoding: 'buffer',
    timeout: 120_000,
    signal: options.signal,
    maxBuffer: MAX_EXPORT_BYTES + 1024 * 1024,
  })
  if (result.exitCode !== 0) {
    throw new Error(stderrText(result.stderr).trim() || `打包 ${target} 失败`)
  }
  if (result.stdout.length > MAX_EXPORT_BYTES) {
    throw new Error(
      `压缩包太大（${formatBytes(result.stdout.length)}），单次导出上限 ${formatBytes(MAX_EXPORT_BYTES)}`
    )
  }
  return {
    name: `${base || 'root'}.tar.gz`,
    mime: 'application/gzip',
    bytes: result.stdout,
    kind: 'dir',
    source: target,
  }
}

/** 把本机 File 列表导入 guest 目录 */
export const importGuestFiles = async (
  files: readonly File[],
  destDir: string,
  options: {
    overwrite?: boolean
    signal?: AbortSignal
    onProgress?: (name: string, index: number) => void
  } = {}
): Promise<GuestImportOutcome[]> => {
  const vm = await waitForUnkernelVm()
  const dir = normalizeGuestPath(destDir)
  if (!dir) {
    throw new Error('目标目录必须是绝对路径，例如 /mnt/workspace')
  }
  await ensureGuestDir(vm, dir)
  const outcomes: GuestImportOutcome[] = []
  for (const [index, file] of files.entries()) {
    const name = sanitizeName(file.name) || `file-${index + 1}`
    const target = joinGuestPath(dir, name)
    options.onProgress?.(name, index)
    if (!target) {
      outcomes.push({ name, path: '', bytes: file.size, ok: false, error: '文件名无效' })
      continue
    }
    if (file.size > MAX_IMPORT_BYTES) {
      outcomes.push({
        name,
        path: target,
        bytes: file.size,
        ok: false,
        error: `文件太大（${formatBytes(file.size)}），单次导入上限 ${formatBytes(MAX_IMPORT_BYTES)}`,
      })
      continue
    }
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      await writeGuestBytes(vm, target, bytes, {
        overwrite: options.overwrite,
        signal: options.signal,
      })
      outcomes.push({ name, path: target, bytes: bytes.length, ok: true })
    } catch (error) {
      outcomes.push({
        name,
        path: target,
        bytes: file.size,
        ok: false,
        error: errorText(error),
      })
    }
  }
  return outcomes
}

/** 触发浏览器下载 */
export const downloadGuestExport = (result: GuestExport): void => {
  // 复制一份，确保 Blob 拿到的是普通 ArrayBuffer（Worker 模式下的视图可能背靠 SharedArrayBuffer）
  const bytes = new Uint8Array(result.bytes)
  const blob = new Blob([bytes], { type: result.mime })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = sanitizeName(result.name) || 'download'
  link.rel = 'noopener'
  document.body.append(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)
}

/** 导出到聊天工作区，返回实际保存路径 */
export const saveGuestExportToWorkspace = (result: GuestExport): string => {
  const wanted = uniqueWorkspacePath(`unkernel/${sanitizeName(result.name) || 'download'}`)
  const saved = saveWorkspaceFile(wanted, { bytes: result.bytes, mime: result.mime })
  if (!saved.ok) {
    const reasons: Record<string, string> = {
      path: '路径无效',
      tooLarge: '文件超过工作区单文件上限',
      tooManyFiles: '工作区文件数量已满',
      totalTooLarge: '工作区总容量不足',
      quota: '浏览器存储空间不足',
    }
    throw new Error(reasons[saved.reason] ?? saved.reason)
  }
  return saved.file.path
}

/** 导出 guest 路径到工作区（文件或目录压缩包） */
export const exportGuestToWorkspace = async (
  inputPath: string,
  options: { signal?: AbortSignal } = {}
): Promise<{ workspacePath: string; export: GuestExport }> => {
  const vm = await waitForUnkernelVm()
  const result = await exportGuestPath(vm, inputPath, options)
  return { workspacePath: saveGuestExportToWorkspace(result), export: result }
}

export const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  const chunk = 0x8000
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk))
  }
  return btoa(binary)
}

export const base64ToBytes = (value: string): Uint8Array => {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

/** 当前页面的 vm；不启动虚拟机（Agent 的只读工具用） */
export const currentUnkernelVm = (): UnkernelVm | null => getUnkernelVm()

/** 文本编码为 UTF-8 字节（Agent 写文件用） */
export const textBytes = (text: string): Uint8Array => encoder.encode(text)

/** 下载 / 保存到工作区时用的文件名清理 */
export const safeDownloadName = sanitizeName
