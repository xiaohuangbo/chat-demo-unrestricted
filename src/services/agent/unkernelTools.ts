import { unkernelAgentAvailable, unkernelConfig } from '../unkernel/config.js'
import { execUnkernel, useUnkernel } from '../unkernel/session.js'
import type { AgentTool } from './tools.js'
import { clip, fail, num, ok, str } from './tools.js'

/**
 * Unkernel（Linux 7.x / WebAssembly）的 Agent 工具。
 *
 * 独立命名，和 nanovm_* / webvm_* 区分；命令走 vm.exec() 的独立 sh，
 * 不打断 iframe 里用户正在操作的终端。工作区已挂到 /mnt/workspace。
 */

const MAX_OUTPUT = 20_000

const shellTool: AgentTool = {
  id: 'unkernel_shell',
  label: 'Unkernel Shell',
  labelEn: 'Unkernel shell',
  summary: '在浏览器内的 Unkernel Linux（Alpine）里执行命令；执行前需要确认。',
  summaryEn: 'Run a command in the in-browser Unkernel Linux (Alpine); asks for confirmation.',
  description:
    '在浏览器内的 Unkernel（Linux 7.x 编译成 WebAssembly，Alpine aarch64 用户空间）里执行一条 shell 命令。' +
    '它和 NanoVM、WebVM 是三个独立的虚拟机：Unkernel 有真实的 Linux 内核、bash、apk、coreutils、Python 等，' +
    '工作区挂在 /mnt/workspace，用户文件与聊天工作区共享。首次调用会自动打开并启动 Unkernel。',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的完整命令，例如 ls -l /mnt/workspace' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认使用设置值，最大 120000' },
      cwd: { type: 'string', description: '工作目录，默认 /home/user' },
    },
    required: ['command'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return fail('Unkernel 未启用或未允许模型调用')
    }
    const command = str(input, 'command').trim()
    if (!command) {
      return fail('command 不能为空')
    }
    const requested = num(input, 'timeout_ms') ?? unkernelConfig().timeoutMs
    const timeoutMs = Math.min(120_000, Math.max(1_000, Math.round(requested)))
    context.progress('正在启动 Unkernel Linux…')
    try {
      const result = await execUnkernel(command, {
        cwd: str(input, 'cwd').trim() || '/home/user',
        timeoutMs,
        signal: context.signal,
      })
      const lines = [`退出码：${result.exitCode ?? '—'}`]
      if (result.stdout) {
        lines.push('', 'stdout:', clip(result.stdout, MAX_OUTPUT))
      }
      if (result.stderr) {
        lines.push('', 'stderr:', clip(result.stderr, MAX_OUTPUT))
      }
      if (!result.stdout && !result.stderr) {
        lines.push('', '（没有输出）')
      }
      return result.exitCode === 0 ? ok(lines.join('\n')) : fail(lines.join('\n'))
    } catch (error) {
      return fail(`执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const lsTool: AgentTool = {
  id: 'unkernel_ls',
  label: 'Unkernel 文件列表',
  labelEn: 'Unkernel list files',
  summary: '列出 Unkernel 里的文件，只读。',
  summaryEn: 'List files inside Unkernel; read-only.',
  description:
    '列出 Unkernel Linux 里的文件（ls -la）。路径默认 /home/user；工作区在 /mnt/workspace。只读操作，不会修改文件。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '要列的目录或文件，默认 /home/user' },
      recursive: { type: 'boolean', description: '是否递归列出，默认 false' },
    },
    required: [],
    additionalProperties: false,
  },
  risk: 'safe',
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return fail('Unkernel 未启用或未允许模型调用')
    }
    const raw = str(input, 'path').trim()
    const path = raw.startsWith('/') ? raw : `/home/user/${raw || '.'}`
    const recursive = input.recursive === true
    const command = recursive
      ? `find '${path.replace(/'/g, `'\\''`)}' -maxdepth 4 -printf '%y %10s %p\\n' | head -n 500`
      : `ls -la --color=never '${path.replace(/'/g, `'\\''`)}'`
    context.progress('正在读取 Unkernel 文件列表…')
    try {
      const result = await execUnkernel(command, { timeoutMs: 30_000, signal: context.signal })
      if (result.exitCode !== 0) {
        return fail(`读取失败（退出码 ${result.exitCode}）：${clip(result.stderr || result.stdout, 4000)}`)
      }
      return ok(clip(result.stdout, MAX_OUTPUT) || '（空目录）')
    } catch (error) {
      return fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const statusTool: AgentTool = {
  id: 'unkernel_status',
  label: 'Unkernel 状态',
  labelEn: 'Unkernel status',
  summary: '查看 Unkernel 是否已启动、设备与工作区挂载状态，只读且不会启动。',
  summaryEn: 'Check whether Unkernel is running, its devices and workspace mount; read-only.',
  description:
    '查看 Unkernel 的状态：是否已启动、内存、网络/声音/显示、持久磁盘、工作区是否挂到 /mnt/workspace，以及是否允许模型调用。不会启动虚拟机。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  risk: 'safe',
  run: async () => {
    const state = useUnkernel.getState()
    const config = unkernelConfig()
    const statusText: Record<string, string> = {
      idle: '未启动',
      loading: '正在启动',
      ready: '已就绪',
      error: '启动失败',
    }
    return ok(
      [
        `状态：${statusText[state.status] ?? state.status}`,
        `内存：${config.memoryMiB} MiB`,
        `网络：${config.network ? '开' : '关'}`,
        `声音：${config.sound ? '开' : '关'}`,
        `显示：${config.display ? '开' : '关'}`,
        `持久磁盘：${config.persistentData ? '开' : '关'}`,
        `工作区：${state.workspaceMounted ? '已挂到 /mnt/workspace' : '未挂载'}`,
        `允许模型调用：${unkernelAgentAvailable() ? '是' : '否'}`,
        state.error ? `错误：${state.error}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    )
  },
}

/** Unkernel 工具；顺序即设置页展示顺序 */
export const UNKERNEL_TOOLS: AgentTool[] = [shellTool, lsTool, statusTool]
export const UNKERNEL_TOOL_IDS: string[] = UNKERNEL_TOOLS.map((tool) => tool.id)
