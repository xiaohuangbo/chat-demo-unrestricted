import type { NanovmFS, FsEntry } from '../fs.js'
import { baseName, dirName, normalizePath, resolvePath } from '../fs.js'
import { SHELL_PID } from '../shell/expand.js'
import { ERRNO_TEXT } from '../types.js'
import type { Applet, AppletContext, AppletResult } from '../types.js'
import type { FlagValue } from './helpers.js'
import {
  humanSize,
  interrupted,
  modeText,
  ok,
  parseArgs,
  parseMode,
  stamp,
  vmErrorMessage,
} from './helpers.js'

/**
 * 文件与系统类命令（busybox 风格）。
 *
 * 这些命令全部跑在虚拟文件系统上：没有真实 inode、没有进程调度、没有用户权限，
 * 但输出格式、退出码与报错措辞尽量贴近 GNU / busybox，脚本照着写也能跑。
 * stderr 统一 `<cmd>: ...` 前缀；用法错误返回 2，命令找不到由执行器返回 127。
 */

const decoder = new TextDecoder()

/** NanoVM 是单用户环境，uid / gid 固定 */
const USER = 'user'
const GROUP = 'user'
const UID = 1000
const GID = 1000

/** 与 engine.ts 的 VERSION 保持一致（uname -r 展示） */
const APP_VERSION = '2.7.7'

/** 模块加载时刻，uptime 从这里算起 */
const loadedAt = Date.now()

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

// ---------- 共用小工具 ----------

const hasFlag = (flags: Record<string, FlagValue>, name: string): boolean => flags[name] === true

const stringFlag = (flags: Record<string, FlagValue>, name: string): string | undefined => {
  const value = flags[name]
  return typeof value === 'string' ? value : undefined
}

const usageError = (name: string, message: string, code = 2): AppletResult => ({
  code,
  stderr: `${name}: ${message}\n`,
})

const missingError = (name: string, operand: string): string =>
  `${name}: ${operand}: ${ERRNO_TEXT.ENOENT}`

const pad2 = (value: number): string => String(value).padStart(2, '0')

const indent = (value: string, width: number): string => value.padStart(width)

/** 一次命令最多能产生的输出：受 WASM 线性内存配额约束 */
const outputBudget = (context: AppletContext): number => {
  const memory = context.memory()
  const free = Math.max(0, memory.totalMB * 1024 * 1024 - memory.usedBytes)
  return Math.max(64 * 1024, Math.min(32 * 1024 * 1024, Math.floor(free * 0.6)))
}

const shellQuote = (text: string): string => `'${text.replace(/'/g, "'\\''")}'`

const errorText = (command: string, error: unknown, operand: string): string =>
  vmErrorMessage(command, error, operand).stderr ?? `${command}: ${operand}: 未知错误`

/** 读文本文件（`-` = stdin）；失败时把错误写进 errors 并返回 null */
const readTextFile = (
  context: AppletContext,
  command: string,
  operand: string,
  errors: string[]
): string | null => {
  if (operand === '-') {
    return context.stdin
  }
  try {
    const bytes = context.fs.read(resolvePath(context.cwd, operand))
    if (!bytes) {
      errors.push(missingError(command, operand))
      return null
    }
    return decoder.decode(bytes)
  } catch (error) {
    errors.push(errorText(command, error, operand))
    return null
  }
}

const resultFrom = (stdout: string, errors: string[], code = 0): AppletResult => {
  const output = stdout.length > 0 ? `${stdout.replace(/\n$/, '')}\n` : ''
  return {
    code: errors.length > 0 ? 1 : code,
    stdout: output,
    stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
  }
}

/** 目录项是否可执行（ls -F 用） */
const isExecutable = (entry: FsEntry): boolean =>
  entry.kind === 'file' && (entry.mode & 0o111) !== 0

const fileKind = (entry: FsEntry): string => (entry.kind === 'dir' ? 'directory' : 'regular file')

// ---------- pwd / cd ----------

const pwdApplet: Applet = {
  name: 'pwd',
  summary: '打印当前工作目录',
  summaryEn: 'Print the current working directory',
  usage: 'pwd [-LP]',
  run: (context) => {
    const parsed = parseArgs(context.argv, { L: 'boolean', P: 'boolean' })
    if (parsed.error) {
      return usageError('pwd', parsed.error)
    }
    return ok(`${context.cwd}\n`)
  },
}

const cdApplet: Applet = {
  name: 'cd',
  summary: '切换目录（cd - 回到上一个目录）',
  summaryEn: 'Change the working directory',
  usage: 'cd [-LP] [DIR]',
  run: (context) => {
    const parsed = parseArgs(context.argv, { L: 'boolean', P: 'boolean' })
    if (parsed.error) {
      return usageError('cd', parsed.error)
    }
    if (parsed.operands.length > 1) {
      return usageError('cd', 'too many arguments', 1)
    }
    const target = parsed.operands[0]
    let next = target ?? context.env.HOME ?? '/home/user'
    if (target === '-') {
      next = context.env.OLDPWD ?? context.cwd
    }
    const absolute = normalizePath(resolvePath(context.cwd, next))
    const entry = context.fs.stat(absolute)
    if (!entry) {
      return {
        code: 1,
        stderr: `cd: can't cd to ${next}: ${ERRNO_TEXT.ENOENT}\n`,
      }
    }
    if (entry.kind !== 'dir') {
      return {
        code: 1,
        stderr: `cd: can't cd to ${next}: ${ERRNO_TEXT.ENOTDIR}\n`,
      }
    }
    context.setenv('OLDPWD', context.cwd)
    context.chdir(absolute)
    context.setenv('PWD', absolute)
    // `cd -` 会打印新目录，方便确认
    return target === '-' ? ok(`${absolute}\n`) : ok()
  },
}

// ---------- ls ----------

type LsOptions = {
  /** 包含点文件 */
  all: boolean
  /** -a：额外列出 . 与 .. */
  dots: boolean
  long: boolean
  human: boolean
  recursive: boolean
  byTime: boolean
  reverse: boolean
  classify: boolean
}

const classifyName = (entry: FsEntry, options: LsOptions, displayName: string): string => {
  if (!options.classify) {
    return displayName
  }
  if (entry.kind === 'dir') {
    return `${displayName}/`
  }
  return isExecutable(entry) ? `${displayName}*` : displayName
}

/** `.` 与 `..` 固定排在最前（-t 也不动它们），其余按目录在前、名字升序 */
const sortEntries = (entries: FsEntry[], options: LsOptions): FsEntry[] => {
  const sorted = [...entries]
  sorted.sort((left, right) => {
    const leftDot = left.name === '.' || left.name === '..'
    const rightDot = right.name === '.' || right.name === '..'
    if (leftDot || rightDot) {
      if (leftDot && rightDot) {
        return left.name === '.' ? -1 : 1
      }
      return leftDot ? -1 : 1
    }
    if (options.byTime) {
      return right.mtime - left.mtime || left.name.localeCompare(right.name)
    }
    if (left.kind !== right.kind) {
      return left.kind === 'dir' ? -1 : 1
    }
    return left.name.localeCompare(right.name)
  })
  return options.reverse ? sorted.reverse() : sorted
}

/** ls -a 要列出的 . 与 ..：直接借 stat 造出目录项，du / find 不受影响 */
const dotEntries = (context: AppletContext, path: string): FsEntry[] => {
  const entries: FsEntry[] = []
  const current = context.fs.stat(path)
  if (current) {
    entries.push({ ...current, name: '.', path })
  }
  const parentPath = dirName(path)
  const parent = context.fs.stat(parentPath)
  if (parent) {
    entries.push({ ...parent, name: '..', path: parentPath })
  }
  return entries
}

const formatEntry = (
  entry: FsEntry,
  options: LsOptions,
  sizeWidth: number,
  displayName = entry.name
): string => {
  const name = classifyName(entry, options, displayName)
  if (!options.long) {
    return name
  }
  const links = entry.kind === 'dir' ? 2 : 1
  const size = options.human ? humanSize(entry.size) : String(entry.size)
  return [
    modeText(entry.mode, entry.kind),
    indent(String(links), 2),
    USER.padEnd(5),
    GROUP.padEnd(5),
    indent(size, sizeWidth),
    stamp(entry.mtime),
    name,
  ].join(' ')
}

const listDirectory = (
  context: AppletContext,
  operand: string,
  options: LsOptions,
  errors: string[]
): string[] => {
  const path = resolvePath(context.cwd, operand)
  let entries: FsEntry[]
  try {
    entries = context.fs.readdir(path, { all: options.all })
  } catch (error) {
    errors.push(errorText('ls', error, operand))
    return []
  }
  if (options.dots) {
    entries = [...dotEntries(context, path), ...entries]
  }
  const sorted = sortEntries(entries, options)
  const sizeWidth = sorted.reduce((width, entry) => Math.max(width, String(entry.size).length), 1)
  const lines: string[] = []
  if (options.long) {
    const blocks = sorted.reduce((sum, entry) => sum + Math.ceil(entry.size / 1024), 0)
    lines.push(`total ${blocks}`)
  }
  for (const entry of sorted) {
    lines.push(formatEntry(entry, options, sizeWidth))
  }
  if (!options.recursive) {
    return lines
  }
  for (const entry of sorted) {
    if (entry.kind !== 'dir' || entry.name === '.' || entry.name === '..') {
      continue
    }
    const child = operand === '/' ? `/${entry.name}` : `${operand.replace(/\/$/, '')}/${entry.name}`
    lines.push('')
    lines.push(`${child}:`)
    lines.push(...listDirectory(context, child, options, errors))
  }
  return lines
}

const lsApplet: Applet = {
  name: 'ls',
  summary: '列出目录内容（-l 长格式、-a 全部、-R 递归）',
  summaryEn: 'List directory contents',
  usage: 'ls [-alhRtr1F] [FILE]...',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      l: 'boolean',
      a: 'boolean',
      A: 'boolean',
      h: 'boolean',
      R: 'boolean',
      t: 'boolean',
      r: 'boolean',
      '1': 'boolean',
      F: 'boolean',
      d: 'boolean',
    })
    if (parsed.error) {
      return usageError('ls', parsed.error)
    }
    const options: LsOptions = {
      all: hasFlag(parsed.flags, 'a') || hasFlag(parsed.flags, 'A'),
      dots: hasFlag(parsed.flags, 'a'),
      long: hasFlag(parsed.flags, 'l'),
      human: hasFlag(parsed.flags, 'h'),
      recursive: hasFlag(parsed.flags, 'R'),
      byTime: hasFlag(parsed.flags, 't'),
      reverse: hasFlag(parsed.flags, 'r'),
      classify: hasFlag(parsed.flags, 'F'),
    }
    const operands = parsed.operands.length > 0 ? parsed.operands : ['.']
    const errors: string[] = []
    const files: { operand: string; entry: FsEntry }[] = []
    const dirs: string[] = []
    for (const operand of operands) {
      const entry = context.fs.stat(resolvePath(context.cwd, operand))
      if (!entry) {
        errors.push(`ls: cannot access '${operand}': ${ERRNO_TEXT.ENOENT}`)
        continue
      }
      if (entry.kind === 'dir' && !hasFlag(parsed.flags, 'd')) {
        dirs.push(operand)
      } else {
        files.push({ operand, entry })
      }
    }
    const blocks: string[] = []
    if (files.length > 0) {
      const sizeWidth = files.reduce(
        (width, file) => Math.max(width, String(file.entry.size).length),
        1
      )
      blocks.push(
        files.map((file) => formatEntry(file.entry, options, sizeWidth, file.operand)).join('\n')
      )
    }
    const showHeader = operands.length > 1 || options.recursive
    for (const dir of dirs) {
      const lines = listDirectory(context, dir, options, errors)
      blocks.push(showHeader ? [`${dir}:`, ...lines].join('\n') : lines.join('\n'))
    }
    const body = blocks.filter((block) => block.trim().length > 0).join('\n\n')
    return {
      code: errors.length > 0 ? 1 : 0,
      stdout: body.length > 0 ? `${body}\n` : '',
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    }
  },
}

// ---------- cat ----------

const numberLines = (
  text: string,
  start: number,
  everyLine: boolean
): { text: string; next: number } => {
  let counter = start
  let output = ''
  let index = 0
  while (index < text.length) {
    const end = text.indexOf('\n', index)
    const line = end === -1 ? text.slice(index) : text.slice(index, end)
    const terminator = end === -1 ? '' : '\n'
    index = end === -1 ? text.length : end + 1
    if (everyLine || line.length > 0) {
      counter += 1
      output += `${indent(String(counter), 6)}\t${line}${terminator}`
    } else {
      output += `${line}${terminator}`
    }
  }
  return { text: output, next: counter }
}

const escapeControl = (text: string, showEnds: boolean, showTabs: boolean): string => {
  if (!showEnds && !showTabs) {
    return text
  }
  let output = ''
  for (const char of text) {
    if (char === '\n') {
      output += showEnds ? '$\n' : '\n'
      continue
    }
    if (char === '\t') {
      output += showTabs ? '^I' : '\t'
      continue
    }
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20) {
      output += `^${String.fromCharCode(code + 64)}`
      continue
    }
    if (code === 0x7f) {
      output += '^?'
      continue
    }
    output += char
  }
  return output
}

const catApplet: Applet = {
  name: 'cat',
  summary: '拼接文件并输出（-n 编号、-A 显示不可见字符）',
  summaryEn: 'Concatenate files and print them',
  usage: 'cat [-nbAeEtTsu] [FILE]...',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      n: 'boolean',
      b: 'boolean',
      A: 'boolean',
      e: 'boolean',
      t: 'boolean',
      T: 'boolean',
      E: 'boolean',
      s: 'boolean',
      u: 'boolean',
      v: 'boolean',
    })
    if (parsed.error) {
      return usageError('cat', parsed.error)
    }
    const flags = parsed.flags
    const numberAll = hasFlag(flags, 'n')
    const numberNonBlank = hasFlag(flags, 'b')
    const showEnds = hasFlag(flags, 'A') || hasFlag(flags, 'e') || hasFlag(flags, 'E')
    const showTabs = hasFlag(flags, 'A') || hasFlag(flags, 't') || hasFlag(flags, 'T')
    const squeeze = hasFlag(flags, 's')
    const operands = parsed.operands.length > 0 ? parsed.operands : ['-']
    const errors: string[] = []
    const chunks: string[] = []
    let counter = 0
    for (const operand of operands) {
      const text = readTextFile(context, 'cat', operand, errors)
      if (text === null) {
        continue
      }
      let body = escapeControl(text, showEnds, showTabs)
      if (squeeze) {
        body = body.replace(/\n{3,}/g, '\n\n')
      }
      if (numberAll || numberNonBlank) {
        const numbered = numberLines(body, counter, numberAll)
        body = numbered.text
        counter = numbered.next
      }
      chunks.push(body)
    }
    return {
      code: errors.length > 0 ? 1 : 0,
      stdout: chunks.join(''),
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    }
  },
}

// ---------- echo / printf ----------

const readEscape = (
  source: string,
  index: number
): { text: string; end: number; stop: boolean } => {
  const next = source[index + 1]
  if (next === undefined) {
    return { text: '\\', end: index + 1, stop: false }
  }
  if (next === 'c') {
    return { text: '', end: index + 2, stop: true }
  }
  if (next === '0') {
    const match = /^[0-7]{0,3}/.exec(source.slice(index + 2))
    const digits = match ? match[0] : ''
    return {
      text: String.fromCharCode(Number.parseInt(digits.length > 0 ? digits : '0', 8)),
      end: index + 2 + digits.length,
      stop: false,
    }
  }
  if (next === 'x') {
    const match = /^[0-9a-fA-F]{1,2}/.exec(source.slice(index + 2))
    if (match) {
      return {
        text: String.fromCharCode(Number.parseInt(match[0], 16)),
        end: index + 2 + match[0].length,
        stop: false,
      }
    }
    return { text: 'x', end: index + 2, stop: false }
  }
  const table: Record<string, string> = {
    a: '\u0007',
    b: '\b',
    e: '\u001b',
    f: '\f',
    n: '\n',
    r: '\r',
    t: '\t',
    v: '\v',
    '\\': '\\',
  }
  const mapped = table[next]
  if (mapped !== undefined) {
    return { text: mapped, end: index + 2, stop: false }
  }
  return { text: `\\${next}`, end: index + 2, stop: false }
}

const expandEscapes = (text: string): { text: string; stop: boolean } => {
  let output = ''
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '\\') {
      output += char
      index += 1
      continue
    }
    const escaped = readEscape(text, index)
    output += escaped.text
    index = escaped.end
    if (escaped.stop) {
      return { text: output, stop: true }
    }
  }
  return { text: output, stop: false }
}

const echoApplet: Applet = {
  name: 'echo',
  summary: '输出一行文本（-n 不换行、-e 解释转义）',
  summaryEn: 'Print a line of text',
  usage: 'echo [-neE] [STRING]...',
  run: (context) => {
    let index = 1
    let newline = true
    let escapes = false
    while (index < context.argv.length) {
      const arg = context.argv[index]
      if (arg === '--') {
        index += 1
        break
      }
      if (!/^-[neE]+$/.test(arg)) {
        break
      }
      for (const char of arg.slice(1)) {
        if (char === 'n') {
          newline = false
        } else if (char === 'e') {
          escapes = true
        } else {
          escapes = false
        }
      }
      index += 1
    }
    const raw = context.argv.slice(index).join(' ')
    const expanded = escapes ? expandEscapes(raw) : { text: raw, stop: false }
    return ok(expanded.stop || !newline ? expanded.text : `${expanded.text}\n`)
  },
}

const formatValue = (
  flags: string,
  conversion: string,
  argument: string,
  widthText: string,
  precisionText: string | undefined
): { text: string; error?: string } => {
  const width = widthText.length > 0 ? Number(widthText) : 0
  const precision =
    precisionText === undefined || precisionText.length === 0 ? null : Number(precisionText)
  const left = flags.includes('-')
  const zero = !left && flags.includes('0')
  let body: string
  if (conversion === 's') {
    body = argument
  } else if (conversion === 'b') {
    body = expandEscapes(argument).text
  } else if (conversion === 'c') {
    body = argument.slice(0, 1)
  } else if (conversion === 'd' || conversion === 'i' || conversion === 'u') {
    const value = Number.parseInt(argument, 10)
    body = String(Number.isNaN(value) ? 0 : value)
  } else if (conversion === 'o') {
    body = (Number.parseInt(argument, 10) || 0).toString(8)
  } else if (conversion === 'x') {
    body = (Number.parseInt(argument, 10) || 0).toString(16)
  } else if (conversion === 'X') {
    body = (Number.parseInt(argument, 10) || 0).toString(16).toUpperCase()
  } else if (conversion === 'f' || conversion === 'F') {
    body = (Number(argument) || 0).toFixed(precision ?? 6)
  } else if (conversion === 'e' || conversion === 'E') {
    body = (Number(argument) || 0).toExponential(precision ?? 6)
    if (conversion === 'E') {
      body = body.toUpperCase()
    }
  } else if (conversion === 'g' || conversion === 'G') {
    body = String(Number(argument) || 0)
  } else {
    return { text: '', error: `invalid conversion '%${conversion}'` }
  }
  if (precision !== null && (conversion === 's' || conversion === 'b')) {
    body = body.slice(0, precision)
  }
  if (body.length >= width) {
    return { text: body }
  }
  if (zero && body.startsWith('-')) {
    return { text: `-${body.slice(1).padStart(width - 1, '0')}` }
  }
  const filler = zero ? '0' : ' '
  return { text: left ? body.padEnd(width, ' ') : body.padStart(width, filler) }
}

const renderPrintf = (
  format: string,
  args: string[]
): { text: string; consumed: number; error?: string } => {
  let text = ''
  let consumed = 0
  let index = 0
  while (index < format.length) {
    const char = format[index]
    if (char === '\\') {
      const escaped = readEscape(format, index)
      text += escaped.text
      index = escaped.end
      continue
    }
    if (char !== '%') {
      text += char
      index += 1
      continue
    }
    const parsed = /^%([-+ 0#]*)(\d*)(?:\.(\d*))?([diouxXfFeEgGcsb%])/.exec(format.slice(index))
    if (!parsed) {
      text += char
      index += 1
      continue
    }
    index += parsed[0].length
    const conversion = parsed[4]
    if (conversion === '%') {
      text += '%'
      continue
    }
    const argument = args[consumed] ?? ''
    consumed += 1
    const formatted = formatValue(parsed[1], conversion, argument, parsed[2], parsed[3])
    if (formatted.error) {
      return { text, consumed, error: formatted.error }
    }
    text += formatted.text
  }
  return { text, consumed }
}

const printfApplet: Applet = {
  name: 'printf',
  summary: '按格式串输出（%s %d %f %x %b 等）',
  summaryEn: 'Format and print data',
  usage: 'printf FORMAT [ARGUMENT]...',
  run: (context) => {
    const format = context.argv[1]
    if (format === undefined) {
      return usageError('printf', 'missing format string', 2)
    }
    const args = context.argv.slice(2)
    let output = ''
    let cursor = 0
    for (let round = 0; round < 10_000; round += 1) {
      const rendered = renderPrintf(format, args.slice(cursor))
      output += rendered.text
      if (rendered.error) {
        return { code: 1, stdout: output, stderr: `printf: ${rendered.error}\n` }
      }
      cursor += rendered.consumed
      if (rendered.consumed === 0 || cursor >= args.length) {
        break
      }
    }
    return ok(output)
  },
}

// ---------- mkdir / rmdir / rm ----------

const mkdirApplet: Applet = {
  name: 'mkdir',
  summary: '创建目录（-p 递归、-m 指定权限）',
  summaryEn: 'Make directories',
  usage: 'mkdir [-p] [-m MODE] DIRECTORY...',
  run: (context) => {
    const parsed = parseArgs(context.argv, { p: 'boolean', m: 'value', v: 'boolean' })
    if (parsed.error) {
      return usageError('mkdir', parsed.error)
    }
    if (parsed.operands.length === 0) {
      return usageError('mkdir', 'missing operand')
    }
    const parents = hasFlag(parsed.flags, 'p')
    const modeText = stringFlag(parsed.flags, 'm')
    const mode = modeText === undefined ? null : parseMode(modeText)
    if (modeText !== undefined && mode === null) {
      return usageError('mkdir', `invalid mode '${modeText}'`)
    }
    const errors: string[] = []
    const created: string[] = []
    for (const operand of parsed.operands) {
      const path = resolvePath(context.cwd, operand)
      try {
        context.fs.mkdir(path, parents)
        if (mode !== null) {
          context.fs.chmod(path, mode)
        }
        if (hasFlag(parsed.flags, 'v')) {
          created.push(`mkdir: created directory '${operand}'`)
        }
      } catch (error) {
        if (parents && context.fs.isDirectory(path)) {
          continue
        }
        errors.push(errorText('mkdir', error, operand))
      }
    }
    return resultFrom(created.join('\n'), errors)
  },
}

const rmdirApplet: Applet = {
  name: 'rmdir',
  summary: '删除空目录（-p 连同空父目录一起删）',
  summaryEn: 'Remove empty directories',
  usage: 'rmdir [-p] DIRECTORY...',
  run: (context) => {
    const parsed = parseArgs(context.argv, { p: 'boolean', v: 'boolean' })
    if (parsed.error) {
      return usageError('rmdir', parsed.error)
    }
    if (parsed.operands.length === 0) {
      return usageError('rmdir', 'missing operand')
    }
    const errors: string[] = []
    const removed: string[] = []
    for (const operand of parsed.operands) {
      const path = resolvePath(context.cwd, operand)
      const entry = context.fs.stat(path)
      if (!entry) {
        errors.push(`rmdir: failed to remove '${operand}': ${ERRNO_TEXT.ENOENT}`)
        continue
      }
      if (entry.kind !== 'dir') {
        errors.push(`rmdir: failed to remove '${operand}': ${ERRNO_TEXT.ENOTDIR}`)
        continue
      }
      try {
        context.fs.remove(path)
      } catch (error) {
        errors.push(errorText('rmdir', error, operand))
        continue
      }
      if (hasFlag(parsed.flags, 'v')) {
        removed.push(`rmdir: removing directory, '${operand}'`)
      }
      if (!hasFlag(parsed.flags, 'p')) {
        continue
      }
      let current = dirName(path)
      while (current !== '/') {
        try {
          if (context.fs.readdir(current).length > 0) {
            break
          }
          context.fs.remove(current)
          current = dirName(current)
        } catch {
          break
        }
      }
    }
    return resultFrom(removed.join('\n'), errors)
  },
}

const rmApplet: Applet = {
  name: 'rm',
  summary: '删除文件或目录（-r 递归、-f 静默；-i 不交互，直接删）',
  summaryEn: 'Remove files or directories',
  usage: 'rm [-rRfi] FILE...',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      r: 'boolean',
      R: 'boolean',
      f: 'boolean',
      i: 'boolean',
      v: 'boolean',
    })
    if (parsed.error) {
      return usageError('rm', parsed.error)
    }
    if (parsed.operands.length === 0) {
      if (hasFlag(parsed.flags, 'f')) {
        return ok()
      }
      return usageError('rm', 'missing operand')
    }
    const recursive = hasFlag(parsed.flags, 'r') || hasFlag(parsed.flags, 'R')
    const force = hasFlag(parsed.flags, 'f')
    const verbose = hasFlag(parsed.flags, 'v')
    const errors: string[] = []
    const removed: string[] = []
    for (const operand of parsed.operands) {
      const path = resolvePath(context.cwd, operand)
      const entry = context.fs.stat(path)
      if (!entry) {
        if (!force) {
          errors.push(`rm: cannot remove '${operand}': ${ERRNO_TEXT.ENOENT}`)
        }
        continue
      }
      if (entry.kind === 'dir' && !recursive) {
        errors.push(`rm: cannot remove '${operand}': ${ERRNO_TEXT.EISDIR}`)
        continue
      }
      try {
        context.fs.remove(path, recursive)
        if (verbose) {
          removed.push(`removed '${operand}'`)
        }
      } catch (error) {
        errors.push(errorText('rm', error, operand))
      }
    }
    return resultFrom(removed.join('\n'), errors)
  },
}

// ---------- cp / mv / touch / ln ----------

const copyOrMove = (
  context: AppletContext,
  command: 'cp' | 'mv',
  operands: string[],
  options: { recursive: boolean; force: boolean; noClobber: boolean; verbose: boolean }
): AppletResult => {
  if (operands.length < 2) {
    return usageError(command, 'missing destination file operand')
  }
  const sources = operands.slice(0, -1)
  const destination = operands[operands.length - 1]
  const destinationPath = resolvePath(context.cwd, destination)
  const destinationIsDir = context.fs.isDirectory(destinationPath)
  if (sources.length > 1 && !destinationIsDir) {
    return usageError(command, `target '${destination}' is not a directory`)
  }
  const errors: string[] = []
  const notes: string[] = []
  for (const source of sources) {
    const from = resolvePath(context.cwd, source)
    const entry = context.fs.stat(from)
    if (!entry) {
      errors.push(`${command}: cannot stat '${source}': ${ERRNO_TEXT.ENOENT}`)
      continue
    }
    const target = destinationIsDir
      ? normalizePath(`${destinationPath}/${baseName(from)}`)
      : destinationPath
    if (options.noClobber && context.fs.exists(target)) {
      continue
    }
    if (command === 'mv' && !options.force && context.fs.isDirectory(target)) {
      const children = context.fs.readdir(target)
      if (children.some((child) => child.name === baseName(from))) {
        errors.push(`mv: cannot overwrite '${target}': Directory not empty`)
        continue
      }
    }
    try {
      if (command === 'cp') {
        context.fs.copy(from, target, { recursive: options.recursive })
      } else {
        context.fs.move(from, target)
      }
      if (options.verbose) {
        notes.push(`'${source}' -> '${target}'`)
      }
    } catch (error) {
      errors.push(errorText(command, error, source))
    }
  }
  return resultFrom(notes.join('\n'), errors)
}

const cpApplet: Applet = {
  name: 'cp',
  summary: '复制文件或目录（-r 递归复制目录）',
  summaryEn: 'Copy files and directories',
  usage: 'cp [-rRfnv] SOURCE... DEST',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      r: 'boolean',
      R: 'boolean',
      a: 'boolean',
      f: 'boolean',
      n: 'boolean',
      v: 'boolean',
    })
    if (parsed.error) {
      return usageError('cp', parsed.error)
    }
    return copyOrMove(context, 'cp', parsed.operands, {
      recursive:
        hasFlag(parsed.flags, 'r') || hasFlag(parsed.flags, 'R') || hasFlag(parsed.flags, 'a'),
      force: hasFlag(parsed.flags, 'f'),
      noClobber: hasFlag(parsed.flags, 'n'),
      verbose: hasFlag(parsed.flags, 'v'),
    })
  },
}

const mvApplet: Applet = {
  name: 'mv',
  summary: '移动或重命名文件与目录',
  summaryEn: 'Move or rename files',
  usage: 'mv [-fnv] SOURCE... DEST',
  run: (context) => {
    const parsed = parseArgs(context.argv, { f: 'boolean', n: 'boolean', v: 'boolean' })
    if (parsed.error) {
      return usageError('mv', parsed.error)
    }
    return copyOrMove(context, 'mv', parsed.operands, {
      recursive: true,
      force: hasFlag(parsed.flags, 'f'),
      noClobber: hasFlag(parsed.flags, 'n'),
      verbose: hasFlag(parsed.flags, 'v'),
    })
  },
}

const touchApplet: Applet = {
  name: 'touch',
  summary: '创建空文件或更新文件时间',
  summaryEn: 'Create empty files or update timestamps',
  usage: 'touch [-c] FILE...',
  run: (context) => {
    const parsed = parseArgs(context.argv, { c: 'boolean', a: 'boolean', m: 'boolean' })
    if (parsed.error) {
      return usageError('touch', parsed.error)
    }
    if (parsed.operands.length === 0) {
      return usageError('touch', 'missing file operand')
    }
    const noCreate = hasFlag(parsed.flags, 'c')
    const errors: string[] = []
    for (const operand of parsed.operands) {
      const path = resolvePath(context.cwd, operand)
      const entry = context.fs.stat(path)
      if (!entry) {
        if (noCreate) {
          continue
        }
        try {
          context.fs.write(path, new Uint8Array(0))
        } catch (error) {
          errors.push(errorText('touch', error, operand))
        }
        continue
      }
      if (entry.kind === 'dir') {
        // 虚拟文件系统没有 utimes：目录只当已存在
        continue
      }
      // 重写同样的内容只为把 mtime 顶到当前时间
      const bytes = context.fs.read(path)
      if (bytes) {
        try {
          context.fs.write(path, bytes)
        } catch (error) {
          errors.push(errorText('touch', error, operand))
        }
      }
    }
    return resultFrom('', errors)
  },
}

const lnApplet: Applet = {
  name: 'ln',
  summary: '链接文件（硬链接以复制实现；不支持符号链接）',
  summaryEn: 'Link files (hard links are copies; symlinks unsupported)',
  usage: 'ln [-f] TARGET LINK_NAME',
  run: (context) => {
    const parsed = parseArgs(context.argv, { s: 'boolean', f: 'boolean', v: 'boolean' })
    if (parsed.error) {
      return usageError('ln', parsed.error)
    }
    if (hasFlag(parsed.flags, 's')) {
      return {
        code: 1,
        stderr: 'ln: symbolic links are not supported by NanoVM Slim（虚拟文件系统没有 symlink）\n',
      }
    }
    const operands = parsed.operands
    if (operands.length < 2) {
      return usageError('ln', 'missing destination file operand')
    }
    const source = operands[0]
    const destination = operands[operands.length - 1]
    const from = resolvePath(context.cwd, source)
    const to = resolvePath(context.cwd, destination)
    const entry = context.fs.stat(from)
    if (!entry) {
      return { code: 1, stderr: `ln: failed to access '${source}': ${ERRNO_TEXT.ENOENT}\n` }
    }
    if (entry.kind === 'dir') {
      return { code: 1, stderr: `ln: '${source}': hard link not allowed for directory\n` }
    }
    const target = context.fs.isDirectory(to) ? normalizePath(`${to}/${baseName(from)}`) : to
    if (context.fs.exists(target) && !hasFlag(parsed.flags, 'f')) {
      return { code: 1, stderr: `ln: failed to create hard link '${destination}': File exists\n` }
    }
    try {
      context.fs.copy(from, target)
    } catch (error) {
      return { code: 1, stderr: `${errorText('ln', error, source)}\n` }
    }
    return ok(hasFlag(parsed.flags, 'v') ? `'${target}' => '${source}'\n` : '')
  },
}

// ---------- stat / chmod / du / df ----------

/** 路径的假 inode：同一个路径每次都一样，看着像真的 */
const inodeOf = (path: string): number => {
  let hash = 0
  for (let index = 0; index < path.length; index += 1) {
    hash = (hash * 31 + path.charCodeAt(index)) >>> 0
  }
  return (hash % 100_000) + 1
}

const statTimestamp = (time: number): string => {
  const date = new Date(time)
  const offset = -date.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  const absolute = Math.abs(offset)
  return `${stamp(time)}:${pad2(date.getSeconds())}.000000000 ${sign}${pad2(Math.floor(absolute / 60))}${pad2(absolute % 60)}`
}

const statLine = (format: string, entry: FsEntry): string => {
  let output = ''
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index]
    if (char === '\\') {
      const escaped = readEscape(format, index)
      output += escaped.text
      index = escaped.end - 1
      continue
    }
    if (char !== '%') {
      output += char
      continue
    }
    const code = format[index + 1]
    index += 1
    switch (code) {
      case 'n':
        output += entry.path
        break
      case 'N':
        output += `'${entry.path}'`
        break
      case 's':
        output += String(entry.size)
        break
      case 'a':
        output += (entry.mode & 0o7777).toString(8)
        break
      case 'A':
        output += modeText(entry.mode, entry.kind)
        break
      case 'F':
        output += fileKind(entry)
        break
      case 'Y':
        output += String(Math.floor(entry.mtime / 1000))
        break
      case 'y':
        output += statTimestamp(entry.mtime)
        break
      case 'U':
        output += USER
        break
      case 'G':
        output += GROUP
        break
      case 'u':
        output += String(UID)
        break
      case 'g':
        output += String(GID)
        break
      case 'h':
        output += String(entry.kind === 'dir' ? 2 : 1)
        break
      case 'i':
        output += String(inodeOf(entry.path))
        break
      case '%':
        output += '%'
        break
      default:
        output += `%${code ?? ''}`
        break
    }
  }
  return output
}

const statApplet: Applet = {
  name: 'stat',
  summary: '显示文件状态（-c 自定义格式）',
  summaryEn: 'Display file status',
  usage: 'stat [-c FORMAT] FILE...',
  run: (context) => {
    const parsed = parseArgs(context.argv, { c: 'value', t: 'boolean', L: 'boolean' })
    if (parsed.error) {
      return usageError('stat', parsed.error)
    }
    if (parsed.operands.length === 0) {
      return usageError('stat', 'missing operand')
    }
    const format = stringFlag(parsed.flags, 'c')
    const errors: string[] = []
    const blocks: string[] = []
    for (const operand of parsed.operands) {
      const entry = context.fs.stat(resolvePath(context.cwd, operand))
      if (!entry) {
        errors.push(`stat: cannot statx '${operand}': ${ERRNO_TEXT.ENOENT}`)
        continue
      }
      if (format !== undefined) {
        blocks.push(statLine(format, entry))
        continue
      }
      const blocks512 = Math.ceil(entry.size / 512)
      blocks.push(
        [
          `  File: ${entry.path}`,
          `  Size: ${indent(String(entry.size), 8)}\tBlocks: ${blocks512}\tIO Block: 4096   ${fileKind(entry)}`,
          `Device: nanovm\tInode: ${inodeOf(entry.path)}\tLinks: ${entry.kind === 'dir' ? 2 : 1}`,
          `Access: (0${(entry.mode & 0o7777).toString(8)}/${modeText(entry.mode, entry.kind)})  Uid: (${indent(String(UID), 5)}/${indent(USER, 8)})   Gid: (${indent(String(GID), 5)}/${indent(GROUP, 8)})`,
          `Access: ${statTimestamp(entry.mtime)}`,
          `Modify: ${statTimestamp(entry.mtime)}`,
          `Change: ${statTimestamp(entry.mtime)}`,
        ].join('\n')
      )
    }
    return resultFrom(blocks.join('\n'), errors)
  },
}

/** 支持 644 与 u+x / go-w 两种写法 */
const symbolicMode = (current: number, spec: string): number | null => {
  const match = /^([ugoa]*)([+=-])([rwx]*(?:[rwx]*))$/.exec(spec)
  if (!match) {
    return null
  }
  const who = match[1].length > 0 ? match[1] : 'a'
  const operator = match[2]
  const permissions = match[3]
  const classes: string[] = who.includes('a') ? ['u', 'g', 'o'] : [...who]
  let next = current
  for (const group of classes) {
    const shift = group === 'u' ? 6 : group === 'g' ? 3 : 0
    let bits = 0
    for (const permission of permissions) {
      bits |= permission === 'r' ? 4 : permission === 'w' ? 2 : permission === 'x' ? 1 : 0
    }
    const mask = bits << shift
    const classMask = 0o7 << shift
    if (operator === '+') {
      next |= mask
    } else if (operator === '-') {
      next &= ~mask
    } else {
      next = (next & ~classMask) | mask
    }
  }
  return next
}

const chmodApplet: Applet = {
  name: 'chmod',
  summary: '修改权限位（644 或 +x 两种写法，-R 递归）',
  summaryEn: 'Change file mode bits',
  usage: 'chmod [-R] MODE FILE...',
  run: (context) => {
    const parsed = parseArgs(context.argv, { R: 'boolean', v: 'boolean', f: 'boolean' })
    if (parsed.error) {
      return usageError('chmod', parsed.error)
    }
    if (parsed.operands.length < 2) {
      return usageError('chmod', 'missing operand')
    }
    const [modeTextOperand, ...operands] = parsed.operands
    const errors: string[] = []
    const notes: string[] = []
    const apply = (path: string, operand: string): void => {
      const entry = context.fs.stat(path)
      if (!entry) {
        errors.push(`chmod: cannot access '${operand}': ${ERRNO_TEXT.ENOENT}`)
        return
      }
      const mode = parseMode(modeTextOperand) ?? symbolicMode(entry.mode, modeTextOperand)
      if (mode === null) {
        errors.push(`chmod: invalid mode: '${modeTextOperand}'`)
        return
      }
      try {
        context.fs.chmod(path, mode)
        if (hasFlag(parsed.flags, 'v')) {
          notes.push(`mode of '${operand}' changed to 0${(mode & 0o7777).toString(8)}`)
        }
      } catch (error) {
        errors.push(errorText('chmod', error, operand))
      }
    }
    for (const operand of operands) {
      const path = resolvePath(context.cwd, operand)
      apply(path, operand)
      if (!hasFlag(parsed.flags, 'R')) {
        continue
      }
      const entry = context.fs.stat(path)
      if (entry?.kind !== 'dir') {
        continue
      }
      for (const child of context.fs.walk(path)) {
        apply(child.path, child.path)
      }
    }
    return resultFrom(notes.join('\n'), errors)
  },
}

const duApplet: Applet = {
  name: 'du',
  summary: '统计目录占用（-s 只看总计、-h 人类可读）',
  summaryEn: 'Estimate file space usage',
  usage: 'du [-sah] [FILE]...',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      s: 'boolean',
      a: 'boolean',
      h: 'boolean',
      c: 'boolean',
    })
    if (parsed.error) {
      return usageError('du', parsed.error)
    }
    const human = hasFlag(parsed.flags, 'h')
    const summary = hasFlag(parsed.flags, 's')
    const all = hasFlag(parsed.flags, 'a')
    const scale = (bytes: number): string =>
      human ? humanSize(bytes) : String(Math.ceil(bytes / 1024))
    const sizeOf = (path: string): number => {
      const entry = context.fs.stat(path)
      if (!entry) {
        return 0
      }
      if (entry.kind === 'file') {
        return entry.size
      }
      return context.fs
        .walk(path)
        .reduce((sum, child) => sum + (child.kind === 'file' ? child.size : 0), 0)
    }
    const operands = parsed.operands.length > 0 ? parsed.operands : ['.']
    const errors: string[] = []
    const lines: string[] = []
    let grandTotal = 0
    for (const operand of operands) {
      const path = resolvePath(context.cwd, operand)
      const entry = context.fs.stat(path)
      if (!entry) {
        errors.push(`du: cannot access '${operand}': ${ERRNO_TEXT.ENOENT}`)
        continue
      }
      const total = sizeOf(path)
      grandTotal += total
      if (entry.kind === 'dir') {
        for (const child of context.fs.walk(path)) {
          if (child.kind === 'dir') {
            if (!summary) {
              lines.push(`${scale(sizeOf(child.path))}\t${child.path}`)
            }
          } else if (all) {
            lines.push(`${scale(child.size)}\t${child.path}`)
          }
        }
      }
      lines.push(`${scale(total)}\t${operand}`)
    }
    if (hasFlag(parsed.flags, 'c')) {
      lines.push(`${scale(grandTotal)}\ttotal`)
    }
    return resultFrom(lines.join('\n'), errors)
  },
}

const dfApplet: Applet = {
  name: 'df',
  summary: '显示虚拟磁盘容量（-h 人类可读、-i inode）',
  summaryEn: 'Report virtual disk space usage',
  usage: 'df [-h] [-i]',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      h: 'boolean',
      i: 'boolean',
      k: 'boolean',
      P: 'boolean',
    })
    if (parsed.error) {
      return usageError('df', parsed.error)
    }
    const limits = context.fs.getLimits()
    const usage = context.fs.usage()
    const human = hasFlag(parsed.flags, 'h')
    if (hasFlag(parsed.flags, 'i')) {
      const free = Math.max(0, limits.maxFiles - usage.files)
      const percent = limits.maxFiles > 0 ? Math.ceil((usage.files / limits.maxFiles) * 100) : 0
      const header = `${'Filesystem'.padEnd(14)}${indent('Inodes', 8)}${indent('IUsed', 8)}${indent('IFree', 8)}${indent('IUse%', 6)} Mounted on`
      const row = `${'nanovm-disk'.padEnd(14)}${indent(String(limits.maxFiles), 8)}${indent(String(usage.files), 8)}${indent(String(free), 8)}${indent(`${percent}%`, 6)} /`
      return ok(`${header}\n${row}\n`)
    }
    const total = limits.diskMB * 1024 * 1024
    const used = usage.bytes
    const available = Math.max(0, total - used)
    const percent = total > 0 ? Math.ceil((used / total) * 100) : 0
    if (human) {
      const header = `${'Filesystem'.padEnd(14)}${indent('Size', 6)}${indent('Used', 6)}${indent('Avail', 6)}${indent('Use%', 6)} Mounted on`
      const row = `${'nanovm-disk'.padEnd(14)}${indent(humanSize(total), 6)}${indent(humanSize(used), 6)}${indent(humanSize(available), 6)}${indent(`${percent}%`, 6)} /`
      return ok(`${header}\n${row}\n`)
    }
    const header = `${'Filesystem'.padEnd(14)}${indent('1K-blocks', 10)}${indent('Used', 8)}${indent('Available', 10)}${indent('Use%', 6)} Mounted on`
    const row = `${'nanovm-disk'.padEnd(14)}${indent(String(Math.round(total / 1024)), 10)}${indent(String(Math.round(used / 1024)), 8)}${indent(String(Math.round(available / 1024)), 10)}${indent(`${percent}%`, 6)} /`
    return ok(`${header}\n${row}\n`)
  },
}

// ---------- 环境变量 ----------

const visibleEnv = (env: Record<string, string>): [string, string][] =>
  Object.entries(env).filter(([name]) => !name.startsWith('ALIAS_'))

const envApplet: Applet = {
  name: 'env',
  summary: '打印环境变量；也可以用临时变量执行命令',
  summaryEn: 'Print environment or run a command with modified environment',
  usage: 'env [NAME=VALUE]... [COMMAND [ARG]...]',
  run: (context) => {
    const args = context.argv.slice(1)
    const commandIndex = args.findIndex((arg) => !arg.includes('='))
    const overrides: Record<string, string> = { ...context.env }
    const assignments = commandIndex === -1 ? args : args.slice(0, commandIndex)
    for (const assignment of assignments) {
      const equals = assignment.indexOf('=')
      if (equals > 0) {
        overrides[assignment.slice(0, equals)] = assignment.slice(equals + 1)
      }
    }
    if (commandIndex === -1) {
      const lines = visibleEnv(overrides).map(([name, value]) => `${name}=${value}`)
      return ok(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    }
    return context.shell
      .run(args.slice(commandIndex).join(' '), {
        cwd: context.cwd,
        env: overrides,
      })
      .then((result) => ({ code: result.code, stdout: result.stdout, stderr: result.stderr }))
  },
}

const exportApplet: Applet = {
  name: 'export',
  summary: '设置或列出导出给子进程的环境变量',
  summaryEn: 'Set or list exported environment variables',
  usage: 'export [NAME[=VALUE]]...',
  run: (context) => {
    const args = context.argv.slice(1)
    if (args.length === 0) {
      const lines = visibleEnv(context.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `export ${name}="${value}"`)
      return ok(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    }
    const errors: string[] = []
    for (const arg of args) {
      const equals = arg.indexOf('=')
      const name = equals >= 0 ? arg.slice(0, equals) : arg
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        errors.push(`export: '${arg}': not a valid identifier`)
        continue
      }
      if (equals >= 0) {
        context.setenv(name, arg.slice(equals + 1))
      } else if (context.env[name] === undefined) {
        context.setenv(name, '')
      }
    }
    if (errors.length > 0) {
      return { code: 1, stderr: `${errors.join('\n')}\n` }
    }
    return ok()
  },
}

const unsetApplet: Applet = {
  name: 'unset',
  summary: '删除环境变量',
  summaryEn: 'Remove environment variables',
  usage: 'unset [-v] NAME...',
  run: (context) => {
    const names = context.argv.slice(1).filter((arg) => !arg.startsWith('-'))
    if (names.length === 0) {
      return usageError('unset', 'missing operand')
    }
    for (const name of names) {
      context.setenv(name, null)
    }
    return ok()
  },
}

const setApplet: Applet = {
  name: 'set',
  summary: '列出 shell 变量（NanoVM Slim 不支持 set -e / -x）',
  summaryEn: 'List shell variables',
  usage: 'set [NAME=VALUE]...',
  run: (context) => {
    const args = context.argv.slice(1)
    if (args.length === 0) {
      const lines = visibleEnv(context.env)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => `${name}=${shellQuote(value)}`)
      return ok(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    }
    const errors: string[] = []
    for (const arg of args) {
      const equals = arg.indexOf('=')
      if (equals > 0) {
        context.setenv(arg.slice(0, equals), arg.slice(equals + 1))
        continue
      }
      errors.push(`set: NanoVM Slim 不支持 shell 选项或位置参数 '${arg}'`)
    }
    if (errors.length > 0) {
      return { code: 1, stderr: `${errors.join('\n')}\n` }
    }
    return ok()
  },
}

// ---------- which / type ----------

/** 命令表由 applets/index.ts 组装；动态取，避免 static 循环依赖 */
let commandTable: Promise<ReadonlyMap<string, Applet>> | null = null

const commandNames = async (): Promise<string[]> => {
  commandTable ??= import('./index.js').then((module) => module.APPLET_MAP)
  const table = await commandTable
  return [...table.keys()]
}

const whichApplet: Applet = {
  name: 'which',
  summary: '显示命令的完整路径',
  summaryEn: 'Locate a command',
  usage: 'which COMMAND...',
  run: async (context) => {
    const names = context.argv.slice(1)
    if (names.length === 0) {
      return usageError('which', 'missing operand')
    }
    const known = new Set(await commandNames())
    const lines: string[] = []
    const errors: string[] = []
    for (const name of names) {
      if (known.has(name)) {
        lines.push(`/usr/bin/${name}`)
        continue
      }
      const file = findInPath(context, name)
      if (file) {
        lines.push(file)
      } else {
        errors.push(`which: no ${name} in (${context.env.PATH ?? '/usr/bin:/bin'})`)
      }
    }
    return {
      code: errors.length > 0 ? 1 : 0,
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    }
  },
}

const SHELL_BUILTINS = new Set([
  'cd',
  'export',
  'unset',
  'alias',
  'unalias',
  'set',
  // sh / bash / exit 由执行器自身实现（要用解释器内部状态）
  'sh',
  'bash',
  'exit',
])

/** 按 $PATH 找一个可执行文件：which / type 用，和 exec 的查找规则一致 */
const findInPath = (context: AppletContext, name: string): string | null => {
  if (name.includes('/')) {
    const path = resolvePath(context.cwd, name)
    const entry = context.fs.stat(path)
    return entry?.kind === 'file' && (entry.mode & 0o111) !== 0 ? path : null
  }
  const searchPath = context.env.PATH ?? '/usr/bin:/bin'
  for (const directory of searchPath.split(':')) {
    const base = directory.length === 0 ? context.cwd : resolvePath(context.cwd, directory)
    const candidate = normalizePath(`${base}/${name}`)
    const entry = context.fs.stat(candidate)
    if (entry?.kind === 'file' && (entry.mode & 0o111) !== 0) {
      return candidate
    }
  }
  return null
}

const typeApplet: Applet = {
  name: 'type',
  summary: '说明一个名字是内建命令、别名还是外部命令',
  summaryEn: 'Describe how a name would be interpreted',
  usage: 'type NAME...',
  run: async (context) => {
    const names = context.argv.slice(1)
    if (names.length === 0) {
      return usageError('type', 'missing operand')
    }
    const known = new Set(await commandNames())
    const lines: string[] = []
    const errors: string[] = []
    for (const name of names) {
      const alias = context.env[`ALIAS_${name}`]
      if (alias !== undefined) {
        lines.push(`${name} is an alias for '${alias}'`)
        continue
      }
      if (SHELL_BUILTINS.has(name)) {
        lines.push(`${name} is a shell builtin`)
        continue
      }
      if (known.has(name)) {
        lines.push(`${name} is /usr/bin/${name}`)
        continue
      }
      const file = findInPath(context, name)
      if (file) {
        lines.push(`${name} is ${file}`)
        continue
      }
      errors.push(`type: ${name}: not found`)
    }
    return {
      code: errors.length > 0 ? 1 : 0,
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    }
  },
}

// ---------- true / false / test ----------

const trueApplet: Applet = {
  name: 'true',
  summary: '什么都不做，返回 0',
  summaryEn: 'Do nothing, successfully',
  usage: 'true',
  run: () => ok(),
}

const falseApplet: Applet = {
  name: 'false',
  summary: '什么都不做，返回 1',
  summaryEn: 'Do nothing, unsuccessfully',
  usage: 'false',
  run: () => ({ code: 1 }),
}

const UNARY_OPERATORS = new Set([
  '-e',
  '-f',
  '-d',
  '-s',
  '-r',
  '-w',
  '-x',
  '-L',
  '-h',
  '-b',
  '-c',
  '-p',
  '-S',
  '-t',
  '-z',
  '-n',
])

const BINARY_OPERATORS = new Set([
  '=',
  '==',
  '!=',
  '<',
  '>',
  '-eq',
  '-ne',
  '-lt',
  '-le',
  '-gt',
  '-ge',
])

type TestState = {
  tokens: string[]
  index: number
  fs: NanovmFS
  cwd: string
  error?: string
}

const statOf = (state: TestState, operand: string): FsEntry | null =>
  state.fs.stat(resolvePath(state.cwd, operand))

const unaryTest = (state: TestState, operator: string, operand: string): boolean => {
  if (operator === '-z') {
    return operand.length === 0
  }
  if (operator === '-n') {
    return operand.length > 0
  }
  if (operator === '-t') {
    return false
  }
  const entry = statOf(state, operand)
  if (operator === '-e') {
    return entry !== null
  }
  if (operator === '-f') {
    return entry?.kind === 'file'
  }
  if (operator === '-d') {
    return entry?.kind === 'dir'
  }
  if (operator === '-s') {
    return entry !== null && entry.size > 0
  }
  if (operator === '-L' || operator === '-h') {
    // 虚拟文件系统没有符号链接
    return false
  }
  if (operator === '-b' || operator === '-c' || operator === '-p' || operator === '-S') {
    return false
  }
  if (operator === '-r') {
    return entry !== null && (entry.mode & 0o444) !== 0
  }
  if (operator === '-w') {
    return entry !== null && (entry.mode & 0o222) !== 0
  }
  if (operator === '-x') {
    return entry !== null && (entry.mode & 0o111) !== 0
  }
  return false
}

const binaryTest = (state: TestState, left: string, operator: string, right: string): boolean => {
  if (operator === '=' || operator === '==') {
    return left === right
  }
  if (operator === '!=') {
    return left !== right
  }
  if (operator === '<') {
    return left < right
  }
  if (operator === '>') {
    return left > right
  }
  const leftNumber = Number(left)
  const rightNumber = Number(right)
  if (!Number.isFinite(leftNumber) || !Number.isFinite(rightNumber)) {
    state.error = `integer expression expected: '${left}'`
    return false
  }
  if (operator === '-eq') {
    return leftNumber === rightNumber
  }
  if (operator === '-ne') {
    return leftNumber !== rightNumber
  }
  if (operator === '-lt') {
    return leftNumber < rightNumber
  }
  if (operator === '-le') {
    return leftNumber <= rightNumber
  }
  if (operator === '-gt') {
    return leftNumber > rightNumber
  }
  return leftNumber >= rightNumber
}

const parseTestOr = (state: TestState): boolean => {
  let value = parseTestAnd(state)
  while (state.tokens[state.index] === '-o') {
    state.index += 1
    const right = parseTestAnd(state)
    value = value || right
  }
  return value
}

const parseTestAnd = (state: TestState): boolean => {
  let value = parseTestNot(state)
  while (state.tokens[state.index] === '-a') {
    state.index += 1
    const right = parseTestNot(state)
    value = value && right
  }
  return value
}

const parseTestNot = (state: TestState): boolean => {
  if (state.tokens[state.index] === '!') {
    state.index += 1
    return !parseTestNot(state)
  }
  return parseTestPrimary(state)
}

const parseTestPrimary = (state: TestState): boolean => {
  if (state.error) {
    return false
  }
  const token = state.tokens[state.index]
  if (token === undefined) {
    state.error = 'argument expected'
    return false
  }
  if (token === '(') {
    state.index += 1
    const value = parseTestOr(state)
    if (state.tokens[state.index] !== ')') {
      state.error = "')' expected"
      return false
    }
    state.index += 1
    return value
  }
  const operator = state.tokens[state.index + 1]
  if (operator !== undefined && BINARY_OPERATORS.has(operator)) {
    const right = state.tokens[state.index + 2]
    if (right === undefined) {
      state.error = `argument expected after '${operator}'`
      return false
    }
    state.index += 3
    return binaryTest(state, token, operator, right)
  }
  if (UNARY_OPERATORS.has(token)) {
    const operand = state.tokens[state.index + 1]
    if (operand === undefined) {
      state.error = `argument expected after '${token}'`
      return false
    }
    state.index += 2
    return unaryTest(state, token, operand)
  }
  state.index += 1
  return token.length > 0
}

const testRun = (context: AppletContext, bracket: boolean): AppletResult => {
  const name = bracket ? '[' : 'test'
  let tokens = context.argv.slice(1)
  if (bracket) {
    if (tokens.at(-1) !== ']') {
      return { code: 2, stderr: "[: missing ']'\n" }
    }
    tokens = tokens.slice(0, -1)
  }
  const state: TestState = { tokens, index: 0, fs: context.fs, cwd: context.cwd }
  const value = parseTestOr(state)
  if (state.error) {
    return { code: 2, stderr: `${name}: ${state.error}\n` }
  }
  if (state.index !== tokens.length) {
    return { code: 2, stderr: `${name}: too many arguments\n` }
  }
  return value ? ok() : { code: 1 }
}

const testApplet: Applet = {
  name: 'test',
  summary: '条件判断（-e -f -d -z -n、= !=、-eq 系列）',
  summaryEn: 'Evaluate conditional expressions',
  usage: 'test EXPRESSION',
  run: (context) => testRun(context, false),
}

const bracketApplet: Applet = {
  name: '[',
  summary: 'test 的另一种写法，要求以 ] 结尾',
  summaryEn: 'Synonym for test, requires closing ]',
  usage: '[ EXPRESSION ]',
  run: (context) => testRun(context, true),
}

// ---------- seq / yes / sleep ----------

const formatSeqNumber = (value: number, decimal: boolean): string => {
  if (!decimal) {
    return String(Math.round(value))
  }
  return String(Number(value.toFixed(10)))
}

const applySeqFormat = (format: string, value: number): string =>
  format.replace(/%%|%[-+ 0#]*\d*(?:\.\d+)?[diouxXfFeEgG]/g, (token) => {
    if (token === '%%') {
      return '%'
    }
    const precision = /\.(\d+)/.exec(token)
    const digits = precision ? Number(precision[1]) : 6
    const conversion = token[token.length - 1]
    if (conversion === 'd' || conversion === 'i' || conversion === 'u') {
      return String(Math.round(value))
    }
    if (conversion === 'x') {
      return Math.round(value).toString(16)
    }
    if (conversion === 'X') {
      return Math.round(value).toString(16).toUpperCase()
    }
    if (conversion === 'o') {
      return Math.round(value).toString(8)
    }
    if (conversion === 'g' || conversion === 'G') {
      return String(Number(value.toPrecision(digits)))
    }
    return value.toFixed(digits)
  })

const seqApplet: Applet = {
  name: 'seq',
  summary: '打印数字序列（seq LAST / FIRST LAST / FIRST STEP LAST）',
  summaryEn: 'Print a sequence of numbers',
  usage: 'seq [-w] [-s SEP] [-f FORMAT] [FIRST [STEP]] LAST',
  run: (context) => {
    const parsed = parseArgs(context.argv, { w: 'boolean', s: 'value', f: 'value' })
    if (parsed.error) {
      return usageError('seq', parsed.error)
    }
    const operands = parsed.operands
    if (operands.length === 0) {
      return usageError('seq', 'missing operand')
    }
    if (operands.length > 3) {
      return usageError('seq', `extra operand '${operands[3]}'`)
    }
    const invalid = operands.find((operand) => Number.isNaN(Number(operand)))
    if (invalid !== undefined) {
      return usageError('seq', `invalid argument '${invalid}'`, 1)
    }
    const numbers = operands.map((operand) => Number(operand))
    const first = numbers.length === 1 ? 1 : numbers[0]
    const step = numbers.length === 3 ? numbers[1] : 1
    const last = numbers.length === 1 ? numbers[0] : numbers[numbers.length - 1]
    if (step === 0) {
      return usageError('seq', 'invalid Zero increment value: 0', 1)
    }
    if ((step > 0 && first > last) || (step < 0 && first < last)) {
      return {
        code: 1,
        stderr: `seq: invalid Floating point argument: ${first} ${step} ${last}\n`,
      }
    }
    const decimal =
      !Number.isInteger(step) || operands.some((operand) => !Number.isInteger(Number(operand)))
    const separator = stringFlag(parsed.flags, 's') ?? '\n'
    const format = stringFlag(parsed.flags, 'f')
    const budget = outputBudget(context)
    const lines: string[] = []
    let bytes = 0
    for (let index = 0; index < 1_000_000; index += 1) {
      const value = first + step * index
      const done = step > 0 ? value > last + 1e-9 : value < last - 1e-9
      if (done) {
        break
      }
      const text =
        format === undefined ? formatSeqNumber(value, decimal) : applySeqFormat(format, value)
      if (bytes + text.length + 1 > budget) {
        break
      }
      bytes += text.length + 1
      lines.push(text)
      if (index % 4096 === 0 && interrupted(context)) {
        break
      }
    }
    if (lines.length === 0) {
      return ok()
    }
    if (hasFlag(parsed.flags, 'w')) {
      const width = lines.reduce((max, line) => Math.max(max, line.length), 0)
      const padded = lines.map((line) =>
        line.startsWith('-')
          ? `-${line.slice(1).padStart(width - 1, '0')}`
          : line.padStart(width, '0')
      )
      return ok(`${padded.join(separator)}\n`)
    }
    return ok(`${lines.join(separator)}\n`)
  },
}

const yesApplet: Applet = {
  name: 'yes',
  summary: '重复输出一行（输出上限 1 MiB：NanoVM 没有 SIGPIPE）',
  summaryEn: 'Print a line repeatedly (capped at 1 MiB)',
  usage: 'yes [STRING]',
  run: (context) => {
    const text = context.argv.slice(1).join(' ') || 'y'
    const line = `${text}\n`
    const limit = Math.min(outputBudget(context), 1024 * 1024)
    const count = Math.floor(limit / line.length)
    let output = ''
    for (let index = 0; index < count; index += 1) {
      output += line
      if (index % 4096 === 0 && interrupted(context)) {
        break
      }
    }
    return ok(output)
  },
}

const parseDuration = (text: string): number | null => {
  const match = /^(\d+(?:\.\d+)?)([smhd]?)$/.exec(text)
  if (!match) {
    return null
  }
  const value = Number(match[1])
  const unit = match[2]
  const factor = unit === 'm' ? 60 : unit === 'h' ? 3600 : unit === 'd' ? 86_400 : 1
  return value * factor
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms)
  })

const sleepApplet: Applet = {
  name: 'sleep',
  summary: '等待若干秒（支持 s / m / h / d 后缀）',
  summaryEn: 'Delay for a given time',
  usage: 'sleep NUMBER[smhd]...',
  run: async (context) => {
    const args = context.argv.slice(1)
    if (args.length === 0) {
      return usageError('sleep', 'missing operand')
    }
    let total = 0
    for (const arg of args) {
      const seconds = parseDuration(arg)
      if (seconds === null) {
        return usageError('sleep', `invalid time interval '${arg}'`, 1)
      }
      total += seconds
    }
    const end = Date.now() + total * 1000
    while (Date.now() < end) {
      if (interrupted(context)) {
        return { code: 130 }
      }
      await sleep(Math.min(50, Math.max(1, end - Date.now())))
    }
    return ok()
  },
}

// ---------- date ----------

const timezoneName = (date: Date, utc: boolean): string => {
  if (utc) {
    return 'UTC'
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(date)
    return parts.find((part) => part.type === 'timeZoneName')?.value ?? 'UTC'
  } catch {
    return 'UTC'
  }
}

const formatDate = (date: Date, format: string, utc: boolean): string => {
  const year = utc ? date.getUTCFullYear() : date.getFullYear()
  const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1
  const day = utc ? date.getUTCDate() : date.getDate()
  const hours = utc ? date.getUTCHours() : date.getHours()
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes()
  const seconds = utc ? date.getUTCSeconds() : date.getSeconds()
  const weekday = utc ? date.getUTCDay() : date.getDay()
  const offset = utc ? 0 : -date.getTimezoneOffset()
  const dayOfYear =
    Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1
  const zone = timezoneName(date, utc)
  const offsetSign = offset >= 0 ? '+' : '-'
  const offsetAbsolute = Math.abs(offset)
  let output = ''
  for (let index = 0; index < format.length; index += 1) {
    const char = format[index]
    if (char !== '%') {
      output += char
      continue
    }
    const code = format[index + 1] ?? ''
    index += 1
    switch (code) {
      case 'Y':
        output += String(year)
        break
      case 'm':
        output += pad2(month)
        break
      case 'd':
        output += pad2(day)
        break
      case 'H':
        output += pad2(hours)
        break
      case 'M':
        output += pad2(minutes)
        break
      case 'S':
        output += pad2(seconds)
        break
      case 's':
        output += String(Math.floor(date.getTime() / 1000))
        break
      case 'A':
        output += WEEKDAYS[weekday]
        break
      case 'a':
        output += WEEKDAYS[weekday].slice(0, 3)
        break
      case 'B':
        output += MONTHS[month - 1]
        break
      case 'b':
        output += MONTHS[month - 1].slice(0, 3)
        break
      case 'C':
        output += String(Math.floor(year / 100))
        break
      case 'y':
        output += pad2(year % 100)
        break
      case 'j':
        output += String(dayOfYear).padStart(3, '0')
        break
      case 'e':
        output += String(day).padStart(2, ' ')
        break
      case 'p':
        output += hours < 12 ? 'AM' : 'PM'
        break
      case 'Z':
        output += zone
        break
      case 'z':
        output += `${offsetSign}${pad2(Math.floor(offsetAbsolute / 60))}${pad2(offsetAbsolute % 60)}`
        break
      case 'F':
        output += `${year}-${pad2(month)}-${pad2(day)}`
        break
      case 'T':
        output += `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`
        break
      case 'R':
        output += `${pad2(hours)}:${pad2(minutes)}`
        break
      case 'D':
        output += `${pad2(month)}/${pad2(day)}/${pad2(year % 100)}`
        break
      case 'u':
        output += String(weekday === 0 ? 7 : weekday)
        break
      case 'w':
        output += String(weekday)
        break
      case 'n':
        output += '\n'
        break
      case 't':
        output += '\t'
        break
      case '%':
        output += '%'
        break
      default:
        output += `%${code}`
        break
    }
  }
  return output
}

const dateApplet: Applet = {
  name: 'date',
  summary: '显示时间（+FORMAT 自定义格式、-u UTC、-d @epoch）',
  summaryEn: 'Print or format the current date and time',
  usage: 'date [-u] [-d @EPOCH] [+FORMAT]',
  run: (context) => {
    const parsed = parseArgs(context.argv, { u: 'boolean', U: 'boolean', d: 'value' })
    if (parsed.error) {
      return usageError('date', parsed.error)
    }
    const utc = hasFlag(parsed.flags, 'u') || hasFlag(parsed.flags, 'U')
    const input = stringFlag(parsed.flags, 'd')
    let date = new Date()
    if (input !== undefined) {
      if (input.startsWith('@')) {
        const epoch = Number(input.slice(1))
        if (Number.isNaN(epoch)) {
          return usageError('date', `invalid date '${input}'`, 1)
        }
        date = new Date(epoch * 1000)
      } else {
        const parsedTime = Date.parse(input)
        if (Number.isNaN(parsedTime)) {
          return usageError('date', `invalid date '${input}'`, 1)
        }
        date = new Date(parsedTime)
      }
    }
    const operand = parsed.operands[0]
    if (operand !== undefined && !operand.startsWith('+')) {
      return usageError('date', `invalid date '${operand}'`, 1)
    }
    const format = operand?.slice(1) ?? '%a %b %e %H:%M:%S %Z %Y'
    return ok(`${formatDate(date, format, utc)}\n`)
  },
}

// ---------- uname / hostname / whoami / id ----------

const unameApplet: Applet = {
  name: 'uname',
  summary: '显示系统信息（-a 全部，内核报告为 Linux/wasm32）',
  summaryEn: 'Print system information',
  usage: 'uname [-asnrvmoip]',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      a: 'boolean',
      s: 'boolean',
      n: 'boolean',
      r: 'boolean',
      v: 'boolean',
      m: 'boolean',
      o: 'boolean',
      i: 'boolean',
      p: 'boolean',
    })
    if (parsed.error) {
      return usageError('uname', parsed.error)
    }
    const host = context.env.HOSTNAME ?? 'nanovm'
    const fields: [string, string][] = [
      ['s', 'Linux'],
      ['n', host],
      ['r', APP_VERSION],
      ['v', '#1 SMP NanoVM Slim'],
      ['m', 'wasm32'],
      ['p', 'unknown'],
      ['i', 'wasm32'],
      ['o', 'GNU/Linux'],
    ]
    if (hasFlag(parsed.flags, 'a')) {
      return ok(`${fields.map(([, value]) => value).join(' ')}\n`)
    }
    const selected = fields.filter(([key]) => hasFlag(parsed.flags, key))
    if (selected.length === 0) {
      return ok('Linux\n')
    }
    return ok(`${selected.map(([, value]) => value).join(' ')}\n`)
  },
}

const hostnameApplet: Applet = {
  name: 'hostname',
  summary: '显示主机名（NanoVM 里不能修改）',
  summaryEn: 'Print the host name',
  usage: 'hostname',
  run: (context) => {
    if (context.argv.length > 1) {
      return {
        code: 1,
        stderr: 'hostname: you must be root to change the host name\n',
      }
    }
    return ok(`${context.env.HOSTNAME ?? 'nanovm'}\n`)
  },
}

const whoamiApplet: Applet = {
  name: 'whoami',
  summary: '显示当前用户名（固定为 user）',
  summaryEn: 'Print effective user name',
  usage: 'whoami',
  run: (context) => ok(`${context.env.USER ?? USER}\n`),
}

const idApplet: Applet = {
  name: 'id',
  summary: '显示 uid / gid（-u -g -G）',
  summaryEn: 'Print user and group identity',
  usage: 'id [-ugG]',
  run: (context) => {
    const parsed = parseArgs(context.argv, { u: 'boolean', g: 'boolean', G: 'boolean' })
    if (parsed.error) {
      return usageError('id', parsed.error)
    }
    const name = context.env.USER ?? USER
    if (hasFlag(parsed.flags, 'u')) {
      return ok(`${UID}\n`)
    }
    if (hasFlag(parsed.flags, 'g') || hasFlag(parsed.flags, 'G')) {
      return ok(`${GID}\n`)
    }
    return ok(`uid=${UID}(${name}) gid=${GID}(${GROUP}) groups=${GID}(${GROUP})\n`)
  },
}

// ---------- clear / history / alias / unalias / jobs ----------

const clearApplet: Applet = {
  name: 'clear',
  summary: '清屏（终端自己也会处理 clear）',
  summaryEn: 'Clear the terminal screen',
  usage: 'clear',
  run: () => ok('\u001b[2J\u001b[3J\u001b[H'),
}

const historyApplet: Applet = {
  name: 'history',
  summary: '查看历史记录（历史由终端管理，shell 里不落盘）',
  summaryEn: 'Show history (kept by the terminal, not the shell)',
  usage: 'history',
  run: () =>
    ok(
      'history: 历史记录由终端会话管理（session.ts 保留最近 500 条），NanoVM Slim 不写入历史文件。\n'
    ),
}

const aliasApplet: Applet = {
  name: 'alias',
  summary: '定义别名（存为 ALIAS_<name> 环境变量，由展开器使用）',
  summaryEn: 'Define command aliases',
  usage: "alias [NAME[='VALUE']]...",
  run: (context) => {
    const args = context.argv.slice(1)
    if (args.length === 0) {
      const lines = Object.entries(context.env)
        .filter(([name]) => name.startsWith('ALIAS_'))
        .map(([name, value]) => `alias ${name.slice('ALIAS_'.length)}='${value}'`)
        .sort()
      return ok(lines.length > 0 ? `${lines.join('\n')}\n` : '')
    }
    const lines: string[] = []
    const errors: string[] = []
    for (const arg of args) {
      const equals = arg.indexOf('=')
      if (equals <= 0) {
        const value = context.env[`ALIAS_${arg}`]
        if (value === undefined) {
          errors.push(`alias: ${arg}: not found`)
          continue
        }
        lines.push(`alias ${arg}='${value}'`)
        continue
      }
      const name = arg.slice(0, equals)
      let value = arg.slice(equals + 1)
      if (/^'.*'$/.test(value) || /^".*"$/.test(value)) {
        value = value.slice(1, -1)
      }
      context.setenv(`ALIAS_${name}`, value)
    }
    return {
      code: errors.length > 0 ? 1 : 0,
      stdout: lines.length > 0 ? `${lines.join('\n')}\n` : '',
      stderr: errors.length > 0 ? `${errors.join('\n')}\n` : '',
    }
  },
}

const unaliasApplet: Applet = {
  name: 'unalias',
  summary: '删除别名（-a 删除全部）',
  summaryEn: 'Remove aliases',
  usage: 'unalias [-a] NAME...',
  run: (context) => {
    const args = context.argv.slice(1)
    if (args.length === 0) {
      return usageError('unalias', 'missing operand')
    }
    if (args[0] === '-a' || args[0] === '--all') {
      for (const name of Object.keys(context.env)) {
        if (name.startsWith('ALIAS_')) {
          context.setenv(name, null)
        }
      }
      return ok()
    }
    const errors: string[] = []
    for (const name of args) {
      if (context.env[`ALIAS_${name}`] === undefined) {
        errors.push(`unalias: ${name}: not found`)
        continue
      }
      context.setenv(`ALIAS_${name}`, null)
    }
    if (errors.length > 0) {
      return { code: 1, stderr: `${errors.join('\n')}\n` }
    }
    return ok()
  },
}

const jobsApplet: Applet = {
  name: 'jobs',
  summary: '列出后台任务（NanoVM Slim 不支持作业控制）',
  summaryEn: 'List background jobs (job control unsupported)',
  usage: 'jobs',
  run: () => ok('jobs: NanoVM Slim 不支持作业控制，没有后台任务表（`cmd &` 会转前台执行）。\n'),
}

// ---------- ps / free / uptime / mount ----------

const psApplet: Applet = {
  name: 'ps',
  summary: '列出 NanoVM 里的进程（只有 sh 与当前命令）',
  summaryEn: 'Report a snapshot of processes',
  usage: 'ps [-ef]',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      e: 'boolean',
      f: 'boolean',
      a: 'boolean',
      u: 'boolean',
    })
    if (parsed.error) {
      return usageError('ps', parsed.error)
    }
    const header = `${indent('PID', 5)} ${'USER'.padEnd(8)} ${'STAT'.padEnd(4)} COMMAND`
    const rows = [
      `${indent(String(SHELL_PID), 5)} ${'user'.padEnd(8)} ${'Ss'.padEnd(4)} sh`,
      `${indent(String(SHELL_PID + 1), 5)} ${'user'.padEnd(8)} ${'R+'.padEnd(4)} ${context.argv[0]}`,
    ]
    return ok(`${header}\n${rows.join('\n')}\n`)
  },
}

const freeApplet: Applet = {
  name: 'free',
  summary: '显示 WASM 线性内存用量',
  summaryEn: 'Display WASM linear memory usage',
  usage: 'free [-h]',
  run: (context) => {
    const parsed = parseArgs(context.argv, {
      h: 'boolean',
      b: 'boolean',
      k: 'boolean',
      m: 'boolean',
    })
    if (parsed.error) {
      return usageError('free', parsed.error)
    }
    const stats = context.memory()
    const total = stats.totalMB * 1024 * 1024
    const used = stats.usedBytes
    const available = Math.max(0, total - used)
    const human = hasFlag(parsed.flags, 'h')
    const unit = hasFlag(parsed.flags, 'b') ? 1 : hasFlag(parsed.flags, 'm') ? 1024 * 1024 : 1024
    const scale = (bytes: number): string =>
      human ? humanSize(bytes) : String(Math.round(bytes / unit))
    const header = `${''.padEnd(7)}${indent('total', 10)}${indent('used', 12)}${indent('free', 12)}${indent('shared', 12)}${indent('buff/cache', 12)}${indent('available', 12)}`
    const row = `Mem:   ${[total, used, available, 0, 0, available]
      .map((cell) => indent(scale(cell), 11))
      .join(' ')}`
    const swap = `Swap:  ${[0, 0, 0].map((cell) => indent(scale(cell), 11)).join(' ')}`
    return ok(`${header}\n${row}\n${swap}\n`)
  },
}

const uptimeApplet: Applet = {
  name: 'uptime',
  summary: '显示 NanoVM 运行时长与时间',
  summaryEn: 'Show how long NanoVM has been running',
  usage: 'uptime',
  run: () => {
    const seconds = Math.max(0, Math.floor((Date.now() - loadedAt) / 1000))
    const days = Math.floor(seconds / 86_400)
    const hours = Math.floor((seconds % 86_400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const parts: string[] = []
    if (days > 0) {
      parts.push(`${days} day${days === 1 ? '' : 's'}`)
    }
    if (hours > 0 || days > 0) {
      parts.push(`${hours} hr${hours === 1 ? '' : 's'}`)
    }
    parts.push(`${minutes} min${minutes === 1 ? '' : 's'}`)
    const now = new Date()
    const clock = `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`
    return ok(` ${clock} up ${parts.join(', ')},  1 user,  load average: 0.00, 0.00, 0.00\n`)
  },
}

const mountApplet: Applet = {
  name: 'mount',
  summary: '列出虚拟挂载点',
  summaryEn: 'List virtual mounts',
  usage: 'mount',
  run: (context) => {
    const limits = context.fs.getLimits()
    const usage = context.fs.usage()
    const lines = [
      `nanovm on / type nanofs (rw,size=${limits.diskMB}M,used=${humanSize(usage.bytes)},files=${usage.files})`,
      'proc on /proc type proc (ro,noexec)',
      'dev on /dev type devfs (rw,nosuid)',
      'none on /tmp type tmpfs (rw,size=16M)',
    ]
    return ok(`${lines.join('\n')}\n`)
  },
}

/** 文件与系统类命令，顺序就是 `help` 里的展示顺序 */
export const CORE_APPLETS: Applet[] = [
  pwdApplet,
  cdApplet,
  lsApplet,
  catApplet,
  echoApplet,
  printfApplet,
  mkdirApplet,
  rmdirApplet,
  rmApplet,
  cpApplet,
  mvApplet,
  touchApplet,
  lnApplet,
  statApplet,
  chmodApplet,
  duApplet,
  dfApplet,
  envApplet,
  exportApplet,
  unsetApplet,
  setApplet,
  whichApplet,
  typeApplet,
  trueApplet,
  falseApplet,
  testApplet,
  bracketApplet,
  seqApplet,
  yesApplet,
  sleepApplet,
  dateApplet,
  unameApplet,
  hostnameApplet,
  whoamiApplet,
  idApplet,
  clearApplet,
  historyApplet,
  aliasApplet,
  unaliasApplet,
  jobsApplet,
  psApplet,
  freeApplet,
  uptimeApplet,
  mountApplet,
]
