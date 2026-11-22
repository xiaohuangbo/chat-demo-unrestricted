import { create } from 'zustand'
import { unkernelConfig, useUnkernelConfig } from './config.js'

/**
 * unkernel 的宿主状态。
 *
 * unkernel 页面在 iframe 里运行，内核对象由页面暴露在 window.KW.vm；
 * 这个模块只负责打开/关闭面板、等待 boot、执行命令和挂载工作区。
 * 页面保持挂载，关闭面板不会销毁正在运行的 Linux。
 */

export type UnkernelStatus = 'idle' | 'loading' | 'ready' | 'error'

export type UnkernelExecResult = {
  stdout: string
  stderr: string
  exitCode: number | null
  signal: number | null
}


export type UnkernelVm = {
  exec(
    file: string,
    args?: readonly string[],
    opts?: {
      cwd?: string
      env?: Record<string, string>
      input?: string | Uint8Array
      timeout?: number
      signal?: AbortSignal
      encoding?: 'utf8'
    }
  ): Promise<UnkernelExecResult>
  mount(
    path: string,
    fs: unknown,
    opts?: { readOnly?: boolean; timeout?: number }
  ): Promise<{ mounted: boolean; unmount(): Promise<void> }>
  write(data: string | Uint8Array): void
  resize(cols: number, rows: number): void
  stop(): Promise<unknown>
}

type UnkernelWindow = Window & {
  KW?: {
    vm?: UnkernelVm
    started?: boolean
    errors?: Array<{ fatal?: boolean; message?: string }>
  }
}

type UnkernelState = {
  /** 面板是否可见 */
  open: boolean
  /** iframe 是否已经创建过；关闭面板后保持挂载 */
  mounted: boolean
  status: UnkernelStatus
  error: string | null
  /** 工作区是否已挂到 /mnt/workspace */
  workspaceMounted: boolean
  /** 当前的 iframe（用于调试/重载） */
  url: string
}

export const useUnkernel = create<UnkernelState>(() => ({
  open: false,
  mounted: false,
  status: 'idle',
  error: null,
  workspaceMounted: false,
  url: '',
}))

let currentVm: UnkernelVm | null = null
let waitTimer: ReturnType<typeof setTimeout> | null = null

export const openUnkernel = () => {
  if (!useUnkernelConfig.getState().enabled) {
    return
  }
  useUnkernel.setState({ open: true, mounted: true })
}

export const closeUnkernel = () => useUnkernel.setState({ open: false })

export const getUnkernelVm = (): UnkernelVm | null => currentVm

const readFatalError = (win: UnkernelWindow | null): string | null => {
  const errors = win?.KW?.errors
  if (!errors?.length) {
    return null
  }
  const fatal = [...errors].reverse().find((item) => item.fatal)
  if (!fatal) {
    return null
  }
  return fatal.message || 'unkernel 启动失败'
}

/** iframe 加载完成后开始轮询 window.KW.vm（页面是异步启动的） */
export const attachUnkernelFrame = (frame: HTMLIFrameElement) => {
  if (waitTimer) {
    clearTimeout(waitTimer)
    waitTimer = null
  }
  currentVm = null
  useUnkernel.setState({
    status: 'loading',
    error: null,
    workspaceMounted: false,
    url: frame.src,
  })

  const startedAt = Date.now()
  const tick = () => {
    waitTimer = null
    let win: UnkernelWindow | null = null
    try {
      win = frame.contentWindow as UnkernelWindow | null
    } catch {
      win = null
    }
    const vm = win?.KW?.vm
    if (vm) {
      currentVm = vm
      useUnkernel.setState({ status: 'ready', error: null })
      void mountWorkspace(vm)
      return
    }
    const fatal = readFatalError(win)
    if (fatal) {
      useUnkernel.setState({ status: 'error', error: fatal })
      return
    }
    if (Date.now() - startedAt > 120_000) {
      useUnkernel.setState({
        status: 'error',
        error: 'unkernel 在 120 秒内没有启动；请检查浏览器是否支持 JSPI（Chrome/Edge 137+）。',
      })
      return
    }
    waitTimer = setTimeout(tick, 250)
  }
  tick()
}

export const detachUnkernelFrame = () => {
  if (waitTimer) {
    clearTimeout(waitTimer)
    waitTimer = null
  }
  currentVm = null
}

/** 工作区适配器动态加载，避免把 fs 代码塞进首屏 */
const mountWorkspace = async (vm: UnkernelVm) => {
  if (useUnkernel.getState().workspaceMounted) {
    return
  }
  try {
    const { createWorkspaceFs } = await import('./workspaceFs.js')
    const fs = createWorkspaceFs()
    await vm.mount('/mnt/workspace', fs, { timeout: 30_000 })
    useUnkernel.setState({ workspaceMounted: true })
  } catch (error) {
    useUnkernel.setState({
      error: `工作区挂载失败：${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

/**
 * 等待 iframe 里的 unkernel 启动完成；如果需要会先打开面板。
 * Agent 工具调用它，因此模型第一次调用时用户能看到虚拟机界面。
 */
export const waitForUnkernelVm = async (timeoutMs = 180_000): Promise<UnkernelVm> => {
  if (!useUnkernelConfig.getState().enabled) {
    throw new Error('unkernel 未启用')
  }
  openUnkernel()
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (currentVm) {
      return currentVm
    }
    const state = useUnkernel.getState()
    if (state.status === 'error' && state.error) {
      throw new Error(state.error)
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('unkernel 启动超时')
}

/** 在 unkernel 的 Alpine 里执行命令（独立 sh，不打断页面里的交互终端） */
export const execUnkernel = async (
  command: string,
  options: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<UnkernelExecResult> => {
  const vm = await waitForUnkernelVm()
  const timeoutMs = Math.min(
    120_000,
    Math.max(1_000, Math.round(options.timeoutMs ?? unkernelConfig().timeoutMs))
  )
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const abort = () => controller.abort()
  options.signal?.addEventListener('abort', abort, { once: true })
  try {
    return await vm.exec('/bin/sh', ['-lc', command], {
      cwd: options.cwd || '/home/user',
      timeout: Math.min(120_000, timeoutMs + 10_000),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
  }
}

export const resetUnkernelState = () => {
  detachUnkernelFrame()
  useUnkernel.setState({
    open: false,
    mounted: false,
    status: 'idle',
    error: null,
    workspaceMounted: false,
    url: '',
  })
}
