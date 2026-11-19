import { useEngine } from '../boot.js'
import { nanoVMConfig } from '../config.js'
import {
  TOOLCHAIN_IDS,
  isToolchainId,
  toolchainHint,
  toolchainSizeMB,
  uninstallToolchain,
  usePackages,
} from '../packages.js'
import type { Applet, AppletContext, AppletResult, ToolchainIO, ToolchainId } from '../types.js'
import { humanSize, needToolchain } from './helpers.js'
import { addService, readServices, removeService, type ServiceKind } from '../net/virtual.js'

/**
 * 按需工具链命令：python3 / python / node / lua / sqlite3 / esbuild / make / git /
 * npm / pip / vm。
 *
 * 这一组命令本身很小，真正的运行时（Pyodide、wasmoon、sql.js、esbuild-wasm、
 * Worker 沙箱、git 对象库、Makefile 构建器）都在 `packages.ts` 里按需加载。
 * 没安装时返回 127 + install 提示，UI 会显示「安装」按钮。
 */

const labelOf = (id: ToolchainId): string => usePackages.getState().states[id].label

const nameOf = (id: ToolchainId): string => (id === 'python' ? 'python3' : id)

/** 执行工具链并把输出缓冲成 AppletResult */
const runToolchain = async (
  ctx: AppletContext,
  id: ToolchainId,
  argv: string[]
): Promise<AppletResult> => {
  let stdout = ''
  let stderr = ''
  const io: ToolchainIO = {
    stdin: ctx.stdin,
    stdout: (text) => {
      stdout += text
    },
    stderr: (text) => {
      stderr += text
    },
    fs: ctx.fs,
    cwd: ctx.cwd,
    env: ctx.env,
    signal: ctx.signal,
  }
  const result = await ctx.toolchains.run(id, argv, io)
  if (result.error && !stderr.includes(result.error)) {
    stderr += `${nameOf(id)}: ${result.error}\n`
  }
  return { code: result.code, stdout, stderr }
}

const pythonApplet = (name: 'python3' | 'python'): Applet => ({
  name,
  summary: 'Python 3 运行时（Pyodide 版 CPython），首次使用按需下载',
  summaryEn: 'Python 3 runtime (Pyodide CPython), downloaded on first use',
  usage: `${name} [-c "代码"] [脚本.py] [参数...]`,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed('python')) {
      return needToolchain('python', `${name}: 未安装 Python 运行时（约 12MB）\n`)
    }
    return runToolchain(ctx, 'python', ctx.argv.slice(1))
  },
})

const nodeApplet: Applet = {
  name: 'node',
  summary: '浏览器内置的 Node.js 兼容运行时（Web Worker），无需下载',
  summaryEn: 'Built-in Node.js-compatible runtime (Web Worker), no download',
  usage: 'node [-v] [-e "代码"] [脚本.js] [参数...]',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed('node')) {
      return needToolchain(
        'node',
        'node: 未安装 Node.js 运行时，执行 vm install node 启用（无需下载）\n'
      )
    }
    return runToolchain(ctx, 'node', ctx.argv.slice(1))
  },
}

const gitApplet: Applet = {
  name: 'git',
  summary: '内置 git 实现（真 git 对象格式），无需下载',
  summaryEn: 'Built-in git implementation with real object format, no download',
  usage: 'git <子命令> [参数]（git help 看支持范围）',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed('git')) {
      return needToolchain('git', 'git: 未启用内置 Git，执行 vm install git 启用（无需下载）\n')
    }
    return runToolchain(ctx, 'git', ctx.argv.slice(1))
  },
}

const npmApplet: Applet = {
  name: 'npm',
  summary: '不支持：NanoVM Slim 没有 npm',
  summaryEn: 'Not supported: NanoVM Slim has no npm',
  usage: 'npm',
  run: (): AppletResult => ({
    code: 127,
    stderr: 'npm: NanoVM Slim 不支持 npm 安装，请用内置 git / python 运行时\n',
  }),
}

/**
 * pip：走 Pyodide 自带的 micropip，只能装纯 Python 包（带 C 扩展的包没有 wasm 轮子）。
 * 真正的安装在 Python 工具链里实现，这里只做「有没有装 Python」的门禁。
 */
const pipApplet: Applet = {
  name: 'pip',
  summary: '安装纯 Python 包（Pyodide micropip），带 C 扩展的包不支持',
  summaryEn: 'Install pure-Python packages through Pyodide micropip',
  usage: 'pip install <包...> | pip list | pip --version',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed('python')) {
      return needToolchain(
        'python',
        'pip: 需要 Python 运行时（约 12MB），先执行 vm install python\n'
      )
    }
    return runToolchain(ctx, 'python', ['pip', ...ctx.argv.slice(1)])
  },
}

const VM_HELP = [
  '用法：vm <子命令>',
  '',
  '  vm info            引擎版本、命令数、内存、磁盘与工具链状态',
  '  vm mem             WASM 线性内存用量',
  '  vm df              虚拟磁盘容量与使用率',
  '  vm list            工具链安装状态',
  '  vm install <id>    安装工具链（见 vm list，python / node / lua / sqlite / esbuild / make / git）',
  '  vm uninstall <id>  卸载工具链',
  '  vm serve <端口> <命令>        注册虚拟 HTTP 服务（CGI，curl 127.0.0.1 访问）',
  '  vm serve --static <端口> <目录>  注册静态文件服务',
  '  vm serve --ws <端口> <命令>    注册 WebSocket 单消息服务（wscat 访问）',
  '  vm serve list / rm <端口>      查看或删除服务',
  '  vm export          导出虚拟机镜像',
  '  vm help            这份说明',
  '',
].join('\n')

/**
 * 字节数按量级显示：B / KB / MB。
 * 小流量（几百 KB、几 KB）也必须有可读单位，不能被 toFixed(2) 抹成 0.00 MB；
 * 只有真的拿不到数据（NaN / 负数）才显示破折号。
 */
const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  if (bytes < 1024) {
    return `${Math.round(bytes)} B`
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`
  }
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

/** 「已用」类指标：0 明确标成空闲；只有取不到数据（NaN / 负数）才显示破折号 */
const formatUsage = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—'
  }
  return bytes > 0 ? formatBytes(bytes) : '0 B（空闲）'
}

/** 磁盘用量保持 K/M 的紧凑写法，但 B 级别补上单位 */
const formatDisk = (bytes: number): string => (bytes < 1024 ? `${bytes} B` : humanSize(bytes))

/**
 * 已注册的命令数。
 * `applets/index.ts` 也 import 了本文件，静态 import 会构成循环依赖（lint 会报），
 * 所以只能在 run() 里动态取；引擎信息里的 applets 作为兜底。
 */
const countApplets = async (fallback: number): Promise<number> => {
  try {
    const module = await import('./index.js')
    return module.APPLET_LIST.length
  } catch {
    return fallback
  }
}

const vmInfo = async (ctx: AppletContext): Promise<AppletResult> => {
  const info = useEngine.getState().info
  const memory = ctx.memory()
  const usage = ctx.fs.usage()
  const config = nanoVMConfig()
  const applets = await countApplets(info?.applets ?? 0)
  const toolchains = TOOLCHAIN_IDS.map((id) => {
    const state = usePackages.getState().states[id]
    return `${state.label} ${state.installed ? '✓' : '未安装'}`
  }).join(' · ')
  const totalMB = memory.totalMB > 0 ? memory.totalMB : config.memoryMB
  const lines = [
    `NanoVM Slim ${info?.version ?? '2.7.2'}`,
    `引擎：${info?.wasm === false ? 'JS 兼容内核' : 'WASM Shell Engine'}（异步 chunk 懒加载）`,
  ]
  if (applets > 0) {
    lines.push(`内置命令：${applets} 个`)
  }
  lines.push(
    `WASM 内存：${totalMB} MB 配额，已用 ${formatUsage(memory.usedBytes)}，峰值 ${formatBytes(memory.peakBytes)}`,
    `虚拟磁盘：${config.diskMB} MB 配额，已用 ${formatDisk(usage.bytes)}（${usage.files} 个文件 / ${usage.dirs} 个目录）`,
    `工具链：${toolchains}`
  )
  if (info && info.bootMs > 0) {
    lines.push(`启动耗时：${info.bootMs} ms`)
  }
  return { code: 0, stdout: `${lines.join('\n')}\n` }
}

const vmMem = (ctx: AppletContext): AppletResult => {
  const memory = ctx.memory()
  const totalMB = memory.totalMB > 0 ? memory.totalMB : nanoVMConfig().memoryMB
  const lines = [
    `WASM 内存内核：${memory.wasm ? '是（WebAssembly.Memory）' : '否（JS 回落内核）'}`,
    `配额：${totalMB} MB`,
    `已用：${formatUsage(memory.usedBytes)}`,
    `峰值：${formatBytes(memory.peakBytes)}`,
  ]
  return { code: 0, stdout: `${lines.join('\n')}\n` }
}

const vmDf = (ctx: AppletContext): AppletResult => {
  const usage = ctx.fs.usage()
  const config = nanoVMConfig()
  const capacity = config.diskMB * 1024 * 1024
  const usedPercent = capacity > 0 ? Math.round((usage.bytes / capacity) * 100) : 0
  const lines = [
    '文件系统   容量      已用      可用      使用率   文件数',
    [
      'nanovm'.padEnd(10),
      `${config.diskMB}M`.padEnd(9),
      formatDisk(usage.bytes).padEnd(9),
      formatDisk(Math.max(0, capacity - usage.bytes)).padEnd(9),
      `${usedPercent}%`.padEnd(8),
      String(usage.files),
    ].join(' '),
  ]
  return { code: 0, stdout: `${lines.join('\n')}\n` }
}

const vmList = (): AppletResult => {
  const lines = ['工具链   状态       版本               体积']
  for (const id of TOOLCHAIN_IDS) {
    const state = usePackages.getState().states[id]
    const size = toolchainSizeMB(id) > 0 ? `${toolchainSizeMB(id)} MB` : '内置'
    lines.push(
      [
        state.label.padEnd(8),
        (state.installed ? '已安装' : '未安装').padEnd(8),
        (state.version ?? '—').padEnd(18),
        size,
      ].join(' ')
    )
  }
  lines.push('', `安装：vm install <${TOOLCHAIN_IDS.join('|')}>`)
  return { code: 0, stdout: `${lines.join('\n')}\n` }
}

const progressText = (id: ToolchainId, percent: number): string => {
  const label = labelOf(id)
  const sizeMB = toolchainSizeMB(id)
  return sizeMB > 0 ? `正在下载 ${label} 运行时… ${percent}%` : `正在启用 ${label}… ${percent}%`
}

const vmInstall = async (ctx: AppletContext): Promise<AppletResult> => {
  const target = ctx.argv[2]
  if (!target) {
    return { code: 1, stderr: `vm: 用法 vm install <${TOOLCHAIN_IDS.join('|')}>\n` }
  }
  if (!isToolchainId(target)) {
    return {
      code: 1,
      stderr: `vm: 未知工具链 '${target}'，可选：${TOOLCHAIN_IDS.join('、')}\n`,
    }
  }
  const label = labelOf(target)
  const current = usePackages.getState().states[target]
  if (current.installed) {
    return {
      code: 0,
      stdout: `${label} 已安装${current.version ? `（${current.version}）` : ''}，无需重复安装\n`,
    }
  }
  const lines: string[] = []
  let last = -1
  const onProgress = (progress: number) => {
    const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100)
    if (percent >= last + 10 || percent === 100) {
      last = percent
      lines.push(progressText(target, percent))
    }
  }
  const result = await ctx.toolchains.install(target, onProgress)
  if (!result.ok) {
    lines.push(`${label} 安装失败：${result.error ?? '未知错误'}`)
    return { code: 1, stdout: `${lines.join('\n')}\n` }
  }
  const installed = usePackages.getState().states[target]
  if (lines.length === 0) {
    lines.push(progressText(target, 100))
  }
  const usage = toolchainHint(target)
  lines.push(`${label} 已就绪${installed.version ? `（${installed.version}）` : ''}，试试 ${usage}`)
  return { code: 0, stdout: `${lines.join('\n')}\n` }
}

const vmUninstall = async (ctx: AppletContext): Promise<AppletResult> => {
  const target = ctx.argv[2]
  if (!target || !isToolchainId(target)) {
    return {
      code: 1,
      stderr: `vm: 用法 vm uninstall <${TOOLCHAIN_IDS.join('|')}>\n`,
    }
  }
  if (!ctx.toolchains.installed(target)) {
    return { code: 0, stdout: `${labelOf(target)} 本来就没有安装\n` }
  }
  await uninstallToolchain(target)
  return {
    code: 0,
    stdout: `已卸载 ${labelOf(target)}，运行 vm install ${target} 可以重新安装\n`,
  }
}

/**
 * `vm serve`：把命令登记到虚拟网络。
 *
 * 浏览器里没有常驻进程，所以服务是 CGI 形式的：每次请求按注册的命令跑一次，
 * 环境变量给请求信息、stdin 给请求体、stdout 按 CGI 格式回响应。
 */
const vmServe = (ctx: AppletContext): AppletResult => {
  const args = ctx.argv.slice(2)
  const sub = args[0]
  if (!sub || sub === 'list' || sub === 'ls' || sub === 'status') {
    const services = readServices(ctx.fs)
    if (services.length === 0) {
      return {
        code: 0,
        stdout:
          '还没有注册服务。\n' +
          '  vm serve 3000 "node app.js"        注册 CGI 服务\n' +
          '  vm serve --static 8080 www          注册静态目录\n' +
          '  vm serve --ws 3000 "node ws.js"     注册 WebSocket 服务\n',
      }
    }
    const lines = [
      '端口   类型     命令 / 目录',
      '----- ------  ----------------------------------------',
    ]
    for (const service of services) {
      lines.push(`${String(service.port).padEnd(5)} ${service.kind.padEnd(8)} ${service.command}`)
    }
    lines.push(
      '',
      '访问：curl http://127.0.0.1:<端口>/   · WebSocket：wscat ws://127.0.0.1:<端口>/'
    )
    return { code: 0, stdout: `${lines.join('\n')}\n` }
  }
  if (sub === 'rm' || sub === 'remove' || sub === 'stop' || sub === 'delete') {
    const port = Number.parseInt(args[1] ?? '', 10)
    if (!Number.isInteger(port)) {
      return { code: 1, stderr: 'vm: 用法 vm serve rm <端口>\n' }
    }
    return removeService(ctx.fs, port)
      ? { code: 0, stdout: `已删除端口 ${port} 的服务\n` }
      : { code: 1, stderr: `vm: 端口 ${port} 上没有注册服务\n` }
  }
  let kind: ServiceKind = 'cgi'
  let rest = args
  if (rest[0] === '--static' || rest[0] === '--ws') {
    kind = rest[0] === '--static' ? 'static' : 'ws'
    rest = rest.slice(1)
  }
  const portText = rest[0] ?? ''
  const port = Number.parseInt(portText, 10)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return {
      code: 1,
      stderr: `vm: 端口必须是 1-65535（收到 '${portText}'）\n用法：vm serve [--static|--ws] <端口> <命令>\n`,
    }
  }
  const command = rest.slice(1).join(' ').trim()
  if (kind !== 'static' && command === '') {
    return {
      code: 1,
      stderr: 'vm: 缺少要执行的命令，例如 vm serve 3000 "node app.js"\n',
    }
  }
  addService(ctx.fs, {
    port,
    kind,
    command: kind === 'static' ? command || '.' : command,
    cwd: ctx.cwd,
  })
  const target =
    kind === 'static'
      ? `http://127.0.0.1:${port}/`
      : kind === 'ws'
        ? `ws://127.0.0.1:${port}/`
        : `http://127.0.0.1:${port}/`
  const tool = kind === 'ws' ? 'wscat' : 'curl'
  return {
    code: 0,
    stdout:
      `已注册${kind === 'static' ? '静态' : kind === 'ws' ? 'WebSocket' : ' CGI'}服务：${target}\n` +
      `命令：${command || '.'}\n工作目录：${ctx.cwd}\n` +
      `访问：${tool} ${target}\n`,
  }
}

const vmApplet: Applet = {
  name: 'vm',
  summary: '虚拟机管理：引擎信息、内存、磁盘与工具链按需安装',
  summaryEn: 'VM management: engine info, memory, disk and on-demand toolchains',
  usage: 'vm <info|mem|df|list|install|uninstall|export|help>',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    const subcommand = ctx.argv[1] ?? 'help'
    switch (subcommand) {
      case 'info':
        return vmInfo(ctx)
      case 'mem':
        return vmMem(ctx)
      case 'df':
        return vmDf(ctx)
      case 'list':
        return vmList()
      case 'install':
        return vmInstall(ctx)
      case 'uninstall':
        return vmUninstall(ctx)
      case 'serve':
        return vmServe(ctx)
      case 'export':
        return {
          code: 0,
          stdout: '在 设置 → NanoVM Slim 控制台里导出镜像（vm 命令不支持直接导出）\n',
        }
      case 'help':
      case '--help':
      case '-h':
        return { code: 0, stdout: VM_HELP }
      default:
        return { code: 1, stderr: `vm: 未知子命令 '${subcommand}'\n\n${VM_HELP}` }
    }
  },
}

/** 通用运行时命令：没安装时给安装提示，装好后交给 packages.ts 里的运行时模块 */
const runtimeApplet = (
  name: string,
  id: ToolchainId,
  summary: string,
  summaryEn: string,
  usage: string,
  missing: string
): Applet => ({
  name,
  summary,
  summaryEn,
  usage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed(id)) {
      return needToolchain(id, `${name}: ${missing}（执行 vm install ${id}）\n`)
    }
    return runToolchain(ctx, id, ctx.argv.slice(1))
  },
})

const luaApplet = runtimeApplet(
  'lua',
  'lua',
  'Lua 5.4 运行时（wasmoon），首次使用按需下载',
  'Lua 5.4 runtime (wasmoon), downloaded on first use',
  'lua [-v] [-e "代码"] [脚本.lua] [参数...]',
  '未安装 Lua 运行时（约 0.4MB）'
)

const sqliteApplet = runtimeApplet(
  'sqlite3',
  'sqlite',
  'SQLite 3 命令行（sql.js），直接读写虚拟机里的 .db 文件',
  'SQLite 3 CLI (sql.js) reading and writing .db files in the VM',
  'sqlite3 [数据库.db] [SQL]（用 .tables / .schema / .help 查元信息）',
  '未安装 SQLite 运行时（约 1.3MB）'
)

const esbuildApplet = runtimeApplet(
  'esbuild',
  'esbuild',
  'esbuild 打包器（esbuild-wasm），打包或转译 TS / JS',
  'esbuild bundler (esbuild-wasm) for TS / JS bundle and transform',
  'esbuild 入口.ts [--bundle] [--outfile=out.js] [--minify] [--target=es2020]',
  '未安装 esbuild 打包器（约 12MB）'
)

const tscApplet = runtimeApplet(
  'tsc',
  'typescript',
  'TypeScript 官方编译器（浏览器版），把 .ts / .tsx 转译成 JS',
  'Official TypeScript compiler (browser build) turning .ts / .tsx into JS',
  'tsc [--outfile=out.js|--outdir=dir] [--target=es2020] [--module=esm|cjs] [--sourceMap] 文件...',
  '未安装 TypeScript 编译器（约 9MB）'
)

const sassApplet = runtimeApplet(
  'sass',
  'sass',
  'dart-sass 官方编译器，SCSS / SASS 转 CSS',
  'Official dart-sass compiler turning SCSS / SASS into CSS',
  'sass [--style=expanded|compressed] 输入.scss [输出.css]',
  '未安装 Sass 编译器（约 5.8MB）'
)

const terserApplet = runtimeApplet(
  'terser',
  'terser',
  'Terser 官方 JS 压缩器（压缩 + 变量重命名）',
  'Official Terser JS minifier (compress + mangle)',
  'terser 输入.js [-c] [-m] [-o 输出.js]',
  '未安装 Terser 压缩器（约 1.1MB）'
)

const prettierApplet = runtimeApplet(
  'prettier',
  'prettier',
  'Prettier 官方格式化器（JS / TS / CSS / JSON / Markdown）',
  'Official Prettier formatter (JS / TS / CSS / JSON / Markdown)',
  'prettier [--check|--write] [--parser=类型] 文件...',
  '未安装 Prettier 格式化器（约 2MB）'
)

/**
 * make：内置 Makefile 构建器。
 *
 * 构建配方要用 shell 执行（`$(CC) -o app main.c`），所以它和别的运行时不同：
 * 不走 ToolchainHost.run，而是直接调 runtimes/make.ts 并把 ctx.shell 传进去。
 */
const makeApplet: Applet = {
  name: 'make',
  summary: '内置 Makefile 构建器（变量、目标、依赖、配方）',
  summaryEn: 'Built-in Makefile builder (variables, targets, prerequisites, recipes)',
  usage: 'make [-f Makefile] [-C 目录] [-n] [-B] [-s] [目标...]',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    if (!ctx.toolchains.installed('make')) {
      return needToolchain(
        'make',
        'make: 未启用内置构建器，执行 vm install make 启用（无需下载）\n'
      )
    }
    let stdout = ''
    let stderr = ''
    try {
      const { runMake } = await import('../runtimes/make.js')
      const code = await runMake(ctx.argv.slice(1), {
        fs: ctx.fs,
        cwd: ctx.cwd,
        env: ctx.env,
        stdin: ctx.stdin,
        signal: ctx.signal,
        shell: ctx.shell,
        stdout: (text) => {
          stdout += text
        },
        stderr: (text) => {
          stderr += text
        },
      })
      return { code, stdout, stderr }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return { code: 1, stdout, stderr: `${stderr}make: ${message}\n` }
    }
  },
}

/** 按需工具链命令；顺序即 help 里的展示顺序 */
export const TOOLCHAIN_APPLETS: Applet[] = [
  pythonApplet('python3'),
  pythonApplet('python'),
  nodeApplet,
  luaApplet,
  sqliteApplet,
  esbuildApplet,
  tscApplet,
  sassApplet,
  terserApplet,
  prettierApplet,
  makeApplet,
  gitApplet,
  npmApplet,
  pipApplet,
  vmApplet,
]
