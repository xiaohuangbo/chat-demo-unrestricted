import { webVMAgentAvailable, webVMConfig } from '../webvm/config.js'
import { readCoiState } from '../webvm/coi.js'
import { execWebVmCommand, useWebVM } from '../webvm/session.js'
import type { AgentTool } from './tools.js'
import { clip, fail, num, ok, str } from './tools.js'

/**
 * WebVM（CheerpX）的 Agent 工具：在浏览器里的 x86 Debian 上执行命令、看文件。
 *
 * 与 NanoVM 工具分开命名，模型能明确知道自己在操作哪一个虚拟机。WebVM 首次
 * 启动要拉 CheerpX 运行时和磁盘块，所以 webvm_shell 会先报告「正在启动」，
 * 再执行命令；所有命令都走独立的 bash 进程，不打断用户的交互式终端。
 */

const MAX_OUTPUT = 20_000

const quote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

const coiMessage = (): string => {
  const state = readCoiState()
  if (state.reason === 'webview') {
    return '当前是 Android WebView，跨源隔离不可用，WebVM 只能在浏览器（Chrome / 桌面浏览器）里运行。'
  }
  return 'WebVM 还没有启用跨源隔离。请先在终端里点「启用并重启 WebVM」，或在 设置 → 虚拟机 → WebVM 里启用运行环境。'
}

const shellTool: AgentTool = {
  id: 'webvm_shell',
  label: 'WebVM Shell',
  labelEn: 'WebVM shell',
  summary: '在浏览器内的 WebVM（CheerpX Debian）里执行命令；执行前需要确认。',
  summaryEn: 'Run a command in the in-browser WebVM (CheerpX Debian); asks for confirmation.',
  description:
    '在浏览器内的 WebVM（CheerpX 驱动的 x86 Debian）里执行一条 shell 命令。' +
    '它和 NanoVM 是两个独立的虚拟机：WebVM 有真正的 bash、coreutils、gcc/g++、Python 3、' +
    'Node.js、Ruby、Lua、make、git、vim 等工具；文件在 /home/user，不会碰本机磁盘。' +
    '首次调用会自动启动 WebVM（需要用户已启用跨源隔离），返回退出码与输出。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令行，例如 ls -l /home/user' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 30000，最大 120000' },
      cwd: { type: 'string', description: '工作目录，默认 /home/user' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  // 首次启动要等 CheerpX 拉完镜像块，给到 5 分钟；启动后的命令通常几秒
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!webVMAgentAvailable()) {
      return fail('WebVM 未启用或未允许模型调用')
    }
    if (readCoiState().state !== 'isolated') {
      return fail(coiMessage())
    }
    const command = str(input, 'command').trim()
    if (!command) {
      return fail('command 不能为空')
    }
    const requested = num(input, 'timeout_ms') ?? webVMConfig().timeoutMs
    const timeoutMs = Math.min(120_000, Math.max(1000, Math.round(requested)))
    const cwd = str(input, 'cwd').trim()
    const line = cwd ? `cd ${quote(cwd)} && ${command}` : command
    context.progress('正在启动 WebVM（首次启动需要下载镜像块）…')
    const result = await execWebVmCommand(line, { timeoutMs, signal: context.signal })
    const lines = [`退出码：${result.code}`]
    const output = clip(result.output, MAX_OUTPUT)
    if (output) {
      lines.push('', '输出:', output)
    } else {
      lines.push('', '（没有输出）')
    }
    return ok(lines.join('\n'))
  },
}

const lsTool: AgentTool = {
  id: 'webvm_ls',
  label: 'WebVM 文件列表',
  labelEn: 'WebVM list files',
  summary: '列出 WebVM 里的文件（路径、大小、类型），只读。',
  summaryEn: 'List files inside WebVM (path, size, type); read-only.',
  description:
    '列出 WebVM（CheerpX Debian）里的文件，返回 ls -la 的结果。' +
    '路径默认 /home/user，相对路径也以 /home/user 为基准。只读操作，不修改任何文件。',
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
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!webVMAgentAvailable()) {
      return fail('WebVM 未启用或未允许模型调用')
    }
    if (readCoiState().state !== 'isolated') {
      return fail(coiMessage())
    }
    const raw = str(input, 'path').trim()
    const path = raw.startsWith('/') ? raw : `/home/user/${raw || '.'}`
    const recursive = input.recursive === true
    const command = recursive
      ? `find ${quote(path)} -maxdepth 4 -printf '%y %10s %p\\n' | head -n 500`
      : `ls -la --color=never ${quote(path)}`
    context.progress('正在读取 WebVM 文件列表…')
    const result = await execWebVmCommand(command, { timeoutMs: 30_000, signal: context.signal })
    if (result.code !== 0) {
      return fail(`读取失败（退出码 ${result.code}）：${clip(result.output, 4000) || '没有输出'}`)
    }
    return ok(clip(result.output, MAX_OUTPUT) || '（空目录）')
  },
}

const statusTool: AgentTool = {
  id: 'webvm_status',
  label: 'WebVM 状态',
  labelEn: 'WebVM status',
  summary: '查看 WebVM 是否已启动、镜像与跨源隔离开关，只读且不会启动虚拟机。',
  summaryEn: 'Check whether WebVM is running, its image and cross-origin isolation; read-only.',
  description:
    '查看 WebVM（CheerpX）的运行状态：是否就绪、启动耗时、系统镜像，以及跨源隔离是否已启用。' +
    '这个工具不会启动虚拟机，适合在调用 webvm_shell 之前确认环境。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  risk: 'safe',
  run: async () => {
    const state = useWebVM.getState()
    const config = webVMConfig()
    const coi = readCoiState()
    const image =
      config.imageId === 'custom'
        ? config.customImageUrl || '（未填写自定义地址）'
        : config.imageId === 'debian-2023'
          ? 'Debian 10 · 2023 镜像'
          : 'Debian 10 · 完整镜像'
    const statusText: Record<typeof state.status, string> = {
      idle: '未启动',
      coi: '等待启用跨源隔离',
      loading: '正在加载 CheerpX 运行时',
      connecting: '正在连接磁盘',
      booting: '正在启动 Debian',
      ready: '已就绪',
      error: '启动失败',
    }
    return ok(
      [
        `状态：${statusText[state.status]}`,
        `跨源隔离：${coi.state === 'isolated' ? '已启用' : coi.state === 'registerable' ? '未启用（可启用）' : '当前环境不支持'}`,
        `镜像：${image}`,
        `启动耗时：${state.bootMs ? `${state.bootMs} ms` : '—'}`,
        `允许模型调用：${webVMAgentAvailable() ? '是' : '否'}`,
        state.error ? `错误：${state.error}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  },
}

/** WebVM 工具；顺序即设置页展示顺序 */
export const WEBVM_TOOLS: AgentTool[] = [shellTool, lsTool, statusTool]

export const WEBVM_TOOL_IDS: string[] = WEBVM_TOOLS.map((tool) => tool.id)
