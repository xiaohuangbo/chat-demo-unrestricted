import { create } from 'zustand'
import { translate } from '../../i18n/index.js'
import { nanoVMConfig } from './config.js'
import { vmFs } from './fs.js'
import { loadEngine, useEngine } from './boot.js'
import type { ToolchainId, ToolchainIO } from './types.js'
import {
  endPybotInteractive,
  pybotTurn,
  resetPybotInteractive,
  startPybotInteractive,
} from './packages.js'

/**
 * 终端会话状态：标签页、输出行、历史、运行中的命令。
 *
 * 这里只管「终端里发生了什么」，不碰 DOM。桌面端右侧停靠与手机端底部面板
 * 共用同一份状态，所以两处看到的是同一个 shell。
 */

export type ShellLineKind = 'input' | 'stdout' | 'stderr' | 'info' | 'error'

export type ShellLine = {
  id: number
  kind: ShellLineKind
  text: string
  /** 输入行显示用的提示符，例如 user@nanovm:~$ */
  prompt?: string
  /** 命令还在跑，追加到这一行而不是新起一行 */
  stream?: boolean
}

export type ShellTab = {
  id: string
  title: string
  cwd: string
  env: Record<string, string>
  lines: ShellLine[]
  history: string[]
  /** 上翻历史的游标，UI 用 ↑↓ 调整 */
  historyIndex: number
  running: boolean
  exitCode: number | null
  /** 是否已经打印过引擎启动信息 */
  booted: boolean
  /** 缺工具链时的提示目标 */
  pendingInstall: ToolchainId | null
  /** 处于 PyBot 交互式对话（输入行不再当 shell 命令） */
  pybotInteractive?: boolean
  /** PyBot -v：每轮显示命中模块与耗时 */
  pybotVerbose?: boolean
  /** PyBot -s 的随机种子，/reset 时重新应用 */
  pybotSeed?: number
}

export type VmKind = 'nanovm' | 'webvm'

type NanoVMState = {
  open: boolean
  /** 手机端全屏终端 */
  expanded: boolean
  activeId: string
  tabs: ShellTab[]
  /** 当前显示的虚拟机：NanoVM 或 WebVM（CheerpX）。切换只换视图，不销毁实例。 */
  activeVm: VmKind
}

/** 每个标签最多保留的输出行数，超出后从最早的开始丢 */
const MAX_LINES = 1200
let nextLineId = 1
let nextTabId = 1

export const defaultEnv = (): Record<string, string> => ({
  PATH: '/usr/bin:/bin',
  HOME: '/home/user',
  HOSTNAME: 'nanovm',
  USER: 'user',
  LANG: 'zh_CN.UTF-8',
  TERM: 'xterm-256color',
  SHELL: '/bin/sh',
  PWD: '/home/user',
})

const createTab = (): ShellTab => ({
  id: `tab-${nextTabId++}`,
  title: translate('nanovmTabName', { n: nextTabId - 1 }),
  cwd: '/home/user',
  env: defaultEnv(),
  lines: [],
  history: [],
  historyIndex: -1,
  running: false,
  exitCode: null,
  booted: false,
  pendingInstall: null,
})

const firstTab = createTab()

export const useNanoVM = create<NanoVMState>(() => ({
  open: false,
  expanded: false,
  activeId: firstTab.id,
  tabs: [firstTab],
  activeVm: 'nanovm',
}))

// ---------- 基础操作 ----------

export const activeTab = (): ShellTab => {
  const state = useNanoVM.getState()
  return state.tabs.find((tab) => tab.id === state.activeId) ?? state.tabs[0]
}

/** 更新某个标签，返回新的 tabs 数组 */
const patchTab = (id: string, patch: (tab: ShellTab) => Partial<ShellTab>) => {
  useNanoVM.setState((state) => ({
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch(tab) } : tab)),
  }))
}

const pushLine = (id: string, line: Omit<ShellLine, 'id'>) => {
  patchTab(id, (tab) => {
    const lines = [...tab.lines, { ...line, id: nextLineId++ }]
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES)
    }
    return { lines }
  })
}

/** 追加流式输出：同类型的最后一行还在流就接着写，否则新起一行 */
const appendStream = (id: string, kind: 'stdout' | 'stderr', text: string) => {
  if (!text) {
    return
  }
  patchTab(id, (tab) => {
    const lines = [...tab.lines]
    const last = lines.at(-1)
    if (last && last.kind === kind && last.stream) {
      lines[lines.length - 1] = { ...last, text: last.text + text }
    } else {
      lines.push({ id: nextLineId++, kind, text, stream: true })
    }
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES)
    }
    return { lines }
  })
}

/**
 * 结束流式行：之后同类型的输出会新起一行。
 * stderr 可能在 stdout 之后追加新行，所以不能只清最后一行，
 * 否则上一条 stdout 会一直带着光标（终端里出现「多个光标」的残影）。
 */
const endStream = (id: string) => {
  patchTab(id, (tab) => ({
    lines: tab.lines.map((line) => (line.stream ? { ...line, stream: false } : line)),
  }))
}

// ---------- 面板开关 ----------

export const openNanoVM = () => {
  useNanoVM.setState({ open: true, activeVm: 'nanovm' })
}

/** 打开面板并切到 WebVM；WebVM 的启动由组件按配置懒执行 */
export const openWebVM = () => {
  useNanoVM.setState({ open: true, activeVm: 'webvm' })
}

/** 切换虚拟机并打开面板（侧栏入口 / 切换器用） */
export const setActiveVm = (activeVm: VmKind) => {
  useNanoVM.setState({ activeVm, open: true })
}

/** 只改当前虚拟机，不改变面板开合（某个虚拟机被关掉时的回退） */
export const setActiveVmOnly = (activeVm: VmKind) => {
  useNanoVM.setState({ activeVm })
}

export const closeNanoVM = () => {
  useNanoVM.setState({ open: false })
}

export const toggleNanoVM = () => {
  useNanoVM.setState((state) =>
    state.open && state.activeVm === 'nanovm' ? { open: false } : { open: true, activeVm: 'nanovm' }
  )
}

export const toggleWebVM = () => {
  useNanoVM.setState((state) =>
    state.open && state.activeVm === 'webvm' ? { open: false } : { open: true, activeVm: 'webvm' }
  )
}

export const setNanoVMExpanded = (expanded: boolean) => {
  useNanoVM.setState({ expanded })
}

// ---------- 标签页 ----------

export const newNanoVMTab = () => {
  const tab = createTab()
  useNanoVM.setState((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }))
}

export const selectNanoVMTab = (id: string) => {
  useNanoVM.setState({ activeId: id })
}

export const closeNanoVMTab = (id: string) => {
  const state = useNanoVM.getState()
  if (state.tabs.length <= 1) {
    clearNanoVMScreen()
    return
  }
  const index = state.tabs.findIndex((tab) => tab.id === id)
  const tabs = state.tabs.filter((tab) => tab.id !== id)
  const activeId = state.activeId === id ? tabs[Math.max(0, index - 1)].id : state.activeId
  useNanoVM.setState({ tabs, activeId })
}

export const clearNanoVMScreen = (id = useNanoVM.getState().activeId) => {
  patchTab(id, () => ({ lines: [] }))
}

/** 用 ↑↓ 翻历史，返回要填进输入框的命令 */
export const browseHistory = (direction: 'up' | 'down'): string => {
  const tab = activeTab()
  if (tab.history.length === 0) {
    return ''
  }
  let index = tab.historyIndex
  if (direction === 'up') {
    index = index < 0 ? tab.history.length - 1 : Math.max(0, index - 1)
  } else {
    index = index < 0 ? -1 : Math.min(tab.history.length - 1, index + 1)
    if (index === tab.history.length - 1 && tab.historyIndex === tab.history.length - 1) {
      index = -1
    }
  }
  patchTab(tab.id, () => ({ historyIndex: index }))
  return index < 0 ? '' : tab.history[index]
}

// ---------- 提示符 ----------

/** ~/work 这种短路径 */
export const shortPath = (cwd: string): string => {
  if (cwd === '/home/user') {
    return '~'
  }
  if (cwd.startsWith('/home/user/')) {
    return `~${cwd.slice('/home/user'.length)}`
  }
  return cwd
}

export const promptFor = (tab: ShellTab): string => {
  if (tab.pybotInteractive) {
    return 'user>'
  }
  const user = tab.env.USER || 'user'
  const host = tab.env.HOSTNAME || 'nanovm'
  return `${user}@${host}:${shortPath(tab.cwd)}$`
}

/** `pybot` / `pybot -i` 这类没有 -p 的调用进入交互式聊天；-h / --version 仍走一次性的 CLI */
const parsePybotInteractive = (
  raw: string
): { verbose: boolean; seed?: number } | null => {
  const tokens = raw.split(/\s+/).filter(Boolean)
  if (tokens[0] !== 'pybot') {
    return null
  }
  const args = tokens.slice(1)
  if (args.some((arg) => arg === '-p' || arg === '--prompt')) {
    return null
  }
  if (args.some((arg) => ['-h', '--help', '--version'].includes(arg))) {
    return null
  }
  const seedIndex = args.findIndex((arg) => arg === '-s' || arg === '--seed')
  const seedRaw = seedIndex >= 0 ? args[seedIndex + 1] : undefined
  const seed = seedRaw && /^-?\d+$/.test(seedRaw) ? Number(seedRaw) : undefined
  return {
    verbose: args.includes('-v') || args.includes('--verbose'),
    seed,
  }
}

const pybotIo = (): ToolchainIO => ({
  stdin: '',
  stdout: () => {},
  stderr: () => {},
  fs: vmFs,
  cwd: '/home/user',
  env: defaultEnv(),
})

// ---------- 执行 ----------

/** 输出按 40ms 批量刷新，避免长输出把 React 打爆 */
const createFlusher = (tabId: string) => {
  const buffers = { stdout: '', stderr: '' }
  let timer: ReturnType<typeof setTimeout> | null = null
  const flush = () => {
    timer = null
    appendStream(tabId, 'stdout', buffers.stdout)
    appendStream(tabId, 'stderr', buffers.stderr)
    buffers.stdout = ''
    buffers.stderr = ''
  }
  return {
    push: (text: string, stream: 'stdout' | 'stderr') => {
      buffers[stream] += text
      if (!timer) {
        timer = setTimeout(flush, 40)
      }
    },
    finalize: () => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      flush()
      endStream(tabId)
    },
  }
}

let controller: AbortController | null = null

/** 中断当前命令（Ctrl+C） */
export const interruptNanoVM = () => {
  controller?.abort()
}

/** 打印引擎启动信息（只打一次） */
const bootBanner = (tabId: string) => {
  const info = useEngine.getState().info
  pushLine(tabId, {
    kind: 'info',
    text: translate('nanovmLineBoot', {
      applets: info?.applets ?? 0,
      memory: info?.wasmMemoryMB ?? nanoVMConfig().memoryMB,
      ms: info?.bootMs ?? 0,
    }),
  })
}

/** 在标签页里启动 PyBot 交互式聊天（首次加载约 8 秒） */
const startPybotTab = async (
  tabId: string,
  raw: string,
  options: { verbose: boolean; seed?: number }
): Promise<number> => {
  const tab = useNanoVM.getState().tabs.find((item) => item.id === tabId)
  if (!tab) {
    return 1
  }
  pushLine(tabId, { kind: 'input', text: raw, prompt: promptFor(tab) })
  patchTab(tabId, () => ({ running: true, pybotInteractive: true, pybotVerbose: options.verbose, pybotSeed: options.seed }))
  pushLine(tabId, { kind: 'info', text: 'PyBot: 正在加载 64 万行规则…（首次约 8 秒）' })
  try {
    await startPybotInteractive(pybotIo(), { seed: options.seed })
    pushLine(tabId, {
      kind: 'info',
      text: 'PyBot: 已就绪，直接输入消息开始聊天；/reset 清空对话，/help 查看命令，/exit 返回 shell。',
    })
    patchTab(tabId, () => ({ running: false, exitCode: 0 }))
    return 0
  } catch (error) {
    patchTab(tabId, () => ({ running: false, pybotInteractive: false, exitCode: 1 }))
    pushLine(tabId, {
      kind: 'error',
      text: `pybot: ${error instanceof Error ? error.message : String(error)}`,
    })
    return 1
  }
}

/** PyBot 会话里的一行输入：命令或聊天消息 */
const submitPybotMessage = async (
  tabId: string,
  tab: ShellTab,
  raw: string
): Promise<number> => {
  pushLine(tabId, { kind: 'input', text: raw, prompt: promptFor(tab) })
  const command = raw.trim().toLowerCase()
  if (command === '/exit' || command === '/quit' || command === '/bye') {
    endPybotInteractive()
    patchTab(tabId, () => ({ pybotInteractive: false, pybotVerbose: undefined, pybotSeed: undefined }))
    pushLine(tabId, { kind: 'info', text: '已退出 PyBot，回到 shell。' })
    return 0
  }
  if (command === '/reset') {
    resetPybotInteractive()
    pushLine(tabId, { kind: 'info', text: 'PyBot: 新对话开始，之前的上下文已清空。' })
    return 0
  }
  if (command === '/help') {
    pushLine(tabId, {
      kind: 'info',
      text: 'PyBot 命令：直接输入消息聊天；/reset 清空对话；/help 显示帮助；/exit 返回 shell。',
    })
    return 0
  }
  if (!raw.trim()) {
    return 0
  }
  patchTab(tabId, () => ({ running: true }))
  try {
    const result = pybotTurn(raw)
    pushLine(tabId, { kind: 'stdout', text: `pybot: ${result.reply}` })
    if (tab.pybotVerbose) {
      pushLine(tabId, {
        kind: 'info',
        text: `[module: ${result.module || 'none'} | ${Math.round(result.ms)} ms]`,
      })
    }
    patchTab(tabId, () => ({ running: false, exitCode: 0 }))
    return 0
  } catch (error) {
    patchTab(tabId, () => ({ running: false, exitCode: 1 }))
    pushLine(tabId, {
      kind: 'error',
      text: `pybot: ${error instanceof Error ? error.message : String(error)}`,
    })
    return 1
  }
}

/**
 * 执行一条命令：回显 → 懒加载引擎 → 流式输出 → 更新 cwd / env。
 * 返回退出码，`running` 期间重复调用会被忽略。
 */
export const submitNanoVMCommand = async (
  input: string,
  tabId = useNanoVM.getState().activeId
): Promise<number | null> => {
  const raw = input.trim()
  const tab = useNanoVM.getState().tabs.find((item) => item.id === tabId)
  if (!tab || tab.running || !raw) {
    return null
  }
  // clear 是终端自己的事，不交给 shell
  if (raw === 'clear' || raw === 'cls') {
    clearNanoVMScreen(tabId)
    return 0
  }

  // PyBot 交互式会话：后续输入按聊天消息处理，/exit 回到 shell
  if (tab.pybotInteractive) {
    return submitPybotMessage(tabId, tab, raw)
  }
  const pybotStart = parsePybotInteractive(raw)
  if (pybotStart) {
    return startPybotTab(tabId, raw, pybotStart)
  }

  pushLine(tabId, { kind: 'input', text: raw, prompt: promptFor(tab) })
  patchTab(tabId, (current) => ({
    running: true,
    // 连续重复的命令只记一次，最多保留 500 条
    history:
      current.history.at(-1) === raw ? current.history : [...current.history, raw].slice(-500),
    historyIndex: -1,
    pendingInstall: null,
  }))

  const engine = await loadEngine()
  if (!engine) {
    pushLine(tabId, { kind: 'error', text: translate('nanovmLineEngineUnavailable') })
    patchTab(tabId, () => ({ running: false, exitCode: 127 }))
    return 127
  }
  if (!tab.booted) {
    bootBanner(tabId)
    patchTab(tabId, () => ({ booted: true }))
  }

  controller = new AbortController()
  const flusher = createFlusher(tabId)
  const config = nanoVMConfig()
  try {
    const response = await engine.exec({
      line: raw,
      cwd: tab.cwd,
      env: tab.env,
      timeoutMs: config.timeoutMs,
      signal: controller.signal,
      onOutput: (text, stream) => flusher.push(text, stream),
    })
    flusher.finalize()
    patchTab(tabId, () => ({
      cwd: response.cwd,
      env: response.env,
      running: false,
      exitCode: response.code,
      pendingInstall: response.install ?? null,
    }))
    if (response.install) {
      pushLine(tabId, {
        kind: 'info',
        text: translate('nanovmLineInstallHint', {
          name: response.install,
          id: response.install,
        }),
      })
    }
    if (response.aborted) {
      pushLine(tabId, { kind: 'info', text: translate('nanovmLineAborted') })
    }
    return response.code
  } catch (error) {
    flusher.finalize()
    const reason = error instanceof Error ? error.message : String(error)
    pushLine(tabId, { kind: 'error', text: reason })
    patchTab(tabId, () => ({ running: false, exitCode: 1 }))
    return 1
  } finally {
    controller = null
  }
}

/**
 * 给 Agent 工具用的静默执行：与用户终端共用引擎和文件系统，
 * 但用独立的 cwd / env，避免模型把用户的终端目录改乱。
 * 输出会以 info 行的形式回显在终端里（终端打开时）。
 */
let agentCwd = '/home/user'
let agentEnv: Record<string, string> = defaultEnv()

export type AgentShellOutput = {
  code: number
  stdout: string
  stderr: string
  install?: ToolchainId
  cwd: string
}

export const execAgentShell = async (
  line: string,
  options: { timeoutMs: number; signal?: AbortSignal; echo?: boolean } = { timeoutMs: 15_000 }
): Promise<AgentShellOutput> => {
  const state = useNanoVM.getState()
  const tabId = state.tabs[0]?.id
  if (state.open && tabId) {
    pushLine(tabId, { kind: 'input', text: line, prompt: '[agent]$' })
  }
  if (!state.open && tabId) {
    // 终端没打开时也记一行，方便用户事后查看
    pushLine(tabId, { kind: 'input', text: line, prompt: '[agent]$' })
  }
  const engine = await loadEngine()
  if (!engine) {
    const message = translate('nanovmLineEngineUnavailable')
    return { code: 127, stdout: '', stderr: message, cwd: agentCwd }
  }
  let stdout = ''
  let stderr = ''
  const response = await engine.exec({
    line,
    cwd: agentCwd,
    env: agentEnv,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    onOutput: (text, stream) => {
      if (stream === 'stdout') {
        stdout += text
      } else {
        stderr += text
      }
    },
    silent: true,
  })
  agentCwd = response.cwd
  agentEnv = response.env
  return {
    code: response.code,
    stdout,
    stderr,
    install: response.install,
    cwd: agentCwd,
  }
}

/** 重置 Agent 的工作目录与环境（重置虚拟机后调用） */
export const resetAgentShell = () => {
  agentCwd = '/home/user'
  agentEnv = defaultEnv()
}

/** 重置虚拟机后清理所有标签的输出与状态 */
export const resetNanoVMSession = () => {
  resetAgentShell()
  endPybotInteractive()
  const tabs = useNanoVM.getState().tabs
  for (const tab of tabs) {
    patchTab(tab.id, () => ({
      cwd: '/home/user',
      env: defaultEnv(),
      lines: [],
      history: [],
      historyIndex: -1,
      running: false,
      exitCode: null,
      booted: false,
      pendingInstall: null,
      pybotInteractive: false,
      pybotVerbose: undefined,
      pybotSeed: undefined,
    }))
  }
}

// ---------- 用量 ----------

export type VmUsageSnapshot = {
  bytes: number
  files: number
  dirs: number
  diskMB: number
  memoryMB: number
  /** 虚拟机文件是否落在 OPFS 上 */
  opfs: boolean
}

let usageCache: VmUsageSnapshot | null = null

/**
 * 文件系统与配额的快照，UI 用 useSyncExternalStore 订阅。
 * 内容没变时返回同一个对象，避免 useSyncExternalStore 每次都判定为「变了」。
 */
export const vmUsageSnapshot = (): VmUsageSnapshot => {
  const usage = vmFs.usage()
  const config = nanoVMConfig()
  const next: VmUsageSnapshot = {
    bytes: usage.bytes,
    files: usage.files,
    dirs: usage.dirs,
    diskMB: config.diskMB,
    memoryMB: config.memoryMB,
    opfs: usage.opfs,
  }
  if (
    usageCache &&
    usageCache.bytes === next.bytes &&
    usageCache.files === next.files &&
    usageCache.dirs === next.dirs &&
    usageCache.diskMB === next.diskMB &&
    usageCache.memoryMB === next.memoryMB &&
    usageCache.opfs === next.opfs
  ) {
    return usageCache
  }
  usageCache = next
  return next
}

export const subscribeVmUsage = (listener: () => void) => vmFs.subscribe(listener)
