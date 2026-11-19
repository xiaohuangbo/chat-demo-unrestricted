import {
  NODE_PLATFORM,
  NODE_VERSION,
  executeNode,
  type NodeSandboxMessage,
  type NodeSandboxRequest,
  type SandboxFileMap,
} from './nodeRuntime.worker.js'

/**
 * 浏览器里的 Node.js 兼容运行时。
 *
 * 不需要下载任何东西：脚本跑在独立 Web Worker 里，文件快照传进去、改动传回来，
 * 主线程负责写回 NanoVM 的虚拟文件系统。Worker 不可用（旧浏览器、file:// 限制、
 * 测试环境）时回落到主线程执行同一套沙箱——回落路径没有真正的超时中断能力，
 * 死循环会把页面卡住，这一点在 UI 里如实提示。
 */

export { NODE_PLATFORM, NODE_VERSION }
export type { SandboxFileMap }

const DEFAULT_TIMEOUT_MS = 15_000

/** Worker 自带的超时兜底：比沙箱的软超时多一点，留给它把输出写完 */
const WORKER_TIMEOUT_PAD_MS = 2_000

export type NodeRunOptions = {
  /** 要执行的 CommonJS 代码 */
  code: string
  /** process.argv[1] / __filename，相对 cwd 或绝对路径 */
  scriptPath?: string
  /** 脚本参数（不含 node 与脚本自身） */
  argv?: string[]
  env?: Record<string, string>
  cwd?: string
  /** 路径 → 内容 的文件快照 */
  files?: SandboxFileMap
  /** 标准输入；虚拟网络的 CGI 请求体会从这里传给脚本（默认空串） */
  stdin?: string
  timeoutMs?: number
  signal?: AbortSignal
  onStdout?: (text: string) => void
  onStderr?: (text: string) => void
}

export type NodeRunResult = {
  code: number
  /** 改动过或新建的文件 */
  files: SandboxFileMap
  /** 被删掉的文件 */
  removed: string[]
  timedOut: boolean
  aborted: boolean
}

type ResolvedNodeOptions = {
  code: string
  scriptPath: string
  argv: string[]
  env: Record<string, string>
  cwd: string
  files: SandboxFileMap
  stdin: string
  timeoutMs: number
  signal?: AbortSignal
  onStdout: (text: string) => void
  onStderr: (text: string) => void
}

/** rspack 会把这个 new URL 认成 Worker 入口，单独打成一个 chunk */
const createWorker = (): Worker | null => {
  if (typeof Worker === 'undefined') {
    return null
  }
  try {
    return new Worker(new URL('./nodeRuntime.worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return null
  }
}

let detected = false
let mode: 'worker' | 'main-thread' = 'main-thread'

/** 当前实际使用的执行方式，UI 状态栏与测试用它区分 Worker / 主线程 */
export const nodeRuntimeMode = (): 'worker' | 'main-thread' => {
  if (!detected) {
    detected = true
    mode = createWorker() ? 'worker' : 'main-thread'
  }
  return mode
}

const runInWorker = (worker: Worker, options: ResolvedNodeOptions): Promise<NodeRunResult> =>
  new Promise((resolve, reject) => {
    let receivedAny = false
    let settled = false

    const cleanup = () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', onAbort)
      worker.onmessage = null
      worker.onerror = null
    }

    const finish = (result: NodeRunResult) => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }

    const failed = (message: string) => {
      if (settled) {
        return
      }
      if (!receivedAny) {
        // 一帧都没跑就出错：说明 Worker 根本起不来，还可以安全回落到主线程
        settled = true
        cleanup()
        worker.terminate()
        reject(new Error(message))
        return
      }
      options.onStderr(`node: 运行时错误：${message}\n`)
      finish({ code: 1, files: {}, removed: [], timedOut: false, aborted: false })
    }

    const onAbort = () => {
      worker.terminate()
      finish({ code: 130, files: {}, removed: [], timedOut: false, aborted: true })
    }

    const timer = setTimeout(() => {
      // 同步死循环没法在 Worker 内部打断，只能终止整个 Worker
      worker.terminate()
      options.onStderr(`node: 执行超时（超过 ${options.timeoutMs} 毫秒），已终止运行时\n`)
      finish({ code: 124, files: {}, removed: [], timedOut: true, aborted: false })
    }, options.timeoutMs + WORKER_TIMEOUT_PAD_MS)

    worker.onmessage = (event: MessageEvent) => {
      const message = event.data as NodeSandboxMessage
      if (message.type === 'stdout') {
        receivedAny = true
        options.onStdout(message.text)
        return
      }
      if (message.type === 'stderr') {
        receivedAny = true
        options.onStderr(message.text)
        return
      }
      if (message.type === 'done') {
        receivedAny = true
        finish({
          code: message.code,
          files: message.files,
          removed: message.removed,
          timedOut: message.timedOut,
          aborted: message.aborted,
        })
        return
      }
      failed(message.message)
    }

    worker.onerror = (event: ErrorEvent) => {
      failed(event.message || 'Worker 崩溃')
    }

    if (options.signal) {
      if (options.signal.aborted) {
        onAbort()
        return
      }
      options.signal.addEventListener('abort', onAbort, { once: true })
    }

    const request: NodeSandboxRequest = {
      type: 'run',
      code: options.code,
      scriptPath: options.scriptPath,
      argv: options.argv,
      env: options.env,
      cwd: options.cwd,
      files: options.files,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs,
    }
    worker.postMessage(request)
  })

/** 主线程回落：同一套沙箱，但没有真正的强制中断 */
const runInMainThread = async (options: ResolvedNodeOptions): Promise<NodeRunResult> => {
  if (options.signal?.aborted) {
    return { code: 130, files: {}, removed: [], timedOut: false, aborted: true }
  }
  return executeNode({
    code: options.code,
    scriptPath: options.scriptPath,
    argv: options.argv,
    env: options.env,
    cwd: options.cwd,
    files: options.files,
    stdin: options.stdin,
    timeoutMs: options.timeoutMs,
    onStdout: options.onStdout,
    onStderr: options.onStderr,
    shouldAbort: () => options.signal?.aborted === true,
  })
}

/**
 * 执行一段 Node 风格脚本。
 * 优先用 Worker（可强制超时、可中断）；拿不到 Worker 时回落主线程。
 */
export const runNode = async (options: NodeRunOptions): Promise<NodeRunResult> => {
  const resolved: ResolvedNodeOptions = {
    code: options.code,
    scriptPath: options.scriptPath ?? 'index.js',
    argv: options.argv ?? [],
    env: options.env ?? {},
    cwd: options.cwd ?? '/home/user',
    files: options.files ?? {},
    stdin: options.stdin ?? '',
    timeoutMs: Math.max(1000, options.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    signal: options.signal,
    onStdout: options.onStdout ?? (() => undefined),
    onStderr: options.onStderr ?? (() => undefined),
  }
  if (options.signal?.aborted) {
    return { code: 130, files: {}, removed: [], timedOut: false, aborted: true }
  }
  const worker = createWorker()
  if (worker) {
    try {
      return await runInWorker(worker, resolved)
    } catch {
      // Worker 起不来（构造函数成功但脚本加载失败）时安全回落
      worker.terminate()
    }
  }
  detected = true
  mode = 'main-thread'
  return runInMainThread(resolved)
}

/** 把一个目录树打成 Worker 需要的文件快照交给调用方复用 */
export const isNodeRuntimeAvailable = (): boolean => typeof Worker !== 'undefined'
