import { create } from 'zustand'
import { translate } from '../../i18n/index.js'
import {
  loadCheerpX,
  type CheerpXDataDevice,
  type CheerpXIDBDevice,
  type CheerpXLinux,
  type CheerpXMount,
} from './cheerpx.js'
import { readCoiState, type CoiState } from './coi.js'
import { webVMCommandParts, webVMConfig, webVMImageUrl, webVMCacheKey } from './config.js'

/**
 * WebVM（CheerpX）的会话状态。
 *
 * 与 NanoVM 不同，CheerpX 是一个完整的 x86 Debian：启动慢、磁盘云端流式读取，
 * 但一旦起来就是一个真正的 Linux 终端（bash、gcc、python3、node、git……）。
 * 这里只维护一个 Linux 实例和一个 PTY；状态放在模块级变量里，所以切到 NanoVM
 * 再切回来时进程和文件系统都还在。
 */

export type WebVmStatus = 'idle' | 'coi' | 'loading' | 'connecting' | 'booting' | 'ready' | 'error'

export type WebVmBusy = 'import' | 'export' | 'env' | null

type WebVmState = {
  status: WebVmStatus
  /** 启动阶段的一句话说明（不参与错误展示） */
  detail: string | null
  error: string | null
  /** 从创建 Linux 到第一条输出的耗时 */
  bootMs: number | null
  startedAt: number | null
  coi: CoiState
  coiReason: string | null
  busy: WebVmBusy
  /** 自增令牌：终端据此清屏 */
  clearToken: number
}

const MAX_BUFFER_BYTES = 256 * 1024
const MAX_CAPTURE_BYTES = 32 * 1024 * 1024
const BOOT_TIMEOUT_MS = 180_000
const DEFAULT_COLS = 100
const DEFAULT_ROWS = 30

export const useWebVM = create<WebVmState>(() => {
  const coi = readCoiState()
  return {
    status: coi.state === 'isolated' ? 'idle' : 'coi',
    detail: null,
    error: null,
    bootMs: null,
    startedAt: null,
    coi: coi.state,
    coiReason: coi.reason ?? null,
    busy: null,
    clearToken: 0,
  }
})

export type WebVmOutputListener = (chunk: Uint8Array) => void

type Capture = {
  chunks: Uint8Array[]
  hidden: boolean
  done: boolean
  bytes: number
  overflow: boolean
  token: string
  text: string
  /** 看到结束标记时调用，runCaptured 的 await 随之返回 */
  finish: (() => void) | null
}

let linux: CheerpXLinux | null = null
let dataDevice: CheerpXDataDevice | null = null
let idbDevice: CheerpXIDBDevice | null = null
let consoleWriter: ((buffer: Uint8Array, vt: number) => void) | null = null
let sendKey: ((keyCode: number) => void) | null = null
let listeners = new Set<WebVmOutputListener>()
let buffered: Uint8Array[] = []
let bufferedBytes = 0
let size = { cols: DEFAULT_COLS, rows: DEFAULT_ROWS }
let bootPromise: Promise<void> | null = null
let bootGeneration = 0
let bootTimer: ReturnType<typeof setTimeout> | null = null
let firstOutput = false
let disposed = false
let bootStartedAt = 0
let capture: Capture | null = null
let agentQueue: Promise<unknown> = Promise.resolve()
let inputQueue: number[] = []
let inputTimer: number | null = null

const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

const concatChunks = (chunks: Uint8Array[]): Uint8Array => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.length
  }
  return merged
}

const pushBuffered = (chunk: Uint8Array) => {
  buffered.push(chunk)
  bufferedBytes += chunk.length
  while (bufferedBytes > MAX_BUFFER_BYTES && buffered.length > 1) {
    const removed = buffered.shift()
    bufferedBytes -= removed?.length ?? 0
  }
}

const forward = (chunk: Uint8Array) => {
  if (listeners.size === 0) {
    pushBuffered(chunk)
    return
  }
  for (const listener of listeners) {
    listener(chunk)
  }
}

/** 终端之外的一行提示（Agent 回显、导入导出结果），不写进 VM 的 stdin */
const emitSynthetic = (text: string) => {
  if (!text) {
    return
  }
  // 合成提示只进终端，不写进当前捕获缓冲（否则会混进 Agent 的 stdout）
  forward(bytesOf(text))
}

const markOutput = () => {
  if (firstOutput) {
    return
  }
  firstOutput = true
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  useWebVM.setState({
    status: 'ready',
    bootMs: bootStartedAt > 0 ? Date.now() - bootStartedAt : null,
    detail: null,
    error: null,
  })
}

const handleOutput = (buffer: Uint8Array, vt: number) => {
  if (vt !== 1) {
    return
  }
  const chunk = buffer.slice()
  if (capture && !capture.done) {
    capture.bytes += chunk.length
    if (capture.bytes > MAX_CAPTURE_BYTES) {
      capture.overflow = true
      capture.finish?.()
    } else {
      capture.chunks.push(chunk)
      // 标记是 ASCII，逐块解码足够；这里只用于判断结束，不用于拼接最终输出
      capture.text += new TextDecoder().decode(chunk)
      if (new RegExp(`${capture.token}_E:-?\\d+`).test(capture.text)) {
        capture.finish?.()
      }
    }
    if (capture.hidden) {
      return
    }
  }
  markOutput()
  forward(chunk)
}

/** 订阅终端输出；返回取消订阅函数。挂载前的输出会在这里补发。 */
export const subscribeWebVmOutput = (listener: WebVmOutputListener): (() => void) => {
  listeners.add(listener)
  if (buffered.length > 0) {
    const merged = concatChunks(buffered)
    buffered = []
    bufferedBytes = 0
    listener(merged)
  }
  return () => {
    listeners.delete(listener)
  }
}

/**
 * CheerpX 的控制台输入在粘贴一长串字符时偶尔会丢键（WebVM 官方也是逐字符同步
 * 写入）。这里用 2ms 的节奏把字符喂进去：人手输入感觉不到，粘贴一整条命令也
 * 不会丢字符；Ctrl+C / Ctrl+D 这类单字符控制直接插队，保证能立刻中断。
 */
const pumpInput = () => {
  inputTimer = null
  if (!sendKey || inputQueue.length === 0) {
    return
  }
  const code = inputQueue.shift()
  if (code === undefined) {
    return
  }
  sendKey(code)
  inputTimer = window.setTimeout(pumpInput, 2)
}

const dropInput = () => {
  inputQueue = []
  if (inputTimer !== null) {
    window.clearTimeout(inputTimer)
    inputTimer = null
  }
}

export const sendWebVmText = (text: string): boolean => {
  if (!sendKey) {
    return false
  }
  if (text.length === 1 && (text === '\x03' || text === '\x04' || text === '\u001b')) {
    dropInput()
    sendKey(text.charCodeAt(0))
    return true
  }
  for (let index = 0; index < text.length; index += 1) {
    inputQueue.push(text.charCodeAt(index))
  }
  if (inputTimer === null) {
    pumpInput()
  }
  return true
}

export const sendWebVmKey = (keyCode: number): boolean => {
  if (!sendKey) {
    return false
  }
  sendKey(keyCode)
  return true
}

/** xterm 尺寸变化时调用；CheerpX 允许重新设置控制台大小，stty 会同步 */
export const resizeWebVm = (cols: number, rows: number) => {
  const nextCols = Math.max(20, Math.min(320, Math.round(cols)))
  const nextRows = Math.max(5, Math.min(120, Math.round(rows)))
  if (nextCols === size.cols && nextRows === size.rows) {
    return
  }
  size = { cols: nextCols, rows: nextRows }
  if (!linux || !consoleWriter) {
    return
  }
  try {
    sendKey = linux.setCustomConsole(consoleWriter, nextCols, nextRows)
  } catch {
    // 控制台正在切换时偶发失败，下一次 resize 会再试
  }
}

export const clearWebVmScreen = () => {
  useWebVM.setState((state) => ({ clearToken: state.clearToken + 1 }))
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === 'string' ? error : String(error)

const shellEnv = [
  'HOME=/home/user',
  'TERM=xterm',
  'USER=user',
  'SHELL=/bin/bash',
  'EDITOR=vim',
  'LANG=C.UTF-8',
  'LC_ALL=C',
  'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
  'BASH_FUNC_sudo%%=() { if [ "$(id -u)" -eq 0 ]; then "$@"; return $?; fi; if [ $# -eq 0 ]; then echo "usage: sudo command (root password: password)" >&2; return 1; fi; if [ "$1" = "-i" ] || [ "$1" = "-s" ]; then exec su - root; fi; su -c "$*" root; }',
]

export type WebVmRunResult = {
  code: number
  output: string
}

/* eslint-disable no-control-regex -- 终端控制序列就是控制字符，必须按原样匹配 */
/** 去掉 ANSI / OSC / 回车，保留纯文本；Agent 输出和设置页检测都靠它 */
const cleanAnsi = (value: string): string =>
  value
    .replace(/\u001b\][^\x07]*(?:\x07|\u001b\\)/g, '')
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b[()][A-Za-z0-9]/g, '')
    .replace(/\r/g, '')
/* eslint-enable no-control-regex */

const parseRun = (raw: string, token: string, fallbackCode: number): WebVmRunResult => {
  const text = cleanAnsi(raw)
  // 输入的命令会被 tty 回显，里面也带着 token 字面量；真正的结束标记带数字，
  // 所以从最后一个 `token_E:<数字>` 往前找最后一个 `token_B`。
  const ends = [...text.matchAll(new RegExp(`${token}_E:(-?\\d+)`, 'g'))]
  const last = ends.at(-1)
  if (!last || last.index === undefined) {
    return { code: fallbackCode, output: text.trim() }
  }
  const endIndex = last.index
  const beginIndex = text.lastIndexOf(`${token}_B`, endIndex)
  if (beginIndex < 0) {
    return { code: fallbackCode, output: text.trim() }
  }
  const body = text.slice(beginIndex + `${token}_B`.length, endIndex)
  return {
    code: Number(last[1]),
    output: body.replace(/^\n/, '').replace(/\n$/, ''),
  }
}

const randomToken = () =>
  `WEBVM_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

/**
 * 在交互式 shell 里跑一条命令并捕获输出。
 *
 * 注意：不能用 `cx.run()` 起第二个进程——CheerpX 的 Linux 只有一个控制台，
 * 子进程结束后交互式 bash 仍然在，但 stdin 不再回到它，用户之后敲什么都没反应。
 * 这里改成把命令写进只读 DataDevice 的 /data/agent_xxx.sh，再在**现有 shell**
 * 里 `bash /data/...`，用开始/结束标记把输出框出来。这样终端输入始终属于同一个
 * bash，导入导出和模型调用都不会把用户的 shell 弄坏。
 */
const runCaptured = async (
  command: string,
  options: { timeoutMs: number; hidden: boolean; signal?: AbortSignal }
): Promise<WebVmRunResult> => {
  if (!linux || !dataDevice) {
    throw new Error('WebVM 还没有启动')
  }
  const token = randomToken()
  const seconds = Math.max(1, Math.ceil(options.timeoutMs / 1000))
  const scriptPath = `/agent_${token}.sh`
  await dataDevice.writeFile(scriptPath, command)
  const remote = `/data${scriptPath}`
  const line =
    `printf '\\n%s_B\\n' '${token}'; ` +
    `timeout ${seconds} bash ${shellQuote(remote)}; __webvm_code=$?; ` +
    `printf '\\n%s_E:%d\\n' '${token}' "$__webvm_code"`

  let finish: (() => void) | null = null
  const finished = new Promise<void>((resolve) => {
    finish = resolve
  })
  const current: Capture = {
    chunks: [],
    hidden: options.hidden,
    done: false,
    bytes: 0,
    overflow: false,
    token,
    text: '',
    finish: () => {
      finish?.()
    },
  }
  capture = current
  const onAbort = () => finish?.()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (!sendWebVmText(`${line}\r`)) {
    capture = null
    throw new Error('WebVM 终端还没有连接')
  }

  let timedOut = false
  const timer = window.setTimeout(() => {
    timedOut = true
    finish?.()
  }, options.timeoutMs + 8000)
  try {
    await finished
    current.done = true
    if (capture === current) {
      capture = null
    }
    if (options.signal?.aborted) {
      throw new Error('已取消')
    }
    if (current.overflow) {
      throw new Error('命令输出过大，已丢弃（上限 32MB）')
    }
    const raw = new TextDecoder().decode(concatChunks(current.chunks))
    const result = parseRun(raw, token, timedOut ? 124 : 0)
    if (timedOut) {
      throw new Error(`命令执行超时（${Math.round(options.timeoutMs / 1000)}s）`)
    }
    return result
  } finally {
    window.clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
    current.done = true
    if (capture === current) {
      capture = null
    }
  }
}

/** 启动或等待引擎；失败时抛出当前错误。 */
export const ensureWebVmLinux = async (): Promise<CheerpXLinux> => {
  if (linux) {
    return linux
  }
  await bootWebVm()
  if (!linux) {
    const state = useWebVM.getState()
    throw new Error(state.error ?? 'WebVM 启动失败')
  }
  return linux
}

const runShellLoop = (
  file: string,
  args: string[],
  options: { uid: number; gid: number; env: string[] } = {
    uid: 1000,
    gid: 1000,
    env: shellEnv,
  }
) => {
  const current = linux
  if (!current) {
    return
  }
  const loop = async () => {
    let quickExits = 0
    while (!disposed && linux === current) {
      try {
        const started = Date.now()
        const result = await current.run(file, args, {
          env: options.env,
          cwd: '/home/user',
          uid: options.uid,
          gid: options.gid,
        })
        const elapsed = Date.now() - started
        if (disposed || linux !== current) {
          return
        }
        emitSynthetic(
          `\r\n\u001b[33m[WebVM] shell exited (${result.status}); restarting…\u001b[0m\r\n`
        )
        quickExits = elapsed < 1500 ? quickExits + 1 : 0
        if (quickExits >= 3) {
          useWebVM.setState({
            status: 'error',
            error: translate('webvmShellExit'),
          })
          return
        }
        await sleep(400)
      } catch (error) {
        if (disposed || linux !== current) {
          return
        }
        useWebVM.setState({ status: 'error', error: describe(error) })
        return
      }
    }
  }
  void loop()
}

/**
 * 启动 WebVM：加载 CheerpX → 连接云端 ext2 → 创建 Linux → 启动 bash。
 * 这个函数不会重复创建实例，也不抛异常；调用方读 store 判断结果。
 */
export const bootWebVm = async (): Promise<void> => {
  if (bootPromise) {
    return bootPromise
  }
  if (linux && useWebVM.getState().status === 'ready') {
    return
  }
  // 上一次 shell 异常退出但 Linux 实例还在：先释放，避免叠加两个实例
  if (linux && useWebVM.getState().status === 'error') {
    try {
      linux.delete?.()
    } catch {
      // 已经退出时 delete 可能抛错，忽略
    }
    linux = null
    sendKey = null
  }
  const coi = readCoiState()
  if (coi.state !== 'isolated') {
    useWebVM.setState({
      status: 'coi',
      coi: coi.state,
      coiReason: coi.reason ?? null,
      detail: null,
    })
    return
  }
  useWebVM.setState({
    status: 'loading',
    detail: translate('webvmPhaseRuntime'),
    error: null,
    bootMs: null,
    startedAt: Date.now(),
    coi: 'isolated',
    coiReason: null,
  })
  disposed = false
  firstOutput = false
  bootStartedAt = 0
  const generation = ++bootGeneration
  bootPromise = (async () => {
    try {
      const mod = await loadCheerpX()
      if (generation !== bootGeneration) {
        return
      }
      useWebVM.setState({ status: 'connecting', detail: translate('webvmPhaseDisk') })
      const config = webVMConfig()
      const url = webVMImageUrl(config)
      let cloud
      try {
        cloud = await mod.CloudDevice.create(url)
      } catch (error) {
        // WebVM 自己的回退逻辑：wss 失败时试同地址的 https
        if (url.startsWith('wss://')) {
          useWebVM.setState({ detail: translate('webvmPhaseDiskRetry') })
          cloud = await mod.CloudDevice.create(`https://${url.slice('wss://'.length)}`)
        } else {
          throw error
        }
      }
      idbDevice = await mod.IDBDevice.create(webVMCacheKey(config))
      const overlay = await mod.OverlayDevice.create(cloud, idbDevice)
      dataDevice = await mod.DataDevice.create()
      useWebVM.setState({ status: 'booting', detail: translate('webvmPhaseBoot') })
      bootStartedAt = Date.now()
      const mounts: CheerpXMount[] = [
        { type: 'ext2', path: '/', dev: overlay },
        { type: 'dir', path: '/data', dev: dataDevice },
        { type: 'devs', path: '/dev' },
        { type: 'devpts', path: '/dev/pts' },
        { type: 'proc', path: '/proc' },
        { type: 'sys', path: '/sys' },
      ]
      linux = await mod.Linux.create({ mounts })
      if (generation !== bootGeneration) {
        try {
          linux.delete?.()
        } catch {
          // 启动期间被停止，忽略清理错误
        }
        linux = null
        return
      }
      consoleWriter = (buffer, vt) => handleOutput(buffer, vt)
      sendKey = linux.setCustomConsole(consoleWriter, size.cols, size.rows)
      const parts = webVMCommandParts(config)
      runShellLoop(parts.file, parts.args)
      if (bootTimer) {
        clearTimeout(bootTimer)
      }
      bootTimer = setTimeout(() => {
        if (!firstOutput && useWebVM.getState().status === 'booting') {
          useWebVM.setState({ status: 'error', error: translate('webvmBootTimeout') })
        }
      }, BOOT_TIMEOUT_MS)
    } catch (error) {
      linux = null
      sendKey = null
      useWebVM.setState({
        status: 'error',
        detail: null,
        error: describe(error),
      })
      throw error
    } finally {
      bootPromise = null
    }
  })()
  try {
    await bootPromise
  } catch {
    // 错误已经写进 store，交给 UI 展示
  }
}

/** 停止并释放 CheerpX 实例；IndexedDB 覆盖层保留，下次启动仍在。 */
export const stopWebVm = () => {
  disposed = true
  bootGeneration += 1
  if (bootTimer) {
    clearTimeout(bootTimer)
    bootTimer = null
  }
  capture = null
  dropInput()
  const current = linux
  linux = null
  sendKey = null
  dataDevice = null
  idbDevice = null
  if (current) {
    try {
      current.delete?.()
    } catch {
      // 已经退出或引擎内部报错，忽略
    }
  }
  useWebVM.setState({ status: 'idle', detail: null, bootMs: null, startedAt: null })
}

/** 只重启进程，不动覆盖层（启动失败、手动停止后重试用） */
export const restartWebVm = async (): Promise<void> => {
  stopWebVm()
  firstOutput = false
  await bootWebVm()
}

/** 清空覆盖层并重启；wipe=false 时只重启进程 */
export const resetWebVm = async (wipe = true): Promise<void> => {
  const cache = idbDevice
  stopWebVm()
  if (wipe && cache) {
    await cache.reset()
  }
  firstOutput = false
  await bootWebVm()
}

export const setWebVmBusy = (busy: WebVmBusy) => {
  useWebVM.setState({ busy })
}

const sleepMs = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 等 shell 真正吐出第一行输出再往里写命令。
 * Linux.create 返回时 bash 可能还没开始读 stdin，这时把命令打进控制台会被丢掉。
 */
export const waitForWebVmReady = async (
  timeoutMs = 150_000,
  signal?: AbortSignal
): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (signal?.aborted) {
      throw new Error('已取消')
    }
    const state = useWebVM.getState()
    if (state.status === 'ready') {
      return
    }
    if (state.status === 'error') {
      throw new Error(state.error ?? 'WebVM 启动失败')
    }
    await sleepMs(200)
  }
  throw new Error(translate('webvmBootTimeout'))
}

const ensureReady = async (signal?: AbortSignal): Promise<void> => {
  await ensureWebVmLinux()
  await waitForWebVmReady(150_000, signal)
  if (!linux) {
    throw new Error('WebVM 还没有启动')
  }
}

/** Agent 执行一条命令：串行、超时、隐藏原始控制台流，结束后回显结果。 */
export const execWebVmCommand = async (
  command: string,
  options: { timeoutMs: number; signal?: AbortSignal; echo?: boolean } = { timeoutMs: 30_000 }
): Promise<WebVmRunResult> => {
  await ensureReady(options.signal)
  if (options.signal?.aborted) {
    throw new Error('已取消')
  }
  const run = async () => {
    if (options.echo !== false) {
      emitSynthetic(`\r\n\u001b[36m[agent]\u001b[0m ${command}\r\n`)
    }
    const result = await runCaptured(command, {
      timeoutMs: options.timeoutMs,
      hidden: true,
      signal: options.signal,
    })
    if (result.output) {
      emitSynthetic(`${result.output}\r\n`)
    } else {
      emitSynthetic('(no output)\r\n')
    }
    return result
  }
  const next = agentQueue.then(run, run)
  agentQueue = next.catch(() => undefined)
  return next
}

const sanitizeName = (name: string): string => {
  const cleaned = name
    // eslint-disable-next-line no-control-regex -- 文件名里的控制字符要清掉
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/^\.+/, '')
    .trim()
  return (cleaned || 'file').slice(0, 120)
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export type WebVmImportResult = { count: number; output: string }

/**
 * 导入文件：把内容写进只读 DataDevice（/data/f0…），再在 VM 里用脚本 cp 到
 * /home/user/imports。DataDevice 不接受带目录的路径，所以文件名逐个转义。
 */
export const importWebVmFiles = async (files: File[]): Promise<WebVmImportResult> => {
  await ensureReady()
  if (!dataDevice) {
    throw new Error('WebVM 还没有启动')
  }
  if (files.length === 0) {
    return { count: 0, output: '' }
  }
  if (files.length > 50) {
    throw new Error(translate('webvmImportTooMany'))
  }
  const total = files.reduce((sum, file) => sum + file.size, 0)
  if (total > 20 * 1024 * 1024) {
    throw new Error(translate('webvmImportTooBig'))
  }
  setWebVmBusy('import')
  try {
    const lines = ['mkdir -p /home/user/imports']
    const used = new Set<string>()
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]
      let name = sanitizeName(file.name)
      if (used.has(name)) {
        const dot = name.lastIndexOf('.')
        name = dot > 0 ? `${name.slice(0, dot)}-${index}${name.slice(dot)}` : `${name}-${index}`
      }
      used.add(name)
      await dataDevice.writeFile(`/f${index}`, new Uint8Array(await file.arrayBuffer()))
      lines.push(`cp ${shellQuote(`/data/f${index}`)} ${shellQuote(`/home/user/imports/${name}`)}`)
    }
    lines.push(`echo imported-${files.length}`)
    await dataDevice.writeFile('/import.sh', lines.join('\n'))
    const result = await runCaptured('/bin/sh /data/import.sh', {
      timeoutMs: 30_000,
      hidden: true,
    })
    emitSynthetic(
      `\r\n\u001b[36m[WebVM]\u001b[0m 已导入 ${files.length} 个文件到 /home/user/imports\r\n`
    )
    if (result.code !== 0) {
      emitSynthetic(`${result.output}\r\n`)
      throw new Error(`导入脚本退出码 ${result.code}`)
    }
    return { count: files.length, output: result.output }
  } finally {
    setWebVmBusy(null)
  }
}

/** 导出 /home/user 为 tar.gz；base64 在 VM 内生成，避免把二进制直接灌进终端 */
export const exportWebVmHome = async (): Promise<Blob> => {
  await ensureReady()
  setWebVmBusy('export')
  try {
    const result = await runCaptured('tar czf - -C /home/user . 2>/dev/null | base64 -w0', {
      timeoutMs: 120_000,
      hidden: true,
    })
    const base64 = result.output.replace(/[^A-Za-z0-9+/=]/g, '')
    if (!base64) {
      throw new Error(translate('webvmExportEmpty'))
    }
    const binary = atob(base64)
    const bytes = new Uint8Array(binary.length)
    for (let index = 0; index < binary.length; index += 1) {
      bytes[index] = binary.charCodeAt(index)
    }
    if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
      throw new Error(translate('webvmExportBad'))
    }
    emitSynthetic(`\r\n\u001b[36m[WebVM]\u001b[0m 已导出 /home/user（${bytes.length} B）\r\n`)
    return new Blob([bytes], { type: 'application/gzip' })
  } finally {
    setWebVmBusy(null)
  }
}

/** 检测镜像里预装的命令与语言运行时，设置页直接展示结果 */
export const checkWebVmEnvironment = async (): Promise<string> => {
  await ensureReady()
  setWebVmBusy('env')
  try {
    const result = await runCaptured(
      [
        'echo "uname: $(uname -srm)"',
        'echo "debian: $(cat /etc/debian_version 2>/dev/null || echo unknown)"',
        'for c in bash sh ls cat grep sed awk tar gzip curl wget git gcc g++ make python3 pip3 node npm ruby perl lua5.3 luajit vim nano; do',
        '  if command -v "$c" >/dev/null 2>&1; then printf "%-9s %s\\n" "$c" "$(command -v "$c")"; else printf "%-9s missing\\n" "$c"; fi;',
        'done',
      ].join('\n'),
      { timeoutMs: 20_000, hidden: true }
    )
    return result.output
  } finally {
    setWebVmBusy(null)
  }
}

/** 仅供测试/调试：当前是否有存活的 Linux 实例 */
export const webVmRunning = (): boolean => linux !== null
