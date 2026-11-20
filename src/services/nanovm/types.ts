import type { NanovmFS } from './fs.js'

/**
 * NanoVM Slim 的共享契约。
 *
 * 这里只放类型：shell 解析器、应用集（busybox 风格）、文件系统、按需工具链、
 * 以及 UI / Agent 工具共用的执行接口。运行时代码分散在同目录的其他文件里。
 */

/** 虚拟机的可安装工具链（按需加载，不装也能用 busybox） */
export type ToolchainId =
  | 'python'
  | 'node'
  | 'lua'
  | 'sqlite'
  | 'esbuild'
  | 'typescript'
  | 'sass'
  | 'terser'
  | 'prettier'
  | 'make'
  | 'git'
  | 'pybot'

/** 控制台里的分组：运行时 / 构建 / 工具 */
export type ToolchainCategory = 'runtime' | 'build' | 'tool'

/** 工具链安装状态 */
export type ToolchainState = {
  id: ToolchainId
  /** 展示名 */
  label: string
  /** 一句话说明 */
  summary: string
  installed: boolean
  /** 已安装时的版本号 */
  version?: string
  /** 运行时体积（MB），未安装时为预计下载体积 */
  sizeMB: number
  /** 控制台分组 */
  category: ToolchainCategory
  /** 0–1，安装中 */
  progress?: number
  /** 安装失败原因 */
  error?: string
}

/** 应用集在缺工具链时可以请求安装 */
export type ToolchainHost = {
  /** 是否已安装 */
  installed: (id: ToolchainId) => boolean
  /** 安装：完成后 resolve，失败返回错误文案 */
  install: (
    id: ToolchainId,
    onProgress?: (progress: number) => void
  ) => Promise<{ ok: boolean; error?: string }>
  /**
   * 运行工具链：传入 argv（不含命令名）与标准输入，返回退出码。
   * 输出直接写 stdout / stderr。
   */
  run: (
    id: ToolchainId,
    argv: string[],
    io: ToolchainIO
  ) => Promise<{ code: number; error?: string }>
}

export type ToolchainIO = {
  stdin: string
  stdout: (text: string) => void
  stderr: (text: string) => void
  fs: NanovmFS
  cwd: string
  env: Record<string, string>
  signal?: AbortSignal
}

/** shell 内部错误码，应用集用它给出符合 POSIX 习惯的提示 */
export type VmErrno =
  | 'ENOENT'
  | 'ENOTDIR'
  | 'EISDIR'
  | 'EEXIST'
  | 'ENOTEMPTY'
  | 'EACCES'
  | 'ENOSPC'
  | 'EMFILE'
  | 'EINVAL'
  | 'EPERM'
  | 'ENOSYS'

/** 文件系统 / shell 抛出的错误，带 errno 便于应用集翻译成 <cmd>: No such file or directory */
export class VmError extends Error {
  readonly code: VmErrno

  constructor(code: VmErrno, message: string) {
    super(message)
    this.name = 'VmError'
    this.code = code
  }
}

/** errno 对应的英文说明，与 GNU coreutils 的措辞保持一致 */
export const ERRNO_TEXT: Record<VmErrno, string> = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  EACCES: 'Permission denied',
  ENOSPC: 'No space left on device',
  EMFILE: 'Too many open files',
  EINVAL: 'Invalid argument',
  EPERM: 'Operation not permitted',
  ENOSYS: 'Function not implemented',
}

/** 一次命令执行的结果 */
export type ShellRunResult = {
  code: number
  stdout: string
  stderr: string
  /** 命令改变了工作目录 */
  cwd?: string
  /** 命令修改了环境变量 */
  env?: Record<string, string>
  /** 缺少工具链：UI 可以提示安装 */
  install?: ToolchainId
  /** 被 Ctrl+C / 超时打断 */
  aborted?: boolean
}

/** 应用集拿到的执行上下文 */
export type AppletContext = {
  /** 含命令名的参数表 */
  argv: string[]
  /** 标准输入：管道上游的输出，没有则为空串 */
  stdin: string
  fs: NanovmFS
  env: Record<string, string>
  cwd: string
  /** 用户按了 Ctrl+C 或超时 */
  signal?: AbortSignal
  /** 超时时间戳（Date.now() 毫秒），应用集可以在长循环里检查 */
  deadline: number
  toolchains: ToolchainHost
  /** 执行子命令（xargs / find -exec / sh -c 用） */
  shell: ShellApi
  /** 改变工作目录 */
  chdir: (path: string) => void
  /** 设置 / 删除环境变量，值为 null 表示删除 */
  setenv: (name: string, value: string | null) => void
  /** WASM 线性内存用量，`vm mem` / `free` 用 */
  memory: () => { wasm: boolean; totalMB: number; usedBytes: number; peakBytes: number }
}

/** 应用集执行结果 */
export type AppletResult = {
  code: number
  stdout?: string
  stderr?: string
  install?: ToolchainId
}

/** 一个 busybox 风格程序 */
export type Applet = {
  name: string
  /** 一行说明（中文），help / 设置页展示 */
  summary: string
  summaryEn: string
  usage: string
  run: (context: AppletContext) => Promise<AppletResult> | AppletResult
}

/** 应用集内部执行子命令的入口 */
export type ShellApi = {
  run: (
    line: string,
    options?: {
      cwd?: string
      env?: Record<string, string>
      stdin?: string
      /** 静默执行：不显示在终端里 */
      silent?: boolean
    }
  ) => Promise<ShellRunResult>
  /** 展开通配符与变量后的参数（应用集自己解析命令时用） */
  expand: (words: string[], context: { cwd: string; env: Record<string, string> }) => string[]
}

/** 引擎信息：UI 状态栏与控制台展示 */
export type EngineInfo = {
  /** 是否用到了 WebAssembly 内核 */
  wasm: boolean
  /** WASM 线性内存页数换算出的 MB */
  wasmMemoryMB: number
  /** 已注册的 busybox 程序数量 */
  applets: number
  /** 引擎版本 */
  version: string
  /** 启动耗时（毫秒） */
  bootMs: number
}

/** 一次命令执行请求 */
export type ExecRequest = {
  /** 完整命令行，可以带管道、重定向与 && */
  line: string
  cwd: string
  env: Record<string, string>
  timeoutMs: number
  signal?: AbortSignal
  /** 逐段输出，终端实时渲染 */
  onOutput?: (text: string, stream: 'stdout' | 'stderr') => void
  /** 子命令执行（Agent 工具里跑包管理命令） */
  silent?: boolean
}

/** 执行结果 */
export type ExecResponse = {
  code: number
  /** 执行后的工作目录 */
  cwd: string
  /** 执行后的环境变量 */
  env: Record<string, string>
  install?: ToolchainId
  aborted?: boolean
}

/** shell 引擎：懒加载，createEngine() 返回单例 */
export type ShellEngine = {
  info: EngineInfo
  boot: () => Promise<EngineInfo>
  exec: (request: ExecRequest) => Promise<ExecResponse>
}
