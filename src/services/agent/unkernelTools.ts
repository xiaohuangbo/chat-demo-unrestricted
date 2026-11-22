import { unkernelAgentAvailable, unkernelConfig } from '../unkernel/config.js'
import {
  execUnkernel,
  openUnkernel,
  restartUnkernel,
  useUnkernel,
  waitForUnkernelVm,
} from '../unkernel/session.js'
import {
  base64ToBytes,
  exportGuestPath,
  formatBytes,
  joinGuestPath,
  normalizeGuestPath,
  probeGuestPath,
  readGuestText,
  saveGuestExportToWorkspace,
  textBytes,
  writeGuestBytes,
} from '../unkernel/files.js'
import {
  isWorkspaceEnabled,
  readWorkspaceFile,
  saveWorkspaceFile,
  workspaceFileBytes,
} from '../workspace/store.js'
import type { AgentTool } from './tools.js'
import { clip, fail, num, ok, str } from './tools.js'

/**
 * Unkernel（Linux 7.x / WebAssembly）的 Agent 工具。
 *
 * 独立命名，和 nanovm_* / webvm_* 区分；命令走 vm.exec() 的独立 sh，
 * 不打断 iframe 里用户正在操作的终端。工作区已挂到 /mnt/workspace。
 */

const MAX_OUTPUT = 20_000
const MAX_WRITE_BYTES = 4 * 1024 * 1024

const unavailable = () => fail('Unkernel 未启用或未允许模型调用')

const formatExec = (result: {
  stdout: string
  stderr: string
  exitCode: number | null
}): string => {
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
  return lines.join('\n')
}

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
      return unavailable()
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
      return result.exitCode === 0 ? ok(formatExec(result)) : fail(formatExec(result))
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
      return unavailable()
    }
    const raw = str(input, 'path').trim()
    const path = raw.startsWith('/') ? raw : `/home/user/${raw || '.'}`
    const recursive = input.recursive === true
    const escaped = path.replace(/'/g, `'\\''`)
    const command = recursive
      ? `find '${escaped}' -maxdepth 4 -printf '%y %10s %p\\n' | head -n 500`
      : `ls -la --color=never '${escaped}'`
    context.progress('正在读取 Unkernel 文件列表…')
    try {
      const result = await execUnkernel(command, { timeoutMs: 30_000, signal: context.signal })
      if (result.exitCode !== 0) {
        return fail(
          `读取失败（退出码 ${result.exitCode}）：${clip(result.stderr || result.stdout, 4000)}`
        )
      }
      return ok(clip(result.stdout, MAX_OUTPUT) || '（空目录）')
    } catch (error) {
      return fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const readFileTool: AgentTool = {
  id: 'unkernel_read_file',
  label: 'Unkernel 读取文件',
  labelEn: 'Unkernel read file',
  summary: '按文本或 base64 读取 Unkernel 里的文件，只读，可分段。',
  summaryEn: 'Read a file inside Unkernel as text or base64, optionally in slices; read-only.',
  description:
    '读取 Unkernel 里的一个文件，默认按 UTF-8 文本返回（最多 64 KiB）。' +
    '大文件可以用 offset 和 max_bytes 分段读取；二进制文件把 encoding 设为 base64。' +
    '路径是 guest 内的绝对路径，工作区在 /mnt/workspace。只读操作。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'guest 内的绝对路径，例如 /mnt/workspace/README.md' },
      offset: { type: 'number', description: '从第几个字节开始，默认 0' },
      max_bytes: { type: 'number', description: '最多读取多少字节，默认 65536，最大 65536' },
      encoding: {
        type: 'string',
        enum: ['text', 'base64'],
        description: '返回文本还是 base64，默认 text',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
  risk: 'safe',
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    const path = str(input, 'path').trim()
    if (!path) {
      return fail('path 不能为空')
    }
    const base64 = str(input, 'encoding') === 'base64'
    context.progress('正在启动 Unkernel Linux…')
    try {
      const vm = await waitForUnkernelVm()
      const read = await readGuestText(vm, path, {
        offset: num(input, 'offset'),
        maxBytes: Math.min(
          64 * 1024,
          Math.max(1, Math.round(num(input, 'max_bytes') ?? 64 * 1024))
        ),
        base64,
        signal: context.signal,
      })
      const lines = [
        `路径：${path}`,
        `大小：${formatBytes(read.size)}；本次从 ${read.offset} 字节开始，读取 ${base64 ? (read.base64?.length ?? 0) : read.text.length} 个字符`,
        read.binary ? '类型：二进制' : '类型：文本',
      ]
      if (read.base64 !== undefined) {
        lines.push('', 'base64:', read.base64)
      } else if (read.binary) {
        lines.push('', '这个文件包含二进制内容；请把 encoding 设为 base64 再读取。')
      } else {
        lines.push('', '内容：', read.text || '（空文件）')
      }
      if (read.truncated) {
        lines.push('', `文件还有后续内容；下一次把 offset 设为 ${read.offset + read.bytesRead}。`)
      }
      return ok(lines.join('\n'))
    } catch (error) {
      return fail(`读取失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const writeFileTool: AgentTool = {
  id: 'unkernel_write_file',
  label: 'Unkernel 写入文件',
  labelEn: 'Unkernel write file',
  summary: '把文本或 base64 内容写入 Unkernel 文件；需要确认。',
  summaryEn: 'Write text or base64 content to a file inside Unkernel; asks for confirmation.',
  description:
    '把内容直接写入 Unkernel 的 guest 文件系统（不经过 shell 命令行），适合配置、脚本和二进制文件。' +
    '父目录会自动创建；默认不覆盖同名文件，overwrite=true 时覆盖。单次最多 4 MiB。' +
    '路径是 guest 内的绝对路径，工作区在 /mnt/workspace。',
  inputSchema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'guest 内的绝对路径，例如 /home/user/note.txt' },
      content: { type: 'string', description: '要写入的内容' },
      encoding: {
        type: 'string',
        enum: ['text', 'base64'],
        description: 'content 的编码，默认 text',
      },
      overwrite: { type: 'boolean', description: '覆盖同名文件，默认 false' },
    },
    required: ['path', 'content'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    const path = str(input, 'path').trim()
    if (!path) {
      return fail('path 不能为空')
    }
    const raw = str(input, 'content')
    const base64 = str(input, 'encoding') === 'base64'
    let bytes: Uint8Array
    try {
      bytes = base64 ? base64ToBytes(raw) : textBytes(raw)
    } catch {
      return fail('content 不是合法的 base64')
    }
    if (bytes.length > MAX_WRITE_BYTES) {
      return fail(
        `内容太大（${formatBytes(bytes.length)}），单次写入上限 ${formatBytes(MAX_WRITE_BYTES)}`
      )
    }
    context.progress('正在启动 Unkernel Linux…')
    try {
      const vm = await waitForUnkernelVm()
      await writeGuestBytes(vm, path, bytes, {
        overwrite: input.overwrite === true,
        signal: context.signal,
      })
      return ok(
        [
          `已写入：${path}`,
          `大小：${formatBytes(bytes.length)}`,
          `模式：${input.overwrite === true ? '覆盖同名文件' : '仅新建'}`,
        ].join('\n')
      )
    } catch (error) {
      return fail(`写入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const transferTool: AgentTool = {
  id: 'unkernel_transfer',
  label: 'Unkernel 工作区互传',
  labelEn: 'Unkernel workspace transfer',
  summary: '在聊天工作区与 Unkernel 之间复制文件（支持二进制）；需要确认。',
  summaryEn:
    'Copy files between the chat workspace and Unkernel (binary safe); asks for confirmation.',
  description:
    '在聊天工作区与 Unkernel guest 之间复制文件，二进制原样传输，不需要 base64 命令行。' +
    'direction=to_guest：把工作区文件写到 guest（source 是工作区路径，target 是 guest 目录或完整路径）；' +
    'direction=to_workspace：把 guest 文件或目录（打包为 .tar.gz）保存到工作区（source 是 guest 路径，target 可选）。' +
    '工作区与 /mnt/workspace 本来就连通；这个工具用于把文件放到 guest 的其他目录，或从那里取回。',
  inputSchema: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['to_guest', 'to_workspace'],
        description: '复制方向',
      },
      source: { type: 'string', description: '来源路径（工作区路径或 guest 绝对路径）' },
      target: {
        type: 'string',
        description:
          '目标：to_guest 时是 guest 目录或完整路径（默认 /home/user）；to_workspace 时是工作区路径（默认 unkernel/<文件名>）',
      },
      overwrite: { type: 'boolean', description: 'to_guest 时覆盖同名文件，默认 false' },
    },
    required: ['direction', 'source'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    const direction = str(input, 'direction')
    const source = str(input, 'source').trim()
    if (!source) {
      return fail('source 不能为空')
    }
    const target = str(input, 'target').trim()
    context.progress('正在启动 Unkernel Linux…')
    try {
      const vm = await waitForUnkernelVm()
      if (direction === 'to_guest') {
        const file = readWorkspaceFile(source)
        if (!file) {
          return fail(`工作区里没有这个文件：${source}`)
        }
        const bytes = workspaceFileBytes(file)
        const dest = target || '/home/user'
        const normalizedDir = normalizeGuestPath(dest)
        if (!normalizedDir) {
          return fail(`无效的 guest 目标路径：${dest}`)
        }
        const isDir = dest.endsWith('/') || (await probeGuestPath(vm, normalizedDir)) === 'dir'
        const fullPath = isDir ? joinGuestPath(normalizedDir, file.path) : normalizedDir
        if (!fullPath) {
          return fail(`无效的 guest 目标路径：${dest}`)
        }
        await writeGuestBytes(vm, fullPath, bytes, {
          overwrite: input.overwrite === true,
          signal: context.signal,
        })
        return ok(`已复制到 guest：${fullPath}\n大小：${formatBytes(bytes.length)}`)
      }
      if (direction === 'to_workspace') {
        if (!isWorkspaceEnabled()) {
          return fail('工作区未启用：请先在「Agent 工具」里打开工作区，再导出到工作区')
        }
        const result = await exportGuestPath(vm, source, { signal: context.signal })
        if (target) {
          const normalizedTarget = target.replace(/^\/+/, '')
          const saved = saveWorkspaceFile(normalizedTarget, {
            bytes: result.bytes,
            mime: result.mime,
          })
          if (!saved.ok) {
            return fail(`保存到工作区失败：${saved.reason}`)
          }
          return ok(
            `已保存到工作区：${saved.file.path}\n来源：${source}\n大小：${formatBytes(result.bytes.length)}${
              result.kind === 'dir' ? '\n目录已打包为 .tar.gz' : ''
            }`
          )
        }
        const savedPath = saveGuestExportToWorkspace(result)
        return ok(
          `已保存到工作区：${savedPath}\n来源：${source}\n大小：${formatBytes(result.bytes.length)}${
            result.kind === 'dir' ? '\n目录已打包为 .tar.gz' : ''
          }`
        )
      }
      return fail('direction 必须是 to_guest 或 to_workspace')
    } catch (error) {
      return fail(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const pythonTool: AgentTool = {
  id: 'unkernel_python',
  label: 'Unkernel Python',
  labelEn: 'Unkernel Python',
  summary: '把一段 Python 代码交给 Unkernel 里的 python3 执行；需要确认。',
  summaryEn: 'Run a Python snippet with python3 inside Unkernel; asks for confirmation.',
  description:
    '在 Unkernel Linux 里执行一段 Python 3 代码（stdin 传给 python3 -），返回 stdout / stderr。' +
    'Alpine 镜像默认可能没有 python3，先执行 apk add python3（或用 unkernel_shell）。' +
    '适合数据处理、生成文件、快速验证；工作区在 /mnt/workspace。',
  inputSchema: {
    type: 'object',
    properties: {
      code: { type: 'string', description: '要执行的 Python 3 代码' },
      timeout_ms: { type: 'number', description: '超时毫秒数，默认 30000，最大 120000' },
    },
    required: ['code'],
    additionalProperties: false,
  },
  risk: 'write',
  requiresApproval: true,
  timeoutMs: 300_000,
  run: async (input, context) => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    const code = str(input, 'code')
    if (!code.trim()) {
      return fail('code 不能为空')
    }
    const timeoutMs = Math.min(
      120_000,
      Math.max(1_000, Math.round(num(input, 'timeout_ms') ?? 30_000))
    )
    context.progress('正在启动 Unkernel Linux…')
    try {
      const vm = await waitForUnkernelVm()
      const result = await vm.exec(
        '/bin/sh',
        [
          '-c',
          'command -v python3 >/dev/null 2>&1 || { echo "python3 未安装：请先执行 apk add python3" >&2; exit 127; }; exec python3 -',
        ],
        {
          input: `${code}\n`,
          timeout: timeoutMs,
          signal: context.signal,
          maxBuffer: 4 * 1024 * 1024,
        }
      )
      return result.exitCode === 0 ? ok(formatExec(result)) : fail(formatExec(result))
    } catch (error) {
      return fail(`Python 执行失败：${error instanceof Error ? error.message : String(error)}`)
    }
  },
}

const infoTool: AgentTool = {
  id: 'unkernel_info',
  label: 'Unkernel 系统信息',
  labelEn: 'Unkernel system info',
  summary: '查看 Unkernel 的内核、发行版、内存、磁盘、CPU 和软件包，只读。',
  summaryEn: 'Inspect Unkernel kernel, distro, memory, disks, CPUs and packages; read-only.',
  description:
    '查看 Unkernel Linux 的系统信息：发行版、内核版本、运行时间、内存、根分区与工作区用量、CPU 数、软件包数量和网络接口。' +
    '虚拟机未启动时只返回配置和启动状态，不会启动它。只读操作。',
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
    const lines = [
      `状态：${statusText[state.status] ?? state.status}`,
      `内存：${config.memoryMiB} MiB`,
      `CPU：${config.cpus}`,
      `网络：${config.network ? '开' : '关'}`,
      `声音：${config.sound ? '开' : '关'}`,
      `显示：${config.display ? '开' : '关'}`,
      `持久磁盘：${config.persistentData ? '开' : '关'}`,
      `工作区：${state.workspaceMounted ? '已挂到 /mnt/workspace' : '未挂载'}`,
      `允许模型调用：${unkernelAgentAvailable() ? '是' : '否'}`,
    ]
    if (state.error) {
      lines.push(`错误：${state.error}`)
    }
    if (state.status !== 'ready') {
      return ok(lines.join('\n'))
    }
    try {
      const vm = await waitForUnkernelVm(10_000)
      const script = [
        'echo "发行版：$(cat /etc/alpine-release 2>/dev/null)"',
        'echo "内核：$(uname -srm)"',
        'echo "主机名：$(hostname)"',
        'echo "运行时间：$(uptime)"',
        'echo "CPU：$(nproc 2>/dev/null || echo unknown) 核"',
        'echo "软件包：$(apk info 2>/dev/null | wc -l) 个"',
        'echo ""; echo "== 内存 =="; free -m 2>/dev/null || echo unavailable',
        'echo ""; echo "== 磁盘 =="; df -h / 2>/dev/null; df -h /mnt/workspace 2>/dev/null || true',
        'echo ""; echo "== 网络 =="; cat /proc/net/dev 2>/dev/null || echo unavailable',
      ].join('\n')
      const result = await vm.exec('/bin/sh', ['-c', script], {
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      })
      if (result.stdout.trim()) {
        lines.push('', result.stdout.trim())
      }
      if (result.exitCode !== 0) {
        lines.push(
          '',
          `信息命令退出码：${result.exitCode}${result.stderr ? `：${clip(result.stderr, 2000)}` : ''}`
        )
      }
    } catch (error) {
      lines.push('', `读取系统信息失败：${error instanceof Error ? error.message : String(error)}`)
    }
    return ok(lines.join('\n'))
  },
}

const openTool: AgentTool = {
  id: 'unkernel_open',
  label: '打开 Unkernel',
  labelEn: 'Open Unkernel',
  summary: '在聊天里打开 Unkernel 页面；不会执行命令。',
  summaryEn: 'Open the Unkernel page in the chat; runs no command.',
  description:
    '打开 Unkernel 的全屏页面，让用户看到虚拟机界面。如果还没启动，会开始启动。' +
    '不会执行任何 guest 命令，也不会修改文件。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  risk: 'safe',
  run: async () => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    openUnkernel()
    return ok('已打开 Unkernel。首次启动需要加载内核和 Alpine 镜像，请稍等。')
  },
}

const restartTool: AgentTool = {
  id: 'unkernel_restart',
  label: '重启 Unkernel',
  labelEn: 'Restart Unkernel',
  summary: '重启 Unkernel Linux，未保存的内存状态会丢失；需要确认。',
  summaryEn: 'Restart Unkernel Linux, losing unsaved in-memory state; asks for confirmation.',
  description:
    '重启 Unkernel 虚拟机：页面重新加载并从头启动 Linux。/home/user 里的文件、/mnt/workspace 和持久磁盘上的内容会保留；' +
    '内存里的进程和未写入磁盘的临时文件会丢失。重启后会等待虚拟机就绪（最多 180 秒）。',
  inputSchema: { type: 'object', properties: {}, required: [], additionalProperties: false },
  risk: 'write',
  requiresApproval: true,
  timeoutMs: 300_000,
  run: async (_input, context) => {
    if (!unkernelAgentAvailable()) {
      return unavailable()
    }
    context.progress('正在重启 Unkernel Linux…')
    restartUnkernel()
    try {
      await waitForUnkernelVm(180_000)
      return ok('Unkernel 已重启并就绪。')
    } catch (error) {
      return fail(`重启失败：${error instanceof Error ? error.message : String(error)}`)
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
export const UNKERNEL_TOOLS: AgentTool[] = [
  shellTool,
  lsTool,
  readFileTool,
  writeFileTool,
  transferTool,
  pythonTool,
  infoTool,
  openTool,
  restartTool,
  statusTool,
]
export const UNKERNEL_TOOL_IDS: string[] = UNKERNEL_TOOLS.map((tool) => tool.id)
