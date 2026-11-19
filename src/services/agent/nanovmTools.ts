import { nanoVMAgentAvailable } from '../nanovm/config.js'
import { hydrateNanovmFs, resolvePath, vmFs } from '../nanovm/fs.js'
import { execAgentShell } from '../nanovm/session.js'
import type { FsEntry } from '../nanovm/fs.js'
import type { AgentTool } from './tools.js'
import { clip, fail, num, ok, str } from './tools.js'

/**
 * NanoVM Slim 的 Agent 工具：在浏览器里的虚拟机上执行命令、看文件、装工具链。
 *
 * 和工作区工具一样，这里不碰真实磁盘。三个工具都走 NanoVM 的开关：
 * shell 需要「启用 + 允许模型调用」，安装工具链会发出网络请求（Pyodide），
 * 所以默认都要求用户确认。
 */

/** 单次输出最多回传给模型多少字符 */
const MAX_OUTPUT = 20_000

/** 最多列多少个文件，避免把上下文撑爆 */
const MAX_ENTRIES = 500

const formatSize = (bytes: number): string => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unit]}`
}

const stampOf = (time: number): string => {
  const date = new Date(time)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

const describeEntry = (entry: FsEntry, withPath: boolean): string => {
  const name = withPath
    ? `${entry.path}${entry.kind === 'dir' ? '/' : ''}`
    : `${entry.name}${entry.kind === 'dir' ? '/' : ''}`
  const kind = entry.kind === 'dir' ? '目录' : '文件'
  const size = entry.kind === 'dir' ? '—' : formatSize(entry.size)
  return `- ${name}｜${kind}｜${size}｜更新于 ${stampOf(entry.mtime)}`
}

const shellTool: AgentTool = {
  id: 'nanovm_shell',
  label: 'NanoVM Shell',
  labelEn: 'NanoVM shell',
  summary: '在浏览器内的 NanoVM Slim 虚拟机里执行命令；执行前需要确认。',
  summaryEn: 'Run a command in the in-browser NanoVM Slim VM; asks for confirmation.',
  description:
    '在浏览器内的 NanoVM Slim 虚拟机里执行一条 shell 命令（busybox 风格 + 按需工具链）。' +
    '文件都在虚拟机里，不会碰本机磁盘。支持管道、重定向、&&；需要 Python / Node.js / Git 时' +
    '先用 nanovm_install 安装，或直接执行命令并按提示安装。返回退出码与标准输出 / 标准错误。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令行，例如 ls -l /home/user' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 15000，最大 120000' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  run: async (input, context) => {
    if (!nanoVMAgentAvailable()) {
      return fail('NanoVM Slim 未启用或未允许模型调用')
    }
    const command = str(input, 'command').trim()
    if (!command) {
      return fail('command 不能为空')
    }
    const requested = num(input, 'timeout_ms') ?? 15_000
    const timeoutMs = Math.min(120_000, Math.max(1000, Math.round(requested)))
    context.progress(`正在 NanoVM 里执行：${command}`)
    const result = await execAgentShell(command, { timeoutMs, signal: context.signal })
    const lines = [`退出码：${result.code}`, `工作目录：${result.cwd}`]
    const stdout = clip(result.stdout, MAX_OUTPUT)
    const stderr = clip(result.stderr, MAX_OUTPUT)
    if (stdout) {
      lines.push('', 'stdout:', stdout)
    }
    if (stderr) {
      lines.push('', 'stderr:', stderr)
    }
    if (!stdout && !stderr) {
      lines.push('', '（没有输出）')
    }
    if (result.install) {
      lines.push(
        '',
        `提示：这条命令需要「${result.install}」工具链，可用 nanovm_install 安装（tool="${result.install}"）。`
      )
    }
    return ok(lines.join('\n'))
  },
}

const lsTool: AgentTool = {
  id: 'nanovm_ls',
  label: 'NanoVM 文件列表',
  labelEn: 'NanoVM list files',
  summary: '列出 NanoVM Slim 虚拟机里的文件（路径、大小、类型），只读。',
  summaryEn: 'List files inside the NanoVM Slim VM (path, size, type); read-only.',
  description:
    '列出 NanoVM Slim 虚拟文件系统里的文件，返回路径、大小、类型与更新时间。' +
    '相对路径以 /home/user 为基准；recursive=true 会递归列出整棵子树。只读操作，不会修改任何文件。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列的目录或文件，默认 /home/user' },
      recursive: { type: 'boolean', description: '是否递归列出子目录，默认 false' },
    },
    required: [],
    additionalProperties: false,
  },
  risk: 'safe',
  run: async (input) => {
    await hydrateNanovmFs()
    const raw = str(input, 'path').trim()
    const path = resolvePath('/home/user', raw || '/home/user')
    const recursive = input.recursive === true
    const stat = vmFs.stat(path)
    if (!stat) {
      return fail(
        `NanoVM 里没有路径「${path}」。可以先执行 nanovm_ls（不带 path）看 /home/user 下有什么。`
      )
    }
    if (stat.kind === 'file') {
      return ok(`文件：${stat.path}\n大小：${formatSize(stat.size)}\n更新：${stampOf(stat.mtime)}`)
    }
    const entries = recursive ? vmFs.walk(path) : vmFs.readdir(path, { all: true })
    const header = [
      `目录：${path}`,
      `条目：${entries.length} 个${recursive ? '（递归）' : ''}`,
      `用量：${formatSize(vmFs.usage().bytes)}`,
      '',
    ]
    if (entries.length === 0) {
      header.push('（空目录）')
      return ok(header.join('\n'))
    }
    const shown = entries.slice(0, MAX_ENTRIES)
    const lines = shown.map((entry) => describeEntry(entry, recursive))
    if (entries.length > shown.length) {
      lines.push(
        `…还有 ${entries.length - shown.length} 个条目未显示，可以缩小 path 范围或用 recursive=false。`
      )
    }
    return ok([...header, ...lines].join('\n'))
  },
}

/**
 * 可安装工具链的静态清单。
 *
 * 与 `src/services/nanovm/packages.ts` 的 TOOLCHAIN_IDS 保持一致：这里只是给模型
 * 看的 enum，工具真正执行时才动态 import 注册表（避免把 Pyodide / wasmoon 的加载器
 * 拖进首屏包）。新增工具链时两处都要改。
 */
const INSTALLABLE = [
  'python',
  'node',
  'lua',
  'sqlite',
  'esbuild',
  'typescript',
  'sass',
  'terser',
  'prettier',
  'make',
  'git',
] as const

const installTool: AgentTool = {
  id: 'nanovm_install',
  label: '安装 NanoVM 工具链',
  labelEn: 'Install NanoVM toolchain',
  summary: '在 NanoVM Slim 里按需安装运行时与构建器；需要确认。',
  summaryEn: 'Install runtimes and builders into NanoVM Slim on demand; asks for confirmation.',
  description:
    '在 NanoVM Slim 虚拟机里安装（启用）一个工具链：python（Pyodide 版 CPython，' +
    '约 12MB）、lua（wasmoon 版 Lua 5.4，约 0.4MB）、sqlite（sql.js 版 SQLite，约 1.3MB）、' +
    'esbuild（打包器，约 12MB）、typescript（官方 tsc，约 9MB）、sass（约 5.8MB）、' +
    'terser（约 1.1MB）、prettier（约 2MB）、node 与 git 与 make（浏览器内置，无需下载）。' +
    '安装完成后就能在 nanovm_shell 里直接使用对应命令。已安装时直接返回成功。',
  inputSchema: {
    type: 'object',
    properties: {
      tool: {
        type: 'string',
        description: '要安装的工具链',
        enum: [...INSTALLABLE],
      },
    },
    required: ['tool'],
    additionalProperties: false,
  },
  risk: 'network',
  requiresApproval: true,
  run: async (input, context) => {
    const tool = str(input, 'tool').trim()
    // 动态 import：工具链运行时（git / node / Pyodide）不进首屏包
    const packages = await import('../nanovm/packages.js')
    if (!packages.isToolchainId(tool)) {
      return fail(`tool 必须是 ${INSTALLABLE.join('、')} 之一`)
    }
    const usePackages = packages.usePackages
    const current = usePackages.getState().states[tool]
    if (current.installed) {
      return ok(
        `${current.label} 已经安装${current.version ? `（${current.version}）` : ''}，可以直接使用。`
      )
    }
    context.progress(`正在安装 ${current.label}…`)
    const result = await packages.installToolchain(tool, (progress) => {
      const percent = Math.round(Math.min(1, Math.max(0, progress)) * 100)
      context.progress(`正在安装 ${current.label}… ${percent}%`)
    })
    if (!result.ok) {
      return fail(`安装 ${current.label} 失败：${result.error ?? '未知错误'}`)
    }
    const installed = usePackages.getState().states[tool]
    const sizeMB = packages.toolchainSizeMB(tool)
    const size = sizeMB > 0 ? `约 ${sizeMB} MB` : '内置，无需下载'
    const example = packages.toolchainHint(tool as (typeof INSTALLABLE)[number])
    return ok(
      [
        `已安装 ${installed.label}${installed.version ? ` ${installed.version}` : ''}（${size}）。`,
        `现在可以在 nanovm_shell 里执行 ${example}。`,
      ].join('\n')
    )
  },
}

/** NanoVM 工具；顺序即设置页展示顺序 */
export const NANOVM_TOOLS: AgentTool[] = [shellTool, lsTool, installTool]

export const NANOVM_TOOL_IDS: string[] = NANOVM_TOOLS.map((tool) => tool.id)
