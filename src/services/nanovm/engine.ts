import { APPLET_LIST } from './applets/index.js'
import { nanoVMConfig } from './config.js'
import { vmFs } from './fs.js'
import { createToolchainHost } from './packages.js'
import { runShell } from './shell/exec.js'
import { createWasmKernel } from './wasm/core.js'
import type { EngineInfo, ExecRequest, ExecResponse, ShellEngine } from './types.js'

/**
 * 引擎工厂。boot.ts 第一次需要执行命令时才会动态 import 这个模块，
 * 也就是说 shell 解析器、应用集、WASM 内核都不在首屏包里。
 *
 * createEngine() 按当前配额实例化 WASM 线性内存并返回单例：内核的内存上限
 * 就是配额（initial == maximum），所以管道缓冲真的受配置约束。
 * 配额改了要重建内核，那是 boot.ts 的 resetEngine() + 再次 createEngine()。
 */

const VERSION = '2.7.2'

let instance: ShellEngine | null = null
let pending: Promise<ShellEngine> | null = null

/** 跨 exec() 记住上一条命令的退出码，让 `$?` 在下一行仍然成立 */
let lastCode = 0

const create = async (memoryMB: number): Promise<ShellEngine> => {
  const started = typeof performance === 'undefined' ? Date.now() : performance.now()
  const kernel = createWasmKernel(memoryMB)
  // 默认目录树（/etc/motd 等）要在第一条命令之前就位
  await vmFs.hydrate()
  const toolchains = createToolchainHost()

  const info: EngineInfo = {
    wasm: true,
    wasmMemoryMB: kernel.totalBytes / (1024 * 1024),
    applets: APPLET_LIST.length,
    version: VERSION,
    bootMs: Math.max(
      0,
      Math.round((typeof performance === 'undefined' ? Date.now() : performance.now()) - started)
    ),
  }

  const exec = async (request: ExecRequest): Promise<ExecResponse> => {
    // 上一次执行如果中途出错，残留的管道缓冲在这里清掉
    kernel.reset()
    try {
      const result = await runShell(
        {
          line: request.line,
          cwd: request.cwd,
          env: request.env,
          lastCode,
        },
        {
          fs: vmFs,
          kernel,
          toolchains,
          timeoutMs: request.timeoutMs,
          signal: request.signal,
          // silent 只表示不希望终端回显，输出照样逐段上交（session.ts 靠它收集结果）
          onOutput: request.onOutput,
        }
      )
      lastCode = result.code
      return {
        code: result.code,
        cwd: result.cwd,
        env: result.env,
        install: result.install,
        aborted: result.aborted,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      request.onOutput?.(`NanoVM: ${message}\n`, 'stderr')
      return { code: 1, cwd: request.cwd, env: request.env, aborted: false }
    }
  }

  const engine: ShellEngine = {
    info,
    boot: async () => info,
    exec,
  }
  return engine
}

/** 引擎单例：并发调用共享同一个 Promise，失败后允许重试 */
let activeMemoryMB = 0

const ensure = async (memoryMB: number): Promise<ShellEngine> => {
  if (instance && activeMemoryMB === memoryMB) {
    return instance
  }
  if (!pending) {
    pending = create(memoryMB).then(
      (engine) => {
        instance = engine
        activeMemoryMB = memoryMB
        pending = null
        return engine
      },
      (error: unknown) => {
        pending = null
        throw error
      }
    )
  }
  const engine = await pending
  // 等待期间配额又被改了：这一次的结果作废，按新配额重建
  const current = nanoVMConfig().memoryMB
  if (activeMemoryMB !== current) {
    return ensure(current)
  }
  return engine
}

/**
 * 取引擎单例。
 *
 * boot.ts 的 resetEngine() 只是丢掉自己的引用；这里按「当前内存配额」判断是否需要
 * 重建 WASM 内核——所以改配额 + resetEngine 之后确实会按新配额重新分配线性内存。
 */
export const createEngine = async (): Promise<ShellEngine> => ensure(nanoVMConfig().memoryMB)
