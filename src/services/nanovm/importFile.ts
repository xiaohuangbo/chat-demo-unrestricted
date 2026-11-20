import { DISK_MAX_MB, fileLimitMB, nanoVMConfig, setNanoVMConfig } from './config.js'
import { dirName, hydrateNanovmFs, resolvePath, vmFs } from './fs.js'
import {
  hydrateWorkspace,
  readWorkspaceFile,
  useWorkspace,
  workspaceFileBytes,
} from '../workspace/store.js'

/**
 * 把单个文件直接写入 NanoVM（不走 shell，也不经过 base64 命令行）。
 *
 * 用户可以在设置 → 虚拟机里从本机或工作区选文件；Agent 通过 nanovm_import
 * 工具读取工作区文件后调用同一套逻辑。写入前会按需自动扩容虚拟磁盘，
 * 避免 46MB 这类大文件被默认 64MB 磁盘 / 32MB 单文件上限挡住。
 */

const MB = 1024 * 1024
/** 单文件硬上限与 fs 的 fileLimitMB 上限保持一致 */
const HARD_FILE_LIMIT_MB = 256

export type VmImportOptions = {
  /** 目标目录，默认 /home/user */
  targetDir?: string
  /** 完整目标路径；以 / 结尾或已存在目录时按目录处理 */
  targetPath?: string
  /** 同名时覆盖；false 会自动改名 */
  overwrite?: boolean
}

export type VmImportResult = {
  path: string
  bytes: number
  /** 自动扩容后的磁盘配额（MB），没有扩容时为 null */
  grownTo: number | null
  /** 同名覆盖了已有文件 */
  overwritten: boolean
}

export class VmImportError extends Error {
  constructor(
    readonly reason: 'too-large' | 'no-name' | 'workspace-missing' | 'workspace-empty',
    message: string
  ) {
    super(message)
    this.name = 'VmImportError'
  }
}

const baseName = (path: string): string => path.split('/').filter(Boolean).pop() ?? ''
const stem = (name: string): { base: string; ext: string } => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? { base: name.slice(0, dot), ext: name.slice(dot) } : { base: name, ext: '' }
}

/** 文件名只保留末段，替换路径分隔符与 shell 不友好的字符 */
const safeName = (input: string): string =>
  baseName(input)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 180)

const uniquePath = (dir: string, name: string): string => {
  const target = resolvePath(dir, name)
  if (!vmFs.exists(target)) {
    return target
  }
  const { base, ext } = stem(name)
  for (let index = 2; index < 1000; index += 1) {
    const candidate = resolvePath(dir, `${base}-${index}${ext}`)
    if (!vmFs.exists(candidate)) {
      return candidate
    }
  }
  return resolvePath(dir, `${base}-${Date.now()}${ext}`)
}

/** 按文件大小与当前用量扩容磁盘：单文件上限是磁盘的一半，所以至少需要 2 倍文件大小 */
const ensureCapacity = (bytes: number): number | null => {
  const config = nanoVMConfig()
  const usage = vmFs.usage()
  const fileMB = bytes / MB
  const needed = Math.max(
    config.diskMB,
    Math.ceil(fileMB * 2) + 4,
    Math.ceil((usage.bytes + bytes) / MB) + 8
  )
  if (needed <= config.diskMB) {
    return null
  }
  if (needed > DISK_MAX_MB) {
    throw new VmImportError('too-large', `文件超过虚拟机单文件上限（${HARD_FILE_LIMIT_MB} MB）`)
  }
  setNanoVMConfig({ diskMB: needed })
  return needed
}

/** 供其他工具链安装使用：按总字节数扩容虚拟磁盘，返回扩容后的配额 */
export const ensureVmCapacity = (bytes: number): number | null => ensureCapacity(bytes)

const writeBytes = async (
  name: string,
  bytes: Uint8Array,
  options: VmImportOptions = {}
): Promise<VmImportResult> => {
  const clean = safeName(name)
  if (!clean) {
    throw new VmImportError('no-name', '文件名为空')
  }
  if (bytes.byteLength === 0) {
    // 空文件也允许导入；这里只做提示性检查，不阻止
  }
  if (bytes.byteLength > HARD_FILE_LIMIT_MB * MB) {
    throw new VmImportError('too-large', `文件超过虚拟机单文件上限（${HARD_FILE_LIMIT_MB} MB）`)
  }
  await hydrateNanovmFs()
  const grownTo = ensureCapacity(bytes.byteLength)
  let dir = resolvePath('/home/user', options.targetDir?.trim() || '/home/user')
  let explicit: string | null = null
  if (options.targetPath?.trim()) {
    const raw = options.targetPath.trim()
    const resolved = resolvePath('/home/user', raw)
    const stat = vmFs.stat(resolved)
    if (raw.endsWith('/') || stat?.kind === 'dir') {
      dir = resolved
    } else {
      explicit = resolved
      dir = dirName(resolved)
    }
  }
  const existingPath = explicit ?? resolvePath(dir, clean)
  const overwritten = vmFs.exists(existingPath) && options.overwrite === true
  const target = overwritten ? existingPath : explicit && !vmFs.exists(explicit) ? explicit : uniquePath(dir, clean)
  vmFs.mkdir(dirName(target), true)
  vmFs.write(target, bytes)
  await vmFs.persist()
  return { path: target, bytes: bytes.byteLength, grownTo, overwritten }
}

/** 本机文件 → NanoVM */
export const importLocalFileToVm = async (
  file: File,
  options: VmImportOptions = {}
): Promise<VmImportResult> =>
  writeBytes(file.name, new Uint8Array(await file.arrayBuffer()), options)

/** 工作区文件 → NanoVM（Agent 也走这里） */
export const importWorkspaceFileToVm = async (
  workspacePath: string,
  options: VmImportOptions = {}
): Promise<VmImportResult> => {
  const state = useWorkspace.getState()
  if (!state.hydrated) {
    await hydrateWorkspace()
  }
  const file = readWorkspaceFile(workspacePath)
  if (!file) {
    throw new VmImportError('workspace-missing', `工作区里没有文件「${workspacePath}」`)
  }
  return writeBytes(file.path, workspaceFileBytes(file), options)
}

/** 文本 / base64 内容 → NanoVM（Agent 生成小文件时用） */
export const importContentToVm = async (
  name: string,
  content: string,
  encoding: 'text' | 'base64',
  options: VmImportOptions = {}
): Promise<VmImportResult> => {
  let bytes: Uint8Array
  if (encoding === 'base64') {
    const binary = atob(content)
    bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
  } else {
    bytes = new TextEncoder().encode(content)
  }
  return writeBytes(name, bytes, options)
}

/** 当前文件上限（给 UI 提示） */
export const vmFileLimitMB = (): number => fileLimitMB(nanoVMConfig().diskMB)
