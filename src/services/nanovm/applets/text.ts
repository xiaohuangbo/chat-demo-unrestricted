import type { Applet, AppletContext, AppletResult } from '../types.js'
import { ERRNO_TEXT, VmError } from '../types.js'
import { baseName, normalizePath, resolvePath } from '../fs.js'
import type { ParsedArgs } from './helpers.js'
import {
  fail,
  interrupted,
  joinLines,
  ok,
  parseArgs,
  readInputBytes,
  sliceCount,
  splitLines,
} from './helpers.js'

/**
 * 文本处理类命令（grep / sed / awk / sort / uniq / cut / head / tail / wc / ...）。
 *
 * 目标是「贴近 GNU/busybox，但不装作全都能做」：不支持的选项一律报错，
 * 语法子集之外的 awk / sed 脚本返回 syntax error，而不是给出看起来对的错结果。
 * 所有读取都走 helpers 里的 readInputBytes（`-` 表示标准输入），
 * 输出统一带结尾换行（joinLines），长循环里检查 interrupted。
 */

const DECODER = new TextDecoder()
const ENCODER = new TextEncoder()

/** 超时 / Ctrl+C 的统一返回码 */
const ABORTED: AppletResult = { code: 130 }

// ---------- 参数与错误 ----------

/** 布尔选项是否出现 */
const flagOn = (flags: ParsedArgs['flags'], name: string): boolean => flags[name] === true

/** 取带值选项；没给返回 null */
const flagText = (flags: ParsedArgs['flags'], name: string): string | null => {
  const value = flags[name]
  return typeof value === 'string' ? value : null
}

/** 用法错误：退出码 2，GNU 的 usage error */
const usageError = (command: string, message: string): AppletResult =>
  fail(`${command}: ${message}\n`, 2)

/** 运行期错误：默认退出码 1 */
const runtimeError = (command: string, message: string, code = 1): AppletResult =>
  fail(`${command}: ${message}\n`, code)

/** 把 catch 到的异常翻译成人读的原因 */
const reasonOf = (error: unknown): string => {
  if (error instanceof VmError) {
    return ERRNO_TEXT[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** 解析整数字符串，失败返回 null */
const parseInteger = (text: string): number | null => {
  if (!/^[+-]?\d+$/.test(text.trim())) {
    return null
  }
  return Number.parseInt(text.trim(), 10)
}

/** 读一个输入源：`-` 表示标准输入 */
const readSource = (ctx: AppletContext, operand: string): string =>
  operand === '-' ? ctx.stdin : DECODER.decode(readInputBytes(ctx, operand))

/** 读多个输入源并按顺序拼接，出错的文件记一条错误后跳过 */
const gatherLines = (
  ctx: AppletContext,
  operands: string[],
  command: string
): { lines: string[]; errors: string } => {
  const lines: string[] = []
  let errors = ''
  const sources = operands.length > 0 ? operands : ['-']
  for (const operand of sources) {
    try {
      lines.push(...splitLines(DECODER.decode(readInputBytes(ctx, operand))))
    } catch (error) {
      errors += `${command}: ${operand}: ${reasonOf(error)}\n`
    }
  }
  return { lines, errors }
}

/**
 * 取路径的 stat。fs 的根目录是隐式的（mountDefaults 不建 '/' 节点），
 * 所以 stat('/') 是 null；递归类命令这里补一个「根是目录」的兜底。
 */
const statEntry = (ctx: AppletContext, absolute: string): { kind: 'file' | 'dir' } | null => {
  const entry = ctx.fs.stat(absolute)
  if (entry) {
    return entry
  }
  return absolute === '/' ? { kind: 'dir' } : null
}

/** 把 shell 参数转成命令行的安全写法 */
const quoteWord = (word: string): string => {
  if (word === '') {
    return "''"
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) {
    return word
  }
  return `'${word.replace(/'/g, "'\\''")}'`
}

// ---------- 正则小工具 ----------

/** 转义成字面量正则（grep -F / awk 的 ~ 用不到） */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** BRE（POSIX 基本正则）转 JS 正则：\( \) \{ \} \| \+ \? 在 BRE 里是元字符，裸写反而是字面量 */
const breToEre = (pattern: string): string => {
  const meta = new Set(['+', '?', '(', ')', '{', '}', '|'])
  let out = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '\\') {
      const next = pattern[index + 1]
      if (next === undefined) {
        out += '\\\\'
        continue
      }
      index += 1
      if (meta.has(next)) {
        out += next
        continue
      }
      out += `\\${next}`
      continue
    }
    if (meta.has(char)) {
      out += `\\${char}`
      continue
    }
    out += char
  }
  return out
}

// ---------- head / tail ----------

const HEAD_TAIL_SPEC = { n: 'value', c: 'value', q: 'boolean', v: 'boolean' } as const

/** 按行取头：count 为负表示「去掉末尾 |count| 行」 */
const takeHeadLines = (lines: string[], count: number): string[] =>
  count >= 0 ? sliceCount(lines, count, false) : lines.slice(0, Math.max(0, lines.length + count))

/** 按行取尾：负数与 GNU 一致，等价于最后 |count| 行 */
const takeTailLines = (lines: string[], count: number, fromStart: boolean): string[] => {
  if (fromStart) {
    return lines.slice(Math.max(0, count - 1))
  }
  return count >= 0 ? sliceCount(lines, count, true) : sliceCount(lines, -count, true)
}

/** 按字节取头 / 尾 */
const takeBytes = (text: string, count: number, fromEnd: boolean, fromStart: boolean): string => {
  const data = ENCODER.encode(text)
  if (fromStart) {
    return DECODER.decode(data.subarray(Math.min(Math.max(0, count - 1), data.length)))
  }
  const amount = Math.abs(count)
  if (fromEnd) {
    return DECODER.decode(data.subarray(Math.max(0, data.length - amount)))
  }
  // head：负数是「去掉末尾 |count| 字节」
  const end = count >= 0 ? Math.min(amount, data.length) : Math.max(0, data.length - amount)
  return DECODER.decode(data.subarray(0, end))
}

const headTail = (kind: 'head' | 'tail', ctx: AppletContext): AppletResult => {
  // busybox / coreutils 都支持 `head -5` 这种老式写法，先把它换成 -n 5 再解析
  const argv = [...ctx.argv]
  const shorthand = /^-(\d+)$/.exec(argv[1] ?? '')
  if (shorthand) {
    argv.splice(1, 1, '-n', shorthand[1])
  }
  const parsed = parseArgs(argv, HEAD_TAIL_SPEC)
  if (parsed.error) {
    return usageError(kind, parsed.error)
  }
  const bytesFlag = flagText(parsed.flags, 'c')
  const linesFlag = flagText(parsed.flags, 'n')
  let byteCount: number | null = null
  let lineCount: number | null = null
  let fromStart = false
  if (bytesFlag !== null) {
    fromStart = bytesFlag.trim().startsWith('+')
    byteCount = parseInteger(bytesFlag)
    if (byteCount === null) {
      return runtimeError(kind, `invalid number of bytes: '${bytesFlag}'`)
    }
  } else if (linesFlag !== null) {
    fromStart = linesFlag.trim().startsWith('+')
    lineCount = parseInteger(linesFlag)
    if (lineCount === null) {
      return runtimeError(kind, `invalid number of lines: '${linesFlag}'`)
    }
  } else {
    lineCount = 10
  }
  const operands = parsed.operands.length > 0 ? parsed.operands : ['-']
  let showHeader = operands.length > 1
  if (flagOn(parsed.flags, 'q')) {
    showHeader = false
  }
  if (flagOn(parsed.flags, 'v')) {
    showHeader = true
  }
  let stdout = ''
  let errors = ''
  let printed = 0
  for (const operand of operands) {
    let text: string
    try {
      text = readSource(ctx, operand)
    } catch (error) {
      errors += `${kind}: cannot open '${operand}' for reading: ${reasonOf(error)}\n`
      continue
    }
    if (showHeader) {
      if (printed > 0) {
        stdout += '\n'
      }
      stdout += `==> ${operand === '-' ? 'standard input' : operand} <==\n`
    }
    printed += 1
    if (byteCount !== null) {
      // tail -c +N 从第 N 个字节开始，head 没有这个语义
      if (kind === 'tail' && fromStart) {
        const data = ENCODER.encode(text)
        stdout += DECODER.decode(data.subarray(Math.max(0, byteCount - 1)))
      } else {
        stdout += takeBytes(text, byteCount, kind === 'tail', fromStart)
      }
      continue
    }
    const count = lineCount ?? 10
    const lines = splitLines(text)
    stdout += joinLines(
      kind === 'head' ? takeHeadLines(lines, count) : takeTailLines(lines, count, fromStart)
    )
  }
  return { code: errors ? 1 : 0, stdout, stderr: errors }
}

const headApplet: Applet = {
  name: 'head',
  summary: '显示文件开头若干行或字节',
  summaryEn: 'Print the first lines or bytes of each file',
  usage: 'head [-n N|-N] [-c N] [-q] [-v] [file...]',
  run: (ctx: AppletContext): AppletResult => headTail('head', ctx),
}

const tailApplet: Applet = {
  name: 'tail',
  summary: '显示文件末尾若干行或字节，支持 -n +N',
  summaryEn: 'Print the last lines or bytes of each file',
  usage: 'tail [-n N|-N] [-n +N] [-c N] [-q] [-v] [file...]',
  run: (ctx: AppletContext): AppletResult => headTail('tail', ctx),
}

// ---------- grep ----------

type GrepTarget = { label: string; text: string }

/** 上下文行数：-B 命中行之前、-A 命中行之后 */
type GrepContext = { before: number; after: number }

type GrepOptions = {
  matcher: RegExp
  globalMatcher: RegExp | null
  invert: boolean
  showLineNumber: boolean
  onlyMatching: boolean
  withPath: boolean
  collect: boolean
  /** -l / -q 拿到第一个命中就够，不必继续扫 */
  earlyExit: boolean
  /** -A / -B / -C 的上下文行数；-c / -l / -q 忽略，-o 只输出命中片段（不插 --） */
  context: GrepContext
}

/** 一个文件里的扫描结果 */
type GrepScan = { lines: string[]; count: number; matched: boolean; aborted: boolean }

/**
 * 一行的完整输出。文件名与行号后面跟的分隔符：命中行是 `:`，上下文行是 `-`
 * （例如 `file.txt:3:hit`、`file.txt-4-context`）。
 * GNU 只在这两段前缀真的输出时才带分隔符，所以 stdin 又没给 -n 时上下文行是裸的。
 */
const grepLineText = (
  label: string,
  index: number,
  text: string,
  separator: ':' | '-',
  options: GrepOptions
): string => {
  let prefix = ''
  if (options.withPath) {
    prefix += `${label}${separator}`
  }
  if (options.showLineNumber) {
    prefix += `${index + 1}${separator}`
  }
  return `${prefix}${text}`
}

/** 逐行扫描：返回格式化后的输出行与命中计数 */
const scanGrepText = (
  text: string,
  label: string,
  options: GrepOptions,
  ctx: AppletContext
): GrepScan => {
  const lines: string[] = []
  let count = 0
  let matched = false
  let aborted = false
  const input = splitLines(text)
  // 先把命中集合整段标出来：上下文要按命中行前后扩展，-c 也要数完所有行
  const selected = new Array<boolean>(input.length).fill(false)
  for (let index = 0; index < input.length; index += 1) {
    if ((index & 0xff) === 0 && interrupted(ctx)) {
      aborted = true
      break
    }
    options.matcher.lastIndex = 0
    const hit = options.matcher.test(input[index])
    const picked = options.invert ? !hit : hit
    selected[index] = picked
    if (!picked) {
      continue
    }
    matched = true
    // -c 数的一直是「选中的行数」，即使配了 -o 也跟 GNU 一致
    count += 1
    if (options.earlyExit) {
      break
    }
  }
  if (aborted || !options.collect) {
    return { lines, count, matched, aborted }
  }
  // -o 只输出匹配片段，上下文与它互斥（GNU 同样不输出上下文行，但仍会插 --，这里省略）
  const before = options.context.before
  const after = options.context.after
  // 取反 (-v) 时上下文按「取反后的命中集合」前后扩展，而不是按原始模式匹配的位置：
  // 这是简化模型，和 GNU「先标记选中行、再按选中行取上下文」的做法等价。
  const useContext = !options.onlyMatching && (before > 0 || after > 0)
  if (useContext) {
    let blockStart = -1
    let blockEnd = -1
    let emitted = false
    /**
     * 输出 [start, end] 这一段；同一文件内块与块之间插一行 `--`。
     * 跨文件不插：调用方对每个文件单独扫描，GNU 实测跨文件也会插，这里有意只在文件内分隔。
     */
    const emitBlock = (start: number, end: number): boolean => {
      if (emitted) {
        lines.push('--')
      }
      for (let index = start; index <= end; index += 1) {
        if ((index & 0xff) === 0 && interrupted(ctx)) {
          aborted = true
          return false
        }
        const separator = selected[index] ? ':' : '-'
        lines.push(grepLineText(label, index, input[index], separator, options))
      }
      emitted = true
      return true
    }
    for (let index = 0; index < input.length; index += 1) {
      if (!selected[index]) {
        continue
      }
      const start = Math.max(0, index - before)
      const end = Math.min(input.length - 1, index + after)
      if (blockStart < 0) {
        blockStart = start
        blockEnd = end
        continue
      }
      // 重叠或首尾相接的块合并；中间隔了至少一行才输出 `--`
      if (start <= blockEnd + 1) {
        blockEnd = Math.max(blockEnd, end)
        continue
      }
      if (!emitBlock(blockStart, blockEnd)) {
        return { lines, count, matched, aborted }
      }
      blockStart = start
      blockEnd = end
    }
    if (blockStart >= 0 && !emitBlock(blockStart, blockEnd)) {
      return { lines, count, matched, aborted }
    }
    return { lines, count, matched, aborted }
  }
  for (let index = 0; index < input.length; index += 1) {
    if (!selected[index]) {
      continue
    }
    if ((index & 0xff) === 0 && interrupted(ctx)) {
      aborted = true
      break
    }
    if (options.onlyMatching && options.globalMatcher) {
      for (const item of collectRegexMatches(options.globalMatcher, input[index])) {
        lines.push(grepLineText(label, index, item, ':', options))
      }
    } else {
      lines.push(grepLineText(label, index, input[index], ':', options))
    }
  }
  return { lines, count, matched, aborted }
}

/** 收集一行里的全部匹配（-o），跳过空匹配防止死循环 */
const collectRegexMatches = (matcher: RegExp, line: string): string[] => {
  const found: string[] = []
  matcher.lastIndex = 0
  let match = matcher.exec(line)
  while (match !== null) {
    if (match[0] === '') {
      matcher.lastIndex += 1
      if (matcher.lastIndex > line.length) {
        break
      }
    } else {
      found.push(match[0])
      if (found.length >= 10_000) {
        break
      }
    }
    match = matcher.exec(line)
  }
  return found
}

/**
 * 读 -A / -B / -C 的行数：没给返回 null（好让 -C 的默认值被单独给出的 -A/-B 覆盖），
 * 非数字或负数按 GNU 的用法错误处理。
 */
const readContextCount = (
  command: string,
  flags: ParsedArgs['flags'],
  name: string
): { count: number | null } | { error: AppletResult } => {
  const text = flagText(flags, name)
  if (text === null) {
    return { count: null }
  }
  const count = parseInteger(text)
  if (count === null || count < 0) {
    return { error: usageError(command, `${text}: invalid context length argument`) }
  }
  return { count }
}

const runGrep = (ctx: AppletContext): AppletResult => {
  const parsed = parseArgs(ctx.argv, {
    i: 'boolean',
    v: 'boolean',
    n: 'boolean',
    c: 'boolean',
    l: 'boolean',
    w: 'boolean',
    E: 'boolean',
    F: 'boolean',
    r: 'boolean',
    R: 'boolean',
    q: 'boolean',
    o: 'boolean',
    h: 'boolean',
    H: 'boolean',
    s: 'boolean',
    e: 'value',
    A: 'value',
    B: 'value',
    C: 'value',
  })
  if (parsed.error) {
    return usageError('grep', parsed.error)
  }
  const flags = parsed.flags
  // -C 同时设置前后距离，单独给出的 -A / -B 优先（-A0 这种显式 0 也算）
  const sharedContext = readContextCount('grep', flags, 'C')
  if ('error' in sharedContext) {
    return sharedContext.error
  }
  const afterContext = readContextCount('grep', flags, 'A')
  if ('error' in afterContext) {
    return afterContext.error
  }
  const beforeContext = readContextCount('grep', flags, 'B')
  if ('error' in beforeContext) {
    return beforeContext.error
  }
  const context: GrepContext = {
    before: beforeContext.count ?? sharedContext.count ?? 0,
    after: afterContext.count ?? sharedContext.count ?? 0,
  }
  let pattern = flagText(flags, 'e')
  let operands = parsed.operands
  if (pattern === null) {
    if (operands.length === 0) {
      return usageError('grep', 'usage: grep [OPTION]... PATTERN [FILE]...')
    }
    pattern = operands[0]
    operands = operands.slice(1)
  }
  const recursive = flagOn(flags, 'r') || flagOn(flags, 'R')
  if (operands.length === 0) {
    operands = recursive ? ['.'] : ['-']
  }
  const quietErrors = flagOn(flags, 's')
  // 编译模式：-F 字面量、-E 扩展正则、默认按 BRE 转换成 JS 正则
  let source = flagOn(flags, 'F')
    ? escapeRegExp(pattern)
    : flagOn(flags, 'E')
      ? pattern
      : breToEre(pattern)
  if (flagOn(flags, 'w')) {
    source = `(?:^|(?<=[^0-9A-Za-z_]))(?:${source})(?=$|[^0-9A-Za-z_])`
  }
  const caseFlags = flagOn(flags, 'i') ? 'i' : ''
  let matcher: RegExp
  let globalMatcher: RegExp | null = null
  try {
    matcher = new RegExp(source, caseFlags)
    if (flagOn(flags, 'o')) {
      globalMatcher = new RegExp(source, `${caseFlags}g`)
    }
  } catch {
    return runtimeError('grep', 'invalid regular expression', 2)
  }

  // 收集待搜索的源：文件、标准输入、递归目录
  const targets: GrepTarget[] = []
  let errors = ''
  const pushError = (message: string) => {
    errors += message
  }
  const loadFile = (absolute: string, label: string): void => {
    let bytes: Uint8Array | null
    try {
      bytes = ctx.fs.read(absolute)
    } catch (error) {
      pushError(`grep: ${label}: ${reasonOf(error)}\n`)
      return
    }
    if (!bytes) {
      pushError(`grep: ${label}: ${ERRNO_TEXT.ENOENT}\n`)
      return
    }
    // 含 \0 的文件按二进制处理，直接跳过
    if (bytes.includes(0)) {
      return
    }
    targets.push({ label, text: DECODER.decode(bytes) })
  }
  for (const operand of operands) {
    if (operand === '-') {
      targets.push({ label: '(standard input)', text: ctx.stdin })
      continue
    }
    const absolute = resolvePath(ctx.cwd, operand)
    const entry = statEntry(ctx, absolute)
    if (!entry) {
      pushError(`grep: ${operand}: ${ERRNO_TEXT.ENOENT}\n`)
      continue
    }
    if (entry.kind !== 'dir') {
      loadFile(absolute, operand)
      continue
    }
    if (!recursive) {
      pushError(`grep: ${operand}: ${ERRNO_TEXT.EISDIR}\n`)
      continue
    }
    const root = normalizePath(operand)
    const display = operand === '/' ? '/' : operand.replace(/\/+$/, '')
    for (const child of ctx.fs.walk(absolute)) {
      if (child.kind !== 'file') {
        continue
      }
      const relative = root === '/' ? child.path : child.path.slice(root.length)
      // 从 / 开始递归时别拼出 //etc/motd 这种双斜杠
      loadFile(child.path, display === '/' ? child.path : `${display}${relative}`)
    }
  }

  const listOnly = flagOn(flags, 'l')
  const countOnly = flagOn(flags, 'c')
  const quiet = flagOn(flags, 'q')
  let withPath = targets.length > 1 || recursive
  if (flagOn(flags, 'h')) {
    withPath = false
  }
  if (flagOn(flags, 'H')) {
    withPath = true
  }
  const options: GrepOptions = {
    matcher,
    globalMatcher,
    invert: flagOn(flags, 'v'),
    showLineNumber: flagOn(flags, 'n'),
    onlyMatching: flagOn(flags, 'o'),
    withPath,
    collect: !listOnly && !countOnly && !quiet,
    earlyExit: listOnly || quiet,
    context,
  }
  const output: string[] = []
  const counters: string[] = []
  let anyMatch = false
  for (const target of targets) {
    const scan = scanGrepText(target.text, target.label, options, ctx)
    if (scan.aborted) {
      return ABORTED
    }
    if (quiet) {
      if (scan.matched) {
        return { code: 0 }
      }
      continue
    }
    if (listOnly) {
      if (scan.matched) {
        output.push(target.label)
      }
    } else if (countOnly) {
      counters.push(withPath ? `${target.label}:${scan.count}` : String(scan.count))
    } else {
      output.push(...scan.lines)
    }
    if (scan.matched) {
      anyMatch = true
    }
  }
  const stderr = quietErrors ? '' : errors
  const code = errors ? 2 : anyMatch ? 0 : 1
  return { code, stdout: joinLines([...output, ...counters]), stderr }
}

const grepApplet: Applet = {
  name: 'grep',
  summary: '按正则或字面量搜索文本，支持递归、多文件与上下文行',
  summaryEn: 'Search text with regular expressions, with -A/-B/-C context lines',
  usage:
    'grep [-i] [-v] [-n] [-c] [-l] [-w] [-E|-F] [-r] [-q] [-o] [-h] [-H] [-s] [-A N] [-B N] [-C N] [-e PATTERN] PATTERN [file...]',
  run: (ctx: AppletContext): AppletResult => runGrep(ctx),
}

// ---------- sed ----------

type SedAddress =
  | { kind: 'line'; line: number }
  | { kind: 'last' }
  | { kind: 'regex'; regex: RegExp }

type SedCommand = {
  /** s / p / d / q / = */
  kind: 's' | 'p' | 'd' | 'q' | '='
  address: SedAddress | null
  addressEnd: SedAddress | null
  negate: boolean
  /** s 命令的正则 */
  pattern: RegExp | null
  /** s 命令的替换串（已转成 JS 替换语法） */
  replacement: string
  global: boolean
  printResult: boolean
}

/** sed 替换串 → JS 替换串：& 是整体匹配、\1 是分组、$ 要转义 */
const sedReplacementToJs = (raw: string): string => {
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index]
    if (char === '\\') {
      const next = raw[index + 1]
      if (next === undefined) {
        out += '\\\\'
        continue
      }
      index += 1
      if (next >= '1' && next <= '9') {
        out += `$${next}`
        continue
      }
      if (next === '&') {
        out += '&'
        continue
      }
      if (next === '$') {
        out += '$$'
        continue
      }
      if (next === 'n') {
        out += '\n'
        continue
      }
      if (next === 't') {
        out += '\t'
        continue
      }
      out += next
      continue
    }
    if (char === '&') {
      out += '$&'
      continue
    }
    if (char === '$') {
      out += '$$'
      continue
    }
    out += char
  }
  return out
}

/** 解析 sed 脚本；做不到的语法直接抛 VmError，由调用方转成 sed: syntax error */
const parseSedScript = (script: string, extended: boolean): SedCommand[] => {
  const commands: SedCommand[] = []
  const length = script.length
  let index = 0
  const isBlank = (char: string): boolean => char === ' ' || char === '\t'
  const skipBlanks = (): void => {
    while (index < length && isBlank(script[index])) {
      index += 1
    }
  }
  const skipSeparators = (): void => {
    while (index < length) {
      const char = script[index]
      if (char === ';' || char === '\n' || char === ' ' || char === '\t') {
        index += 1
        continue
      }
      return
    }
  }
  /** 读到未转义的 delimiter 为止；\<delimiter> 还原成字面量 */
  const readDelimited = (delimiter: string, label: string): string => {
    let text = ''
    while (index < length) {
      const char = script[index]
      if (char === '\\') {
        const next = script[index + 1]
        if (next === undefined) {
          throw new VmError('EINVAL', `unterminated ${label}`)
        }
        if (next === delimiter) {
          text += next
          index += 2
          continue
        }
        text += `\\${next}`
        index += 2
        continue
      }
      if (char === delimiter) {
        index += 1
        return text
      }
      text += char
      index += 1
    }
    throw new VmError('EINVAL', `unterminated ${label}`)
  }
  const readAddress = (): SedAddress | null => {
    skipBlanks()
    if (index >= length) {
      return null
    }
    const char = script[index]
    if (char === '$') {
      index += 1
      return { kind: 'last' }
    }
    if (char === '/') {
      index += 1
      const raw = readDelimited('/', 'address regex')
      try {
        return { kind: 'regex', regex: new RegExp(extended ? raw : breToEre(raw)) }
      } catch {
        throw new VmError('EINVAL', 'invalid regular expression')
      }
    }
    if (char >= '0' && char <= '9') {
      let digits = ''
      while (index < length && script[index] >= '0' && script[index] <= '9') {
        digits += script[index]
        index += 1
      }
      return { kind: 'line', line: Number(digits) }
    }
    return null
  }

  while (index < length) {
    skipSeparators()
    if (index >= length) {
      break
    }
    if (script[index] === '#') {
      while (index < length && script[index] !== '\n') {
        index += 1
      }
      continue
    }
    const address = readAddress()
    let addressEnd: SedAddress | null = null
    if (address !== null) {
      skipBlanks()
      if (script[index] === ',') {
        index += 1
        addressEnd = readAddress()
        if (addressEnd === null) {
          throw new VmError('EINVAL', 'missing address after comma')
        }
      }
    }
    let negate = false
    skipBlanks()
    while (script[index] === '!') {
      negate = !negate
      index += 1
      skipBlanks()
    }
    if (index >= length) {
      throw new VmError('EINVAL', 'missing command')
    }
    const kind = script[index]
    if (kind === 's') {
      index += 1
      const delimiter = script[index]
      if (delimiter === undefined || delimiter === '\\' || delimiter === '\n') {
        throw new VmError('EINVAL', "unterminated 's' command")
      }
      index += 1
      const rawPattern = readDelimited(delimiter, "'s' command")
      const rawReplacement = readDelimited(delimiter, "'s' command")
      let global = false
      let printResult = false
      let ignoreCase = false
      while (index < length) {
        const flag = script[index]
        if (flag === 'g') {
          global = true
          index += 1
          continue
        }
        if (flag === 'p') {
          printResult = true
          index += 1
          continue
        }
        if (flag === 'i' || flag === 'I') {
          ignoreCase = true
          index += 1
          continue
        }
        if (flag === ';' || flag === '\n' || flag === ' ' || flag === '\t') {
          break
        }
        throw new VmError('EINVAL', "unknown option to 's'")
      }
      let pattern: RegExp
      try {
        pattern = new RegExp(
          extended ? rawPattern : breToEre(rawPattern),
          `${global ? 'g' : ''}${ignoreCase ? 'i' : ''}`
        )
      } catch {
        throw new VmError('EINVAL', 'invalid regular expression')
      }
      commands.push({
        kind: 's',
        address,
        addressEnd,
        negate,
        pattern,
        replacement: sedReplacementToJs(rawReplacement),
        global,
        printResult,
      })
      continue
    }
    if (kind === 'p' || kind === 'd' || kind === 'q' || kind === '=') {
      index += 1
      commands.push({
        kind,
        address,
        addressEnd,
        negate,
        pattern: null,
        replacement: '',
        global: false,
        printResult: false,
      })
      continue
    }
    if (kind === '{' || kind === '}') {
      throw new VmError('EINVAL', 'address blocks are not supported')
    }
    throw new VmError('EINVAL', `unknown command: '${kind}'`)
  }
  return commands
}

/** 单地址匹配 */
const matchSedAddress = (
  address: SedAddress,
  lineNo: number,
  line: string,
  isLast: boolean
): boolean => {
  if (address.kind === 'line') {
    return address.line === lineNo
  }
  if (address.kind === 'last') {
    return isLast
  }
  address.regex.lastIndex = 0
  return address.regex.test(line)
}

/** 范围终点是否在这一行（行号地址按 >= 处理，跟 GNU 一致） */
const matchSedEnd = (
  address: SedAddress,
  lineNo: number,
  line: string,
  isLast: boolean
): boolean => {
  if (address.kind === 'line') {
    return lineNo >= address.line
  }
  return matchSedAddress(address, lineNo, line, isLast)
}

/** 判断某条命令在当前行是否生效（含范围状态） */
const sedAddressMatches = (
  command: SedCommand,
  commandIndex: number,
  lineNo: number,
  line: string,
  isLast: boolean,
  ranges: boolean[]
): boolean => {
  const { address, addressEnd } = command
  if (address === null) {
    return true
  }
  if (addressEnd === null) {
    return matchSedAddress(address, lineNo, line, isLast)
  }
  if (address.kind === 'line' && addressEnd.kind === 'line') {
    return lineNo >= address.line && lineNo <= addressEnd.line
  }
  if (ranges[commandIndex]) {
    if (matchSedEnd(addressEnd, lineNo, line, isLast)) {
      ranges[commandIndex] = false
    }
    return true
  }
  if (!matchSedAddress(address, lineNo, line, isLast)) {
    return false
  }
  ranges[commandIndex] = true
  if (matchSedEnd(addressEnd, lineNo, line, isLast)) {
    ranges[commandIndex] = false
  }
  return true
}

/** 执行 sed 命令列表，返回输出行 */
const applySedCommands = (
  lines: string[],
  commands: SedCommand[],
  autoPrint: boolean,
  ctx: AppletContext
): { lines: string[]; aborted: boolean } => {
  const output: string[] = []
  const ranges = commands.map(() => false)
  for (let index = 0; index < lines.length; index += 1) {
    if ((index & 0xff) === 0 && interrupted(ctx)) {
      return { lines: output, aborted: true }
    }
    const isLast = index === lines.length - 1
    const lineNo = index + 1
    let line = lines[index]
    let deleted = false
    let quitting = false
    for (let commandIndex = 0; commandIndex < commands.length; commandIndex += 1) {
      const command = commands[commandIndex]
      const active = sedAddressMatches(command, commandIndex, lineNo, line, isLast, ranges)
      if (active === command.negate) {
        continue
      }
      if (command.kind === 'p') {
        output.push(line)
        continue
      }
      if (command.kind === '=') {
        output.push(String(lineNo))
        continue
      }
      if (command.kind === 'd') {
        deleted = true
        break
      }
      if (command.kind === 'q') {
        quitting = true
        break
      }
      if (command.pattern === null) {
        continue
      }
      command.pattern.lastIndex = 0
      const before = line
      line = line.replace(command.pattern, command.replacement)
      if (command.printResult && line !== before) {
        output.push(line)
      }
    }
    if (!deleted && autoPrint) {
      output.push(line)
    }
    if (quitting) {
      break
    }
  }
  return { lines: output, aborted: false }
}

/** 把 sed 的 -e 脚本与 -i 就地写回从 argv 里剥出来（parseArgs 不支持重复 -e 与后缀） */
const splitSedArgs = (
  argv: string[]
): { args: string[]; scripts: string[]; inPlace: boolean; suffix: string; error?: string } => {
  const args: string[] = [argv[0]]
  const scripts: string[] = []
  let inPlace = false
  let suffix = ''
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--') {
      args.push(...argv.slice(index))
      break
    }
    if (arg === '-e' || arg === '--expression') {
      const value = argv[index + 1]
      if (value === undefined) {
        return { args, scripts, inPlace, suffix, error: "option requires an argument -- 'e'" }
      }
      scripts.push(value)
      index += 1
      continue
    }
    if (!arg.startsWith('--') && arg.startsWith('-e') && arg.length > 2) {
      scripts.push(arg.slice(2))
      continue
    }
    if (arg.startsWith('--expression=')) {
      scripts.push(arg.slice('--expression='.length))
      continue
    }
    if (arg === '-i') {
      inPlace = true
      continue
    }
    if (/^-i\..*$/.test(arg)) {
      inPlace = true
      suffix = arg.slice(2)
      continue
    }
    const cluster = /^-([a-zA-Z][a-zA-Z.]*)$/.exec(arg)
    if (cluster) {
      const body = cluster[1]
      const position = body.indexOf('i')
      if (position >= 0) {
        inPlace = true
        const rest = body.slice(position + 1)
        const kept = `${body.slice(0, position)}${rest.startsWith('.') ? '' : rest}`
        if (rest.startsWith('.')) {
          suffix = rest
        }
        if (kept !== '') {
          args.push(`-${kept}`)
        }
        continue
      }
    }
    args.push(arg)
  }
  return { args, scripts, inPlace, suffix }
}

const runSed = (ctx: AppletContext): AppletResult => {
  const split = splitSedArgs(ctx.argv)
  if (split.error) {
    return usageError('sed', split.error)
  }
  const parsed = parseArgs(split.args, { n: 'boolean', E: 'boolean' })
  if (parsed.error) {
    return usageError('sed', parsed.error)
  }
  const extended = flagOn(parsed.flags, 'E')
  const scripts = [...split.scripts]
  const operands = parsed.operands
  if (scripts.length === 0) {
    if (operands.length === 0) {
      return usageError('sed', 'no script specified')
    }
    scripts.push(operands.shift() ?? '')
  }
  const autoPrint = !flagOn(parsed.flags, 'n')
  const commands: SedCommand[] = []
  for (const script of scripts) {
    try {
      commands.push(...parseSedScript(script, extended))
    } catch (error) {
      if (error instanceof VmError) {
        return runtimeError('sed', error.message)
      }
      return runtimeError('sed', reasonOf(error))
    }
  }
  if (split.inPlace) {
    if (operands.length === 0) {
      return runtimeError('sed', 'no input files')
    }
    let errors = ''
    let status = 0
    for (const operand of operands) {
      if (operand === '-') {
        errors += `sed: couldn't edit -: not a regular file\n`
        status = 1
        continue
      }
      try {
        const text = DECODER.decode(readInputBytes(ctx, operand))
        const result = applySedCommands(splitLines(text), commands, autoPrint, ctx)
        if (result.aborted) {
          return ABORTED
        }
        // -i.bak 这类后缀：先把原文写一份备份再覆盖
        if (split.suffix !== '') {
          ctx.fs.writeText(resolvePath(ctx.cwd, `${operand}${split.suffix}`), text)
        }
        ctx.fs.writeText(resolvePath(ctx.cwd, operand), joinLines(result.lines))
      } catch (error) {
        errors += `sed: ${operand}: ${reasonOf(error)}\n`
        status = 1
      }
    }
    return { code: status, stdout: '', stderr: errors }
  }
  const sources = operands.length > 0 ? operands : ['-']
  let text = ''
  let errors = ''
  let failed = false
  for (const operand of sources) {
    try {
      text += DECODER.decode(readInputBytes(ctx, operand))
    } catch (error) {
      errors += `sed: ${operand}: ${reasonOf(error)}\n`
      failed = true
    }
  }
  const result = applySedCommands(splitLines(text), commands, autoPrint, ctx)
  if (result.aborted) {
    return ABORTED
  }
  return { code: failed ? 1 : 0, stdout: joinLines(result.lines), stderr: errors }
}

const sedApplet: Applet = {
  name: 'sed',
  summary: '流编辑器：替换、按地址打印或删除，支持 -i 就地写回',
  summaryEn: 'Stream editor: substitute, print or delete by address, -i in place',
  usage: 'sed [-n] [-E] [-i] [-e SCRIPT] [SCRIPT] [file...]',
  run: (ctx: AppletContext): AppletResult => runSed(ctx),
}

// ---------- awk ----------

type AwkValue = string | number

type AwkToken = { kind: 'num' | 'str' | 'regex' | 'name' | 'op' | 'eof'; text: string }

type AwkExpr =
  | { kind: 'number'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'regex'; source: string }
  | { kind: 'field'; index: AwkExpr }
  | { kind: 'variable'; name: string }
  | { kind: 'unary'; op: string; operand: AwkExpr }
  | { kind: 'binary'; op: string; left: AwkExpr; right: AwkExpr }
  | { kind: 'call'; name: string; args: AwkExpr[] }

type AwkStmt =
  | { kind: 'empty' }
  | { kind: 'block'; body: AwkStmt[] }
  | { kind: 'print'; args: AwkExpr[]; redirect: { append: boolean; target: AwkExpr } | null }
  | { kind: 'assignment'; name: string; value: AwkExpr }
  | { kind: 'expression'; expression: AwkExpr }
  | { kind: 'if'; condition: AwkExpr; then: AwkStmt; otherwise: AwkStmt | null }
  | { kind: 'exit' }

type AwkRule = {
  phase: 'begin' | 'end' | 'main'
  pattern: AwkExpr | null
  action: AwkStmt[] | null
}

type AwkRuntime = {
  ctx: AppletContext
  vars: Map<string, AwkValue>
  record: string
  fields: string[]
  nr: number
  filename: string
  output: string[]
  redirects: Map<string, { append: boolean; text: string }>
  exiting: boolean
}

const AWK_OPERATORS = [
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '!~',
  '>>',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '=',
  '!',
  '~',
  '(',
  ')',
  '{',
  '}',
  '[',
  ']',
  ',',
  ';',
  '$',
]

/** 上一个记号后面能不能出现正则字面量（区分 `/` 是除号还是正则） */
const awkRegexAllowed = (previous: AwkToken | null): boolean => {
  if (previous === null) {
    return true
  }
  if (previous.kind === 'num' || previous.kind === 'str' || previous.kind === 'regex') {
    return false
  }
  if (previous.kind === 'name') {
    return false
  }
  return !(previous.kind === 'op' && previous.text === ')')
}

const tokenizeAwk = (source: string): AwkToken[] => {
  const tokens: AwkToken[] = []
  let index = 0
  let previous: AwkToken | null = null
  const push = (token: AwkToken): void => {
    tokens.push(token)
    previous = token
  }
  const readString = (): string => {
    index += 1
    let value = ''
    while (index < source.length) {
      const char = source[index]
      if (char === '"') {
        index += 1
        return value
      }
      if (char === '\\') {
        const next = source[index + 1]
        index += 2
        if (next === 'n') {
          value += '\n'
        } else if (next === 't') {
          value += '\t'
        } else if (next === 'r') {
          value += '\r'
        } else if (next === undefined) {
          value += '\\'
        } else {
          value += next
        }
        continue
      }
      value += char
      index += 1
    }
    throw new VmError('EINVAL', 'syntax error')
  }
  const readRegex = (): string => {
    index += 1
    let body = ''
    while (index < source.length) {
      const char = source[index]
      if (char === '\\') {
        body += char + (source[index + 1] ?? '')
        index += 2
        continue
      }
      if (char === '/') {
        index += 1
        return body
      }
      if (char === '\n') {
        break
      }
      body += char
      index += 1
    }
    throw new VmError('EINVAL', 'syntax error')
  }
  while (index < source.length) {
    const char = source[index]
    if (char === ' ' || char === '\t' || char === '\n' || char === '\r') {
      index += 1
      continue
    }
    if (char === '#') {
      while (index < source.length && source[index] !== '\n') {
        index += 1
      }
      continue
    }
    if (char === '\\' && source[index + 1] === '\n') {
      index += 2
      continue
    }
    if (char === '"') {
      push({ kind: 'str', text: readString() })
      continue
    }
    if (char === '/' && awkRegexAllowed(previous)) {
      push({ kind: 'regex', text: readRegex() })
      continue
    }
    if ((char >= '0' && char <= '9') || (char === '.' && /[0-9]/.test(source[index + 1] ?? ''))) {
      let text = ''
      while (index < source.length && /[0-9.]/.test(source[index])) {
        text += source[index]
        index += 1
      }
      if (source[index] === 'e' || source[index] === 'E') {
        let exponent = source[index]
        index += 1
        if (source[index] === '+' || source[index] === '-') {
          exponent += source[index]
          index += 1
        }
        while (index < source.length && /[0-9]/.test(source[index])) {
          exponent += source[index]
          index += 1
        }
        text += exponent
      }
      push({ kind: 'num', text })
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let name = ''
      while (index < source.length && /[A-Za-z0-9_]/.test(source[index])) {
        name += source[index]
        index += 1
      }
      push({ kind: 'name', text: name })
      continue
    }
    const operator = AWK_OPERATORS.find((candidate) => source.startsWith(candidate, index))
    if (operator === undefined) {
      throw new VmError('EINVAL', 'syntax error')
    }
    push({ kind: 'op', text: operator })
    index += operator.length
  }
  push({ kind: 'eof', text: '' })
  return tokens
}

/** 递归下降解析 awk 程序，只覆盖够用的子集 */
const parseAwkProgram = (tokens: AwkToken[]): AwkRule[] => {
  let position = 0
  /** print 的参数里，顶层 `>` 是重定向而不是比较 */
  let stopAtRedirect = false
  const peekAt = (offset = 0): AwkToken => tokens[Math.min(position + offset, tokens.length - 1)]
  const peek = (): AwkToken => peekAt(0)
  const advance = (): AwkToken => {
    const token = peek()
    position += 1
    return token
  }
  const isOp = (text: string, offset = 0): boolean => {
    const token = peekAt(offset)
    return token.kind === 'op' && token.text === text
  }
  const expect = (text: string): void => {
    if (!isOp(text)) {
      throw new VmError('EINVAL', 'syntax error')
    }
    advance()
  }
  const endOfStatement = (): boolean => {
    const token = peek()
    if (token.kind === 'eof') {
      return true
    }
    if (token.kind === 'op' && (token.text === ';' || token.text === '}')) {
      return true
    }
    return token.kind === 'name' && (token.text === 'else' || token.text === 'END')
  }

  function startsPrimary(token: AwkToken): boolean {
    if (token.kind === 'num' || token.kind === 'str' || token.kind === 'name') {
      return true
    }
    return token.kind === 'op' && (token.text === '$' || token.text === '(')
  }

  function parsePrimary(): AwkExpr {
    const token = peek()
    if (token.kind === 'num') {
      advance()
      return { kind: 'number', value: Number(token.text) }
    }
    if (token.kind === 'str') {
      advance()
      return { kind: 'string', value: token.text }
    }
    if (token.kind === 'regex') {
      advance()
      try {
        new RegExp(token.text)
      } catch {
        throw new VmError('EINVAL', 'syntax error')
      }
      return { kind: 'regex', source: token.text }
    }
    if (token.kind === 'op' && token.text === '$') {
      advance()
      return { kind: 'field', index: parsePrimary() }
    }
    if (token.kind === 'op' && token.text === '(') {
      advance()
      const saved = stopAtRedirect
      stopAtRedirect = false
      const expression = parseExpression()
      stopAtRedirect = saved
      expect(')')
      return expression
    }
    if (token.kind === 'name') {
      advance()
      if (isOp('(')) {
        advance()
        const args: AwkExpr[] = []
        const saved = stopAtRedirect
        stopAtRedirect = false
        if (!isOp(')')) {
          args.push(parseExpression())
          while (isOp(',')) {
            advance()
            args.push(parseExpression())
          }
        }
        stopAtRedirect = saved
        expect(')')
        return { kind: 'call', name: token.text, args }
      }
      return { kind: 'variable', name: token.text }
    }
    throw new VmError('EINVAL', 'syntax error')
  }

  function parseUnary(): AwkExpr {
    const token = peek()
    if (token.kind === 'op' && (token.text === '!' || token.text === '-' || token.text === '+')) {
      advance()
      return { kind: 'unary', op: token.text, operand: parseUnary() }
    }
    return parsePrimary()
  }

  function parseMultiplicative(): AwkExpr {
    let left = parseUnary()
    while (
      peek().kind === 'op' &&
      (peek().text === '*' || peek().text === '/' || peek().text === '%')
    ) {
      const op = advance().text
      left = { kind: 'binary', op, left, right: parseUnary() }
    }
    return left
  }

  function parseAdditive(): AwkExpr {
    let left = parseMultiplicative()
    while (peek().kind === 'op' && (peek().text === '+' || peek().text === '-')) {
      const op = advance().text
      left = { kind: 'binary', op, left, right: parseMultiplicative() }
    }
    return left
  }

  function parseConcat(): AwkExpr {
    let left = parseAdditive()
    while (startsPrimary(peek())) {
      left = { kind: 'binary', op: 'concat', left, right: parseAdditive() }
    }
    return left
  }

  function parseComparison(): AwkExpr {
    let left = parseConcat()
    while (peek().kind === 'op') {
      const text = peek().text
      if (stopAtRedirect && (text === '>' || text === '>>')) {
        break
      }
      if (
        text !== '==' &&
        text !== '!=' &&
        text !== '<' &&
        text !== '<=' &&
        text !== '>' &&
        text !== '>='
      ) {
        break
      }
      advance()
      left = { kind: 'binary', op: text, left, right: parseConcat() }
    }
    return left
  }

  function parseMatch(): AwkExpr {
    let left = parseComparison()
    while (peek().kind === 'op' && (peek().text === '~' || peek().text === '!~')) {
      const op = advance().text
      left = { kind: 'binary', op, left, right: parseComparison() }
    }
    return left
  }

  function parseAnd(): AwkExpr {
    let left = parseMatch()
    while (isOp('&&')) {
      advance()
      left = { kind: 'binary', op: '&&', left, right: parseMatch() }
    }
    return left
  }

  function parseExpression(): AwkExpr {
    let left = parseAnd()
    while (isOp('||')) {
      advance()
      left = { kind: 'binary', op: '||', left, right: parseAnd() }
    }
    return left
  }

  function parseBlockBody(): AwkStmt[] {
    expect('{')
    const body: AwkStmt[] = []
    while (!isOp('}')) {
      if (peek().kind === 'eof') {
        throw new VmError('EINVAL', 'syntax error')
      }
      body.push(parseStatement())
      if (isOp(';')) {
        advance()
      }
    }
    advance()
    return body
  }

  function parsePrint(): AwkStmt {
    advance()
    const args: AwkExpr[] = []
    const saved = stopAtRedirect
    stopAtRedirect = true
    if (!endOfStatement() && !isOp('>') && !isOp('>>')) {
      args.push(parseExpression())
      while (isOp(',')) {
        advance()
        args.push(parseExpression())
      }
    }
    stopAtRedirect = saved
    let redirect: { append: boolean; target: AwkExpr } | null = null
    if (isOp('>') || isOp('>>')) {
      const append = advance().text === '>>'
      redirect = { append, target: parseExpression() }
    }
    return { kind: 'print', args, redirect }
  }

  function parseIf(): AwkStmt {
    advance()
    expect('(')
    const saved = stopAtRedirect
    stopAtRedirect = false
    const condition = parseExpression()
    stopAtRedirect = saved
    expect(')')
    const then = parseStatement()
    let otherwise: AwkStmt | null = null
    if (peek().kind === 'name' && peek().text === 'else') {
      advance()
      otherwise = parseStatement()
    }
    return { kind: 'if', condition, then, otherwise }
  }

  function parseStatement(): AwkStmt {
    const token = peek()
    if (token.kind === 'op') {
      if (token.text === '{') {
        return { kind: 'block', body: parseBlockBody() }
      }
      if (token.text === ';') {
        advance()
        return { kind: 'empty' }
      }
    }
    if (token.kind === 'name') {
      if (token.text === 'print') {
        return parsePrint()
      }
      if (token.text === 'if') {
        return parseIf()
      }
      if (token.text === 'exit') {
        advance()
        return { kind: 'exit' }
      }
      if (
        token.text === 'printf' ||
        token.text === 'while' ||
        token.text === 'for' ||
        token.text === 'do' ||
        token.text === 'next' ||
        token.text === 'delete' ||
        token.text === 'getline'
      ) {
        throw new VmError('EINVAL', 'syntax error')
      }
      if (isOp('=', 1)) {
        const name = advance().text
        advance()
        const saved = stopAtRedirect
        stopAtRedirect = false
        const value = parseExpression()
        stopAtRedirect = saved
        return { kind: 'assignment', name, value }
      }
    }
    const saved = stopAtRedirect
    stopAtRedirect = false
    const expression = parseExpression()
    stopAtRedirect = saved
    return { kind: 'expression', expression }
  }

  const rules: AwkRule[] = []
  while (peek().kind !== 'eof') {
    if (isOp(';')) {
      advance()
      continue
    }
    const token = peek()
    if (token.kind === 'name' && (token.text === 'BEGIN' || token.text === 'END')) {
      advance()
      const phase = token.text === 'BEGIN' ? 'begin' : 'end'
      if (!isOp('{')) {
        throw new VmError('EINVAL', 'syntax error')
      }
      rules.push({ phase, pattern: null, action: parseBlockBody() })
      continue
    }
    if (isOp('{')) {
      rules.push({ phase: 'main', pattern: null, action: parseBlockBody() })
      continue
    }
    const pattern = parseExpression()
    let action: AwkStmt[] | null = null
    if (isOp('{')) {
      action = parseBlockBody()
    } else if (isOp(';')) {
      advance()
    }
    rules.push({ phase: 'main', pattern, action })
  }
  return rules
}

const AWK_NUMERIC_PREFIX = /^[ \t]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?/
const AWK_NUMERIC_FULL = /^[ \t]*[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?[ \t]*$/

const awkToNumber = (value: AwkValue): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0
  }
  const match = AWK_NUMERIC_PREFIX.exec(value)
  return match ? Number(match[0]) : 0
}

const awkNumeric = (value: AwkValue): boolean =>
  typeof value === 'number' || AWK_NUMERIC_FULL.test(value)

const awkToString = (value: AwkValue): string => {
  if (typeof value === 'string') {
    return value
  }
  if (Number.isInteger(value) && Math.abs(value) < 1e15) {
    return String(value)
  }
  return String(Number(value.toPrecision(6)))
}

const awkTruthy = (value: AwkValue): boolean => {
  if (typeof value === 'number') {
    return value !== 0
  }
  if (value === '') {
    return false
  }
  if (AWK_NUMERIC_FULL.test(value)) {
    return Number(value) !== 0
  }
  return true
}

const awkCompare = (left: AwkValue, right: AwkValue): number => {
  if (awkNumeric(left) && awkNumeric(right)) {
    const a = awkToNumber(left)
    const b = awkToNumber(right)
    return a === b ? 0 : a < b ? -1 : 1
  }
  const a = awkToString(left)
  const b = awkToString(right)
  return a === b ? 0 : a < b ? -1 : 1
}

const awkRegexMatches = (source: string, input: string): boolean => {
  let regex: RegExp
  try {
    regex = new RegExp(source)
  } catch {
    throw new VmError('EINVAL', 'invalid regular expression')
  }
  return regex.test(input)
}

const awkSplitFields = (record: string, fieldSeparator: string): string[] => {
  if (fieldSeparator === ' ') {
    const trimmed = record.trim()
    return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/)
  }
  if (fieldSeparator === '') {
    return [...record]
  }
  if (fieldSeparator.length === 1) {
    return record.split(fieldSeparator)
  }
  try {
    return record.split(new RegExp(fieldSeparator))
  } catch {
    throw new VmError('EINVAL', 'invalid field separator')
  }
}

const readAwkVariable = (runtime: AwkRuntime, name: string): AwkValue => {
  if (name === 'NR') {
    return runtime.nr
  }
  if (name === 'NF') {
    return runtime.fields.length
  }
  if (name === 'FILENAME') {
    return runtime.filename
  }
  return runtime.vars.get(name) ?? ''
}

const evaluateAwk = (runtime: AwkRuntime, expression: AwkExpr): AwkValue => {
  switch (expression.kind) {
    case 'number':
      return expression.value
    case 'string':
      return expression.value
    case 'regex':
      return awkRegexMatches(expression.source, runtime.record) ? 1 : 0
    case 'field': {
      const position = Math.trunc(awkToNumber(evaluateAwk(runtime, expression.index)))
      if (position === 0) {
        return runtime.record
      }
      return runtime.fields[position - 1] ?? ''
    }
    case 'variable':
      return readAwkVariable(runtime, expression.name)
    case 'unary': {
      const value = evaluateAwk(runtime, expression.operand)
      if (expression.op === '!') {
        return awkTruthy(value) ? 0 : 1
      }
      return expression.op === '-' ? -awkToNumber(value) : awkToNumber(value)
    }
    case 'call': {
      const args = expression.args.map((item) => evaluateAwk(runtime, item))
      switch (expression.name) {
        case 'length': {
          if (args.length === 0) {
            return [...runtime.record].length
          }
          return [...awkToString(args[0])].length
        }
        case 'substr': {
          const text = [...awkToString(args[0] ?? '')]
          const start = Math.trunc(awkToNumber(args[1] ?? 1))
          const from = Math.max(0, start - 1)
          const count = args.length >= 3 ? Math.trunc(awkToNumber(args[2])) : text.length
          return text.slice(from, from + Math.max(0, count)).join('')
        }
        case 'index': {
          const haystack = awkToString(args[0] ?? '')
          const needle = awkToString(args[1] ?? '')
          const found = haystack.indexOf(needle)
          return found < 0 ? 0 : found + 1
        }
        case 'toupper':
          return awkToString(args[0] ?? '').toUpperCase()
        case 'tolower':
          return awkToString(args[0] ?? '').toLowerCase()
        case 'int':
          return Math.trunc(awkToNumber(args[0] ?? 0))
        case 'sqrt':
          return Math.sqrt(awkToNumber(args[0] ?? 0))
        default:
          throw new VmError('EINVAL', `function '${expression.name}' is not supported`)
      }
    }
    case 'binary': {
      if (expression.op === '&&') {
        return awkTruthy(evaluateAwk(runtime, expression.left)) &&
          awkTruthy(evaluateAwk(runtime, expression.right))
          ? 1
          : 0
      }
      if (expression.op === '||') {
        return awkTruthy(evaluateAwk(runtime, expression.left)) ||
          awkTruthy(evaluateAwk(runtime, expression.right))
          ? 1
          : 0
      }
      const left = evaluateAwk(runtime, expression.left)
      const right = evaluateAwk(runtime, expression.right)
      switch (expression.op) {
        case 'concat':
          return awkToString(left) + awkToString(right)
        case '+':
          return awkToNumber(left) + awkToNumber(right)
        case '-':
          return awkToNumber(left) - awkToNumber(right)
        case '*':
          return awkToNumber(left) * awkToNumber(right)
        case '/': {
          const divisor = awkToNumber(right)
          if (divisor === 0) {
            throw new VmError('EINVAL', 'division by zero')
          }
          return awkToNumber(left) / divisor
        }
        case '%': {
          const divisor = awkToNumber(right)
          if (divisor === 0) {
            throw new VmError('EINVAL', 'division by zero')
          }
          return awkToNumber(left) % divisor
        }
        case '==':
          return awkCompare(left, right) === 0 ? 1 : 0
        case '!=':
          return awkCompare(left, right) !== 0 ? 1 : 0
        case '<':
          return awkCompare(left, right) < 0 ? 1 : 0
        case '<=':
          return awkCompare(left, right) <= 0 ? 1 : 0
        case '>':
          return awkCompare(left, right) > 0 ? 1 : 0
        case '>=':
          return awkCompare(left, right) >= 0 ? 1 : 0
        case '~':
          return awkRegexMatches(awkToString(right), awkToString(left)) ? 1 : 0
        case '!~':
          return awkRegexMatches(awkToString(right), awkToString(left)) ? 0 : 1
        default:
          throw new VmError('EINVAL', `operator '${expression.op}' is not supported`)
      }
    }
    default:
      throw new VmError('EINVAL', 'syntax error')
  }
}

const writeAwkRedirect = (
  runtime: AwkRuntime,
  redirect: { append: boolean; target: AwkExpr },
  line: string
): void => {
  const path = resolvePath(runtime.ctx.cwd, awkToString(evaluateAwk(runtime, redirect.target)))
  const separator = awkToString(readAwkVariable(runtime, 'ORS'))
  const text = `${line}${separator}`
  const existing = runtime.redirects.get(path)
  if (existing) {
    existing.text += text
    return
  }
  runtime.redirects.set(path, { append: redirect.append, text })
}

const executeAwkStatement = (runtime: AwkRuntime, statement: AwkStmt): void => {
  switch (statement.kind) {
    case 'empty':
      return
    case 'block':
      for (const child of statement.body) {
        executeAwkStatement(runtime, child)
        if (runtime.exiting) {
          return
        }
      }
      return
    case 'print': {
      const values =
        statement.args.length > 0
          ? statement.args.map((item) => evaluateAwk(runtime, item))
          : [runtime.record]
      const line = values
        .map((value) => awkToString(value))
        .join(awkToString(readAwkVariable(runtime, 'OFS')))
      if (statement.redirect !== null) {
        writeAwkRedirect(runtime, statement.redirect, line)
        return
      }
      runtime.output.push(line)
      return
    }
    case 'assignment':
      runtime.vars.set(statement.name, evaluateAwk(runtime, statement.value))
      return
    case 'expression':
      evaluateAwk(runtime, statement.expression)
      return
    case 'if':
      if (awkTruthy(evaluateAwk(runtime, statement.condition))) {
        executeAwkStatement(runtime, statement.then)
      } else if (statement.otherwise !== null) {
        executeAwkStatement(runtime, statement.otherwise)
      }
      return
    case 'exit':
      runtime.exiting = true
      return
    default:
      return
  }
}

/** 把 -v 的赋值从 argv 里剥出来（parseArgs 只留最后一次，而 awk 允许多次） */
const splitAwkAssignments = (
  argv: string[]
): { args: string[]; assignments: string[]; error?: string } => {
  const args: string[] = [argv[0]]
  const assignments: string[] = []
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '-v' || arg === '--assign') {
      const value = argv[index + 1]
      if (value === undefined) {
        return { args, assignments, error: "option requires an argument -- 'v'" }
      }
      assignments.push(value)
      index += 1
      continue
    }
    if (!arg.startsWith('--') && arg.startsWith('-v') && arg.length > 2) {
      assignments.push(arg.slice(2))
      continue
    }
    if (arg.startsWith('--assign=')) {
      assignments.push(arg.slice('--assign='.length))
      continue
    }
    args.push(arg)
  }
  return { args, assignments }
}

/** awk 字符串里的 \t \n 转义 */
const unescapeAwkText = (text: string): string => {
  let out = ''
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (char !== '\\') {
      out += char
      continue
    }
    const next = text[index + 1]
    index += 1
    if (next === 'n') {
      out += '\n'
    } else if (next === 't') {
      out += '\t'
    } else if (next === 'r') {
      out += '\r'
    } else if (next === undefined) {
      out += '\\'
    } else {
      out += next
    }
  }
  return out
}

const runAwk = (ctx: AppletContext): AppletResult => {
  const split = splitAwkAssignments(ctx.argv)
  if (split.error) {
    return usageError('awk', split.error)
  }
  const parsed = parseArgs(split.args, { F: 'value' })
  if (parsed.error) {
    return usageError('awk', parsed.error)
  }
  if (parsed.operands.length === 0) {
    return usageError('awk', 'usage: awk [-F SEP] [-v VAR=VALUE] [PROGRAM] [file...]')
  }
  const program = parsed.operands[0]
  const files = parsed.operands.slice(1)
  let rules: AwkRule[]
  try {
    rules = parseAwkProgram(tokenizeAwk(program))
  } catch {
    return runtimeError('awk', 'syntax error', 2)
  }
  const runtime: AwkRuntime = {
    ctx,
    vars: new Map<string, AwkValue>([
      ['FS', ' '],
      ['OFS', ' '],
      ['ORS', '\n'],
    ]),
    record: '',
    fields: [],
    nr: 0,
    filename: '',
    output: [],
    redirects: new Map(),
    exiting: false,
  }
  const fieldSeparator = flagText(parsed.flags, 'F')
  if (fieldSeparator !== null) {
    runtime.vars.set('FS', unescapeAwkText(fieldSeparator))
  }
  for (const assignment of split.assignments) {
    const equals = assignment.indexOf('=')
    if (equals <= 0) {
      return usageError('awk', `invalid -v assignment: '${assignment}'`)
    }
    const name = assignment.slice(0, equals)
    const raw = unescapeAwkText(assignment.slice(equals + 1))
    runtime.vars.set(name, AWK_NUMERIC_FULL.test(raw) && raw.trim() !== '' ? Number(raw) : raw)
  }
  let errors = ''
  const sources: { label: string; text: string }[] = []
  if (files.length === 0) {
    sources.push({ label: '-', text: ctx.stdin })
  } else {
    for (const operand of files) {
      try {
        sources.push({ label: operand, text: readSource(ctx, operand) })
      } catch (error) {
        errors += `awk: can't open file ${operand}: ${reasonOf(error)}\n`
      }
    }
  }
  const hasMain = rules.some((rule) => rule.phase === 'main')
  const hasEnd = rules.some((rule) => rule.phase === 'end')
  try {
    for (const rule of rules) {
      if (rule.phase !== 'begin') {
        continue
      }
      for (const statement of rule.action ?? []) {
        executeAwkStatement(runtime, statement)
        if (runtime.exiting) {
          break
        }
      }
    }
    if ((hasMain || hasEnd) && !runtime.exiting) {
      outer: for (const source of sources) {
        runtime.filename = source.label
        const records = splitLines(source.text)
        for (const record of records) {
          if ((runtime.nr & 0xff) === 0 && interrupted(ctx)) {
            return ABORTED
          }
          runtime.nr += 1
          runtime.record = record
          const separator = awkToString(readAwkVariable(runtime, 'FS'))
          runtime.fields = awkSplitFields(record, separator)
          for (const rule of rules) {
            if (rule.phase !== 'main') {
              continue
            }
            if (rule.pattern !== null && !awkTruthy(evaluateAwk(runtime, rule.pattern))) {
              continue
            }
            if (rule.action === null) {
              runtime.output.push(record)
            } else {
              for (const statement of rule.action) {
                executeAwkStatement(runtime, statement)
                if (runtime.exiting) {
                  break
                }
              }
            }
            if (runtime.exiting) {
              break
            }
          }
          if (runtime.exiting) {
            break outer
          }
        }
      }
    }
    runtime.exiting = false
    if (hasEnd) {
      for (const rule of rules) {
        if (rule.phase !== 'end') {
          continue
        }
        for (const statement of rule.action ?? []) {
          executeAwkStatement(runtime, statement)
          if (runtime.exiting) {
            break
          }
        }
      }
    }
    for (const [path, buffer] of runtime.redirects) {
      const previous = buffer.append ? (ctx.fs.readText(path) ?? '') : ''
      ctx.fs.writeText(path, previous + buffer.text)
    }
  } catch (error) {
    if (error instanceof VmError) {
      return runtimeError('awk', error.message, 2)
    }
    return runtimeError('awk', reasonOf(error), 2)
  }
  const recordSeparator = awkToString(readAwkVariable(runtime, 'ORS'))
  const stdout =
    runtime.output.length > 0 ? `${runtime.output.join(recordSeparator)}${recordSeparator}` : ''
  return { code: errors ? 2 : 0, stdout, stderr: errors }
}

const awkApplet: Applet = {
  name: 'awk',
  summary: '按字段处理文本：print、NR/NF、BEGIN/END、-F、-v',
  summaryEn: 'Process text by fields: print, NR/NF, BEGIN/END, -F, -v',
  usage: "awk [-F SEP] [-v VAR=VALUE] 'PROGRAM' [file...]",
  run: (ctx: AppletContext): AppletResult => runAwk(ctx),
}

// ---------- sort / uniq ----------

/** GNU 风格的数值前缀解析：非数字按 0 算 */
const numericPrefix = (text: string): number => {
  const match = AWK_NUMERIC_PREFIX.exec(text)
  return match ? Number(match[0]) : 0
}

/** 人类可读大小的单位，从 K 开始按 1024 进制 */
const HUMAN_UNITS = ['K', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y']

/**
 * sort -h 的数量解析：纯数字按字节，1K / 1.5M / 2G 按 1024 进制，后缀可带 B（1KB）。
 * 认不出的按 0 算（GNU 的 -h 先比单位阶再比数字，认不出时退化成整行比较）。
 */
const humanPrefix = (text: string): number => {
  const match = /^(\d+(?:\.\d+)?)([KMGTPEZY]?)B?$/i.exec(text.trim())
  if (!match) {
    return 0
  }
  const amount = Number(match[1])
  const unit = match[2].toUpperCase()
  if (unit === '') {
    return amount
  }
  return amount * 1024 ** (HUMAN_UNITS.indexOf(unit) + 1)
}

/** -V 的切分：数字块与非数字块交替，1.9 → ['1', '.', '9'] */
const splitVersionChunks = (text: string): string[] => text.match(/\d+|\D+/g) ?? []

/** 数字块比较：先去掉前导零比长度，避免 parseInt 在大数字上丢精度 */
const compareNumericChunk = (left: string, right: string): number => {
  const a = left.replace(/^0+/, '')
  const b = right.replace(/^0+/, '')
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1
  }
  if (a !== b) {
    return a < b ? -1 : 1
  }
  // 数值相同（1 与 01）时前导零少的在前，保证顺序稳定
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1
  }
  return 0
}

/**
 * sort -V 的比较：数字块按数值、非数字块按字节序，从前往后逐块比。
 * 简化点：GNU 的 filevercmp 还特判了 `~`（排最前）、标点（排在字母之后）与文件名后缀，这里不处理。
 */
const compareVersion = (left: string, right: string, fold: boolean): number => {
  const a = splitVersionChunks(left)
  const b = splitVersionChunks(right)
  const shared = Math.min(a.length, b.length)
  for (let index = 0; index < shared; index += 1) {
    const x = a[index]
    const y = b[index]
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const result = compareNumericChunk(x, y)
      if (result !== 0) {
        return result
      }
      continue
    }
    // 块类型不同时（1.0 与 v1.0）直接按字节序，数字排在字母前
    const xn = fold ? x.toLowerCase() : x
    const yn = fold ? y.toLowerCase() : y
    if (xn !== yn) {
      return xn < yn ? -1 : 1
    }
  }
  if (a.length === b.length) {
    return 0
  }
  // 前缀完全相同时块多的更长：1.0 < 1.0.1
  return a.length < b.length ? -1 : 1
}

/** 排序模式：GNU 把 -n / -h / -V 当互斥选项（同时给出会报错），这里用固定优先级 */
type SortMode = 'lexical' | 'numeric' | 'human' | 'version'

const sortApplet: Applet = {
  name: 'sort',
  summary: '按行排序，支持数值、人类可读大小、版本号、逆序、去重与按字段',
  summaryEn: 'Sort lines by text, number, human size or version, with reverse and unique',
  usage: 'sort [-n] [-h] [-V] [-r] [-u] [-f] [-b] [-k N] [-t SEP] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, {
      n: 'boolean',
      r: 'boolean',
      u: 'boolean',
      f: 'boolean',
      b: 'boolean',
      h: 'boolean',
      V: 'boolean',
      k: 'value',
      t: 'value',
    })
    if (parsed.error) {
      return usageError('sort', parsed.error)
    }
    const keySpec = flagText(parsed.flags, 'k')
    let keyStart = 0
    let keyEnd = 0
    if (keySpec !== null) {
      const match = /^(\d+)(?:,(\d+))?$/.exec(keySpec)
      if (!match || Number(match[1]) === 0) {
        return usageError('sort', `invalid field specification '${keySpec}'`)
      }
      keyStart = Number(match[1])
      keyEnd = match[2] ? Number(match[2]) : 0
      if (keyEnd !== 0 && keyEnd < keyStart) {
        return usageError('sort', `invalid field specification '${keySpec}'`)
      }
    }
    const separator = flagText(parsed.flags, 't')
    const numeric = flagOn(parsed.flags, 'n')
    const reverse = flagOn(parsed.flags, 'r')
    const unique = flagOn(parsed.flags, 'u')
    const fold = flagOn(parsed.flags, 'f')
    const ignoreBlanks = flagOn(parsed.flags, 'b')
    const human = flagOn(parsed.flags, 'h')
    const version = flagOn(parsed.flags, 'V')
    // parseArgs 不记录选项顺序，这里按固定优先级 -V > -h > -n 处理（GNU 对这类冲突组合直接报错）
    const mode: SortMode = version ? 'version' : human ? 'human' : numeric ? 'numeric' : 'lexical'
    const gathered = gatherLines(ctx, parsed.operands, 'sort')
    if (gathered.errors !== '') {
      return { code: 2, stderr: gathered.errors }
    }
    const buildKey = (line: string): string => {
      let key = line
      if (keyStart > 0) {
        const fields =
          separator !== null
            ? line.split(separator)
            : line.trim() === ''
              ? []
              : line.trim().split(/\s+/)
        key = fields.slice(keyStart - 1, keyEnd === 0 ? undefined : keyEnd).join(separator ?? ' ')
      }
      return ignoreBlanks ? key.trimStart() : key
    }
    const compareKeys = (left: string, right: string): number => {
      if (mode === 'numeric') {
        const a = numericPrefix(left)
        const b = numericPrefix(right)
        return a === b ? 0 : a < b ? -1 : 1
      }
      if (mode === 'human') {
        const a = humanPrefix(left)
        const b = humanPrefix(right)
        return a === b ? 0 : a < b ? -1 : 1
      }
      if (mode === 'version') {
        return compareVersion(left, right, fold)
      }
      const a = fold ? left.toLowerCase() : left
      const b = fold ? right.toLowerCase() : right
      return a === b ? 0 : a < b ? -1 : 1
    }
    const entries: { line: string; index: number; key: string }[] = []
    for (let index = 0; index < gathered.lines.length; index += 1) {
      if ((index & 0xff) === 0 && interrupted(ctx)) {
        return ABORTED
      }
      const line = gathered.lines[index]
      entries.push({ line, index, key: buildKey(line) })
    }
    entries.sort((left, right) => {
      const result = compareKeys(left.key, right.key)
      const ordered = reverse ? -result : result
      return ordered !== 0 ? ordered : left.index - right.index
    })
    const output: string[] = []
    // -u 按「最终比较键」去重，而不是整行原文（GNU 语义）：
    // -k2 只保留第二列同键的行、-n 把 1 与 01 看作同键；同键时留下排序后的第一行。
    let previousKey: string | null = null
    for (const entry of entries) {
      if (unique && previousKey !== null && compareKeys(previousKey, entry.key) === 0) {
        continue
      }
      output.push(entry.line)
      previousKey = entry.key
    }
    return ok(joinLines(output))
  },
}

const uniqApplet: Applet = {
  name: 'uniq',
  summary: '去掉相邻重复行，可计数或只看重复行',
  summaryEn: 'Filter adjacent duplicate lines with optional counts',
  usage: 'uniq [-c] [-d] [-u] [-i] [file]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, {
      c: 'boolean',
      d: 'boolean',
      u: 'boolean',
      i: 'boolean',
    })
    if (parsed.error) {
      return usageError('uniq', parsed.error)
    }
    const gathered = gatherLines(ctx, parsed.operands, 'uniq')
    const stderr = gathered.errors
    const counts = flagOn(parsed.flags, 'c')
    const onlyDuplicates = flagOn(parsed.flags, 'd')
    const onlyUnique = flagOn(parsed.flags, 'u')
    const ignoreCase = flagOn(parsed.flags, 'i')
    if (onlyDuplicates && onlyUnique) {
      return { code: stderr ? 1 : 0, stdout: '', stderr }
    }
    const groups: { line: string; count: number }[] = []
    for (const line of gathered.lines) {
      const previous = groups.at(-1)
      const same =
        previous !== undefined &&
        (ignoreCase ? previous.line.toLowerCase() === line.toLowerCase() : previous.line === line)
      if (same && previous !== undefined) {
        previous.count += 1
        continue
      }
      groups.push({ line, count: 1 })
    }
    const output: string[] = []
    for (const group of groups) {
      if (onlyDuplicates && group.count < 2) {
        continue
      }
      if (onlyUnique && group.count > 1) {
        continue
      }
      output.push(counts ? `${String(group.count).padStart(7)} ${group.line}` : group.line)
    }
    return { code: stderr ? 1 : 0, stdout: joinLines(output), stderr }
  },
}

// ---------- cut / tr ----------

type CutRange = { start: number; end: number }

/** 解析 1,3-5 这类列表；非法返回 null */
const parseCutList = (text: string): CutRange[] | null => {
  const ranges: CutRange[] = []
  for (const part of text.split(',')) {
    if (part === '') {
      continue
    }
    const match = /^(\d+)?(-)?(\d+)?$/.exec(part)
    if (!match) {
      return null
    }
    const [, first, dash, last] = match
    if (dash === undefined) {
      const value = first === undefined ? 0 : Number(first)
      if (value === 0) {
        return null
      }
      ranges.push({ start: value, end: value })
      continue
    }
    const start = first === undefined ? 1 : Number(first)
    const end = last === undefined ? Number.POSITIVE_INFINITY : Number(last)
    if (start === 0 || (end !== Number.POSITIVE_INFINITY && end < start)) {
      return null
    }
    ranges.push({ start, end })
  }
  return ranges.length > 0 ? ranges : null
}

const cutSelected = (ranges: CutRange[], position: number): boolean =>
  ranges.some((range) => position >= range.start && position <= range.end)

const cutApplet: Applet = {
  name: 'cut',
  summary: '按分隔符取字段或按位置取字符',
  summaryEn: 'Select fields by delimiter or characters by position',
  usage: 'cut [-d CHAR] -f LIST | cut -c LIST [-s] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, {
      d: 'value',
      f: 'value',
      c: 'value',
      s: 'boolean',
    })
    if (parsed.error) {
      return usageError('cut', parsed.error)
    }
    const fieldsFlag = flagText(parsed.flags, 'f')
    const charsFlag = flagText(parsed.flags, 'c')
    if (fieldsFlag === null && charsFlag === null) {
      return runtimeError('cut', 'you must specify a list of bytes, characters, or fields')
    }
    const ranges = parseCutList(fieldsFlag ?? charsFlag ?? '')
    if (ranges === null) {
      return runtimeError(
        'cut',
        fieldsFlag !== null
          ? `invalid field value '${fieldsFlag}'`
          : `invalid character value '${charsFlag ?? ''}'`
      )
    }
    const delimiter = flagText(parsed.flags, 'd') ?? '\t'
    const suppress = flagOn(parsed.flags, 's')
    const gathered = gatherLines(ctx, parsed.operands, 'cut')
    const output: string[] = []
    for (const line of gathered.lines) {
      if (fieldsFlag !== null) {
        if (!line.includes(delimiter)) {
          if (!suppress) {
            output.push(line)
          }
          continue
        }
        const parts = line.split(delimiter)
        output.push(parts.filter((_, index) => cutSelected(ranges, index + 1)).join(delimiter))
        continue
      }
      output.push([...line].filter((_, index) => cutSelected(ranges, index + 1)).join(''))
    }
    return { code: gathered.errors ? 1 : 0, stdout: joinLines(output), stderr: gathered.errors }
  },
}

const TR_CLASSES: Record<string, string> = {
  upper: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
  lower: 'abcdefghijklmnopqrstuvwxyz',
  digit: '0123456789',
  alpha: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz',
  alnum: 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  space: ' \t\n\r\v\f',
  blank: ' \t',
  punct: '!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~',
  xdigit: '0123456789ABCDEFabcdef',
}

/** tr 集合里的转义 */
const trEscape = (char: string): string => {
  switch (char) {
    case 'n':
      return '\n'
    case 't':
      return '\t'
    case 'r':
      return '\r'
    case 'f':
      return '\f'
    case 'v':
      return '\v'
    case 'b':
      return '\b'
    case '0':
      return '\0'
    default:
      return char
  }
}

/** 展开 a-z、[:upper:]、\n 这类集合写法 */
const parseTrSet = (text: string): string[] | null => {
  const out: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === '\\') {
      const next = text[index + 1]
      if (next === undefined) {
        out.push('\\')
        index += 1
        continue
      }
      out.push(trEscape(next))
      index += 2
      continue
    }
    if (char === '[' && text[index + 1] === ':') {
      const end = text.indexOf(':]', index + 2)
      if (end > index + 2) {
        const expansion = TR_CLASSES[text.slice(index + 2, end)]
        if (expansion === undefined) {
          return null
        }
        out.push(...expansion)
        index = end + 2
        continue
      }
    }
    if (text[index + 1] === '-' && text[index + 2] !== undefined) {
      const from = text.charCodeAt(index)
      const to = text.charCodeAt(index + 2)
      if (from <= to) {
        for (let code = from; code <= to; code += 1) {
          out.push(String.fromCharCode(code))
        }
        index += 3
        continue
      }
    }
    out.push(char)
    index += 1
  }
  return out
}

const trApplet: Applet = {
  name: 'tr',
  summary: '替换、删除或压缩字符，支持 a-z 与 [:upper:]',
  summaryEn: 'Translate, delete or squeeze characters from stdin',
  usage: 'tr [-d] [-s] SET1 [SET2]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, { d: 'boolean', s: 'boolean', c: 'boolean' })
    if (parsed.error) {
      return usageError('tr', parsed.error)
    }
    const deleting = flagOn(parsed.flags, 'd')
    const squeezing = flagOn(parsed.flags, 's')
    if (flagOn(parsed.flags, 'c')) {
      return usageError('tr', "option 'c' is not supported")
    }
    const set1Text = parsed.operands[0]
    if (set1Text === undefined) {
      return usageError('tr', 'missing operand')
    }
    const set2Text = parsed.operands[1]
    if (parsed.operands.length > 2) {
      return usageError('tr', `extra operand '${parsed.operands[2]}'`)
    }
    const set1 = parseTrSet(set1Text)
    if (set1 === null) {
      return runtimeError('tr', 'invalid character class')
    }
    const set2 = set2Text === undefined ? null : parseTrSet(set2Text)
    if (set2 === null && set2Text !== undefined) {
      return runtimeError('tr', 'invalid character class')
    }
    if (deleting && set2 === null && squeezing) {
      return usageError('tr', `missing operand after '${set1Text}'`)
    }
    if (!deleting && !squeezing && set2 === null) {
      return usageError('tr', `missing operand after '${set1Text}'`)
    }
    const deleteSet = deleting ? new Set(set1) : null
    const translate = new Map<string, string>()
    if (!deleting && set2 !== null) {
      if (set2.length === 0) {
        return runtimeError('tr', 'when not truncating set1, string2 must be non-empty')
      }
      for (let index = 0; index < set1.length; index += 1) {
        translate.set(set1[index], set2[index] ?? set2[set2.length - 1])
      }
    }
    let squeezeSet: Set<string> | null = null
    if (squeezing) {
      squeezeSet = new Set(set2 ?? set1)
    }
    const text = ctx.stdin
    let output = ''
    let previous = ''
    for (const char of text) {
      if (deleteSet !== null && deleteSet.has(char)) {
        continue
      }
      const translated = translate.get(char) ?? char
      if (squeezeSet !== null && translated === previous && squeezeSet.has(translated)) {
        continue
      }
      output += translated
      previous = translated
    }
    return ok(output)
  },
}

// ---------- wc / nl / rev / tac / paste ----------

const wcApplet: Applet = {
  name: 'wc',
  summary: '统计行数、词数、字符数与字节数',
  summaryEn: 'Count lines, words, characters and bytes',
  usage: 'wc [-l] [-w] [-c] [-m] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, {
      l: 'boolean',
      w: 'boolean',
      c: 'boolean',
      m: 'boolean',
    })
    if (parsed.error) {
      return usageError('wc', parsed.error)
    }
    let wantLines = flagOn(parsed.flags, 'l')
    let wantWords = flagOn(parsed.flags, 'w')
    let wantChars = flagOn(parsed.flags, 'm')
    let wantBytes = flagOn(parsed.flags, 'c')
    if (!wantLines && !wantWords && !wantChars && !wantBytes) {
      // 默认输出「行 词 字节」
      wantLines = true
      wantWords = true
      wantBytes = true
    }
    const measure = (bytes: Uint8Array): number[] => {
      const text = DECODER.decode(bytes)
      const values: number[] = []
      if (wantLines) {
        values.push((text.match(/\n/g) ?? []).length)
      }
      if (wantWords) {
        values.push(text.split(/\s+/).filter((word) => word !== '').length)
      }
      if (wantChars) {
        values.push([...text].length)
      }
      if (wantBytes) {
        values.push(bytes.byteLength)
      }
      return values
    }
    const operands = parsed.operands.length > 0 ? parsed.operands : ['-']
    const rows: { values: number[]; label: string }[] = []
    let errors = ''
    let status = 0
    for (const operand of operands) {
      try {
        rows.push({
          values: measure(readInputBytes(ctx, operand)),
          label: operand === '-' ? '' : operand,
        })
      } catch (error) {
        errors += `wc: ${operand}: ${reasonOf(error)}\n`
        status = 1
      }
    }
    if (rows.length > 1) {
      const totals: number[] = []
      for (let column = 0; column < rows[0].values.length; column += 1) {
        totals.push(rows.reduce((sum, row) => sum + (row.values[column] ?? 0), 0))
      }
      rows.push({ values: totals, label: 'total' })
    }
    const widths: number[] = []
    for (const row of rows) {
      for (let column = 0; column < row.values.length; column += 1) {
        widths[column] = Math.max(widths[column] ?? 0, String(row.values[column]).length)
      }
    }
    const output = rows.map((row) => {
      const cells = row.values.map((value, column) => String(value).padStart(widths[column] ?? 1))
      return row.label === '' ? cells.join(' ') : `${cells.join(' ')} ${row.label}`
    })
    return { code: status, stdout: joinLines(output), stderr: errors }
  },
}

const nlApplet: Applet = {
  name: 'nl',
  summary: '给文本行加行号',
  summaryEn: 'Number lines of files',
  usage: 'nl [-ba|-bt|-bn] [-w N] [-s STRING] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, { b: 'value', w: 'value', s: 'value' })
    if (parsed.error) {
      return usageError('nl', parsed.error)
    }
    const style = flagText(parsed.flags, 'b') ?? 't'
    if (style !== 'a' && style !== 't' && style !== 'n') {
      return runtimeError('nl', `invalid body numbering style: '${style}'`)
    }
    const widthText = flagText(parsed.flags, 'w')
    const width = widthText === null ? 6 : parseInteger(widthText)
    if (width === null || width < 1) {
      return runtimeError('nl', `invalid line number field width: '${widthText ?? ''}'`)
    }
    const separator = flagText(parsed.flags, 's') ?? '\t'
    const operands = parsed.operands.length > 0 ? parsed.operands : ['-']
    let text = ''
    let errors = ''
    let failed = false
    for (const operand of operands) {
      try {
        text += DECODER.decode(readInputBytes(ctx, operand))
      } catch (error) {
        errors += `nl: ${operand}: ${reasonOf(error)}\n`
        failed = true
      }
    }
    let number = 1
    const output = splitLines(text).map((line) => {
      const numbered = style === 'a' || (style === 't' && line !== '')
      if (!numbered) {
        return line
      }
      const prefix = String(number).padStart(width)
      number += 1
      return `${prefix}${separator}${line}`
    })
    return { code: failed ? 1 : 0, stdout: joinLines(output), stderr: errors }
  },
}

const revApplet: Applet = {
  name: 'rev',
  summary: '逐行反转字符顺序',
  summaryEn: 'Reverse the characters of each line',
  usage: 'rev [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, {})
    if (parsed.error) {
      return usageError('rev', parsed.error)
    }
    const gathered = gatherLines(ctx, parsed.operands, 'rev')
    const output = gathered.lines.map((line) => [...line].reverse().join(''))
    return {
      code: gathered.errors ? 1 : 0,
      stdout: joinLines(output),
      stderr: gathered.errors,
    }
  },
}

const tacApplet: Applet = {
  name: 'tac',
  summary: '按行倒序输出',
  summaryEn: 'Print lines in reverse order',
  usage: 'tac [-s SEPARATOR] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, { s: 'value' })
    if (parsed.error) {
      return usageError('tac', parsed.error)
    }
    const separator = flagText(parsed.flags, 's') ?? '\n'
    const gathered = gatherLines(ctx, parsed.operands, 'tac')
    if (separator === '\n') {
      return {
        code: gathered.errors ? 1 : 0,
        stdout: joinLines([...gathered.lines].reverse()),
        stderr: gathered.errors,
      }
    }
    const text = gathered.lines.join('\n')
    const parts = text.split(separator)
    if (parts.at(-1) === '') {
      parts.pop()
    }
    return {
      code: gathered.errors ? 1 : 0,
      stdout: parts.length > 0 ? `${parts.reverse().join(separator)}${separator}` : '',
      stderr: gathered.errors,
    }
  },
}

const pasteApplet: Applet = {
  name: 'paste',
  summary: '把多个文件按行并排拼接',
  summaryEn: 'Merge lines of files side by side',
  usage: 'paste [-d DELIMITER] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, { d: 'value' })
    if (parsed.error) {
      return usageError('paste', parsed.error)
    }
    const delimiters = parsePasteDelimiters(flagText(parsed.flags, 'd') ?? '\t')
    const operands = parsed.operands.length > 0 ? parsed.operands : ['-']
    const blocks: string[][] = []
    let errors = ''
    for (const operand of operands) {
      try {
        blocks.push(splitLines(DECODER.decode(readInputBytes(ctx, operand))))
      } catch (error) {
        errors += `paste: ${operand}: ${reasonOf(error)}\n`
        blocks.push([])
      }
    }
    if (blocks.length === 1) {
      return { code: errors ? 1 : 0, stdout: joinLines(blocks[0]), stderr: errors }
    }
    const output: string[] = []
    let delimiterIndex = 0
    const rows = Math.max(...blocks.map((block) => block.length))
    for (let row = 0; row < rows; row += 1) {
      let line = ''
      for (let column = 0; column < blocks.length; column += 1) {
        if (column > 0) {
          line += delimiters[delimiterIndex % delimiters.length]
          delimiterIndex += 1
        }
        line += blocks[column][row] ?? ''
      }
      output.push(line)
    }
    return { code: errors ? 1 : 0, stdout: joinLines(output), stderr: errors }
  },
}

/** paste -d 的分隔符表：支持 \t \n \\ \0 转义 */
const parsePasteDelimiters = (text: string): string[] => {
  const out: string[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char !== '\\') {
      out.push(char)
      index += 1
      continue
    }
    const next = text[index + 1]
    index += 2
    if (next === 't') {
      out.push('\t')
    } else if (next === 'n') {
      out.push('\n')
    } else if (next === '\\') {
      out.push('\\')
    } else if (next === '0') {
      out.push('')
    } else if (next === undefined) {
      out.push('\\')
    } else {
      out.push(next)
    }
  }
  return out.length > 0 ? out : ['']
}

// ---------- find ----------

type FindTest = { kind: 'name' | 'iname'; pattern: string } | { kind: 'type'; value: 'f' | 'd' }

type FindAction =
  | { kind: 'print' }
  | { kind: 'delete' }
  | { kind: 'exec'; words: string[]; batch: boolean }

type FindArgs = {
  paths: string[]
  tests: FindTest[]
  actions: FindAction[]
  maxdepth: number | null
  error?: string
}

/** glob → 正则：* ? [abc] [!abc] */
const globToRegExpSource = (pattern: string): string => {
  let source = ''
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      source += '[^/]*'
      continue
    }
    if (char === '?') {
      source += '[^/]'
      continue
    }
    if (char === '[') {
      const end = pattern.indexOf(']', index + 1)
      if (end > index + 1) {
        let body = pattern.slice(index + 1, end)
        if (body.startsWith('!') || body.startsWith('^')) {
          body = `^${body.slice(1)}`
        }
        source += `[${body.replace(/[\\\]]/g, '\\$&')}]`
        index = end
        continue
      }
    }
    source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return source
}

const globMatch = (pattern: string, target: string, ignoreCase: boolean): boolean => {
  try {
    return new RegExp(`^${globToRegExpSource(pattern)}$`, ignoreCase ? 'i' : '').test(target)
  } catch {
    return false
  }
}

const parseFindArgs = (argv: string[]): FindArgs => {
  const paths: string[] = []
  const tests: FindTest[] = []
  const actions: FindAction[] = []
  let maxdepth: number | null = null
  let index = 1
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '-name' || arg === '-iname') {
      const pattern = argv[index + 1]
      if (pattern === undefined) {
        return { paths, tests, actions, maxdepth, error: `missing argument to '${arg}'` }
      }
      tests.push({ kind: arg === '-name' ? 'name' : 'iname', pattern })
      index += 2
      continue
    }
    if (arg === '-type') {
      const value = argv[index + 1]
      if (value !== 'f' && value !== 'd') {
        return { paths, tests, actions, maxdepth, error: `unknown file type '${value ?? ''}'` }
      }
      tests.push({ kind: 'type', value })
      index += 2
      continue
    }
    if (arg === '-maxdepth') {
      const value = argv[index + 1]
      const depth = value === undefined ? null : parseInteger(value)
      if (depth === null || depth < 0) {
        return {
          paths,
          tests,
          actions,
          maxdepth,
          error: `invalid argument '${value ?? ''}' to -maxdepth`,
        }
      }
      maxdepth = depth
      index += 2
      continue
    }
    if (arg === '-print') {
      actions.push({ kind: 'print' })
      index += 1
      continue
    }
    if (arg === '-delete') {
      actions.push({ kind: 'delete' })
      index += 1
      continue
    }
    if (arg === '-exec') {
      const words: string[] = []
      let cursor = index + 1
      let terminator = ''
      while (cursor < argv.length) {
        const word = argv[cursor]
        if (word === ';' || word === '\\;' || word === '+') {
          terminator = word
          break
        }
        words.push(word)
        cursor += 1
      }
      if (terminator === '' || words.length === 0) {
        return { paths, tests, actions, maxdepth, error: "missing argument to '-exec'" }
      }
      actions.push({ kind: 'exec', words, batch: terminator === '+' })
      index = cursor + 1
      continue
    }
    if (arg !== '-' && arg.startsWith('-')) {
      return { paths, tests, actions, maxdepth, error: `unknown predicate '${arg}'` }
    }
    paths.push(arg)
    index += 1
  }
  return { paths, tests, actions, maxdepth }
}

type FindCandidate = { display: string; absolute: string; kind: 'file' | 'dir'; depth: number }

const findTestsPass = (tests: FindTest[], candidate: FindCandidate): boolean => {
  for (const test of tests) {
    if (test.kind === 'type') {
      const expected = test.value === 'f' ? 'file' : 'dir'
      if (expected !== candidate.kind) {
        return false
      }
      continue
    }
    const name =
      candidate.display === '.' || candidate.display === '..'
        ? candidate.display
        : baseName(candidate.display)
    const target = test.pattern.includes('/') ? candidate.display : name
    if (!globMatch(test.pattern, target, test.kind === 'iname')) {
      return false
    }
  }
  return true
}

/** find -exec ... + 的批量写法：把 {} 换成所有路径 */
const expandFindBatch = (words: string[], targets: string[]): string[] => {
  const output: string[] = []
  let placed = false
  for (const word of words) {
    if (!placed && word.includes('{}')) {
      output.push(...targets)
      placed = true
      continue
    }
    output.push(word)
  }
  if (!placed) {
    output.push(...targets)
  }
  return output
}

const findApplet: Applet = {
  name: 'find',
  summary: '按名字、类型、深度查找文件，可执行命令或删除',
  summaryEn: 'Search files by name, type and depth; run commands or delete',
  usage:
    'find [path...] [-name PATTERN] [-iname PATTERN] [-type f|d] [-maxdepth N] [-print] [-exec cmd {} ;] [-delete]',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    const parsed = parseFindArgs(ctx.argv)
    if (parsed.error !== undefined) {
      return runtimeError('find', parsed.error)
    }
    const startPaths = parsed.paths.length > 0 ? parsed.paths : ['.']
    const candidates: FindCandidate[] = []
    const matches: FindCandidate[] = []
    let errors = ''
    let status = 0
    for (const startPath of startPaths) {
      const absolute = resolvePath(ctx.cwd, startPath)
      const entry = statEntry(ctx, absolute)
      if (!entry) {
        errors += `find: '${startPath}': ${ERRNO_TEXT.ENOENT}\n`
        status = 1
        continue
      }
      const base = startPath === '/' ? '/' : startPath.replace(/\/+$/, '')
      candidates.push({ display: startPath, absolute, kind: entry.kind, depth: 0 })
      if (entry.kind === 'dir') {
        for (const child of ctx.fs.walk(absolute)) {
          const relative = absolute === '/' ? child.path : child.path.slice(absolute.length)
          const depth = relative.split('/').filter((segment) => segment !== '').length
          if (parsed.maxdepth !== null && depth > parsed.maxdepth) {
            continue
          }
          candidates.push({
            display: base === '/' ? child.path : `${base}${relative}`,
            absolute: child.path,
            kind: child.kind,
            depth,
          })
        }
      }
    }
    for (const candidate of candidates) {
      if (findTestsPass(parsed.tests, candidate)) {
        matches.push(candidate)
      }
    }
    const hasAction = parsed.actions.length > 0
    const deleteFirst = parsed.actions.some((action) => action.kind === 'delete')
    const ordered = deleteFirst
      ? [...matches].sort((left, right) => right.depth - left.depth)
      : matches
    const output: string[] = []
    for (const match of ordered) {
      for (const action of parsed.actions) {
        if (action.kind === 'print') {
          output.push(match.display)
          continue
        }
        if (action.kind === 'delete') {
          try {
            // 目录只有在子项已删空时才能删掉，跟 GNU -delete 一致
            ctx.fs.remove(match.absolute, false)
          } catch (error) {
            errors += `find: cannot delete '${match.display}': ${reasonOf(error)}\n`
            status = 1
          }
          continue
        }
        if (action.kind === 'exec' && !action.batch) {
          const words = action.words.map((word) => word.split('{}').join(match.display))
          const result = await ctx.shell.run(words.map(quoteWord).join(' '), {
            cwd: ctx.cwd,
            env: ctx.env,
            stdin: ctx.stdin,
            // 输出我这边收集后统一从 stdout 返回，别让引擎再实时渲染一遍
            silent: true,
          })
          if (result.stdout !== '') {
            output.push(...splitLines(result.stdout))
          }
          errors += result.stderr
          if (result.code !== 0) {
            status = 1
          }
        }
      }
      if (!hasAction) {
        output.push(match.display)
      }
    }
    for (const action of parsed.actions) {
      if (action.kind !== 'exec' || !action.batch) {
        continue
      }
      const words = expandFindBatch(
        action.words,
        matches.map((match) => match.display)
      )
      const result = await ctx.shell.run(words.map(quoteWord).join(' '), {
        cwd: ctx.cwd,
        env: ctx.env,
        stdin: ctx.stdin,
        silent: true,
      })
      if (result.stdout !== '') {
        output.push(...splitLines(result.stdout))
      }
      errors += result.stderr
      if (result.code !== 0) {
        status = 1
      }
    }
    return { code: status, stdout: joinLines(output), stderr: errors }
  },
}

// ---------- xargs ----------

const xargsApplet: Applet = {
  name: 'xargs',
  summary: '把标准输入拆成参数并执行命令',
  summaryEn: 'Build argument lists from stdin and run a command',
  usage: 'xargs [-n N] [-I REPL] [-0] [-r] [command [args...]]',
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    const parsed = parseArgs(ctx.argv, {
      n: 'value',
      I: 'value',
      '0': 'boolean',
      r: 'boolean',
    })
    if (parsed.error) {
      return usageError('xargs', parsed.error)
    }
    const command = parsed.operands.length > 0 ? parsed.operands : ['echo']
    const sizeText = flagText(parsed.flags, 'n')
    const size = sizeText === null ? null : parseInteger(sizeText)
    if (sizeText !== null && (size === null || size < 1)) {
      return usageError('xargs', `value for -n option should be >= 1`)
    }
    const replacement = flagText(parsed.flags, 'I')
    if (replacement !== null && replacement === '') {
      return usageError('xargs', 'replacement string cannot be empty')
    }
    const nullSeparated = flagOn(parsed.flags, '0')
    let items: string[]
    if (replacement !== null) {
      items = (nullSeparated ? ctx.stdin.split('\0') : ctx.stdin.split('\n'))
        .map((item) => item.trim())
        .filter((item) => item !== '')
    } else if (nullSeparated) {
      items = ctx.stdin.split('\0').filter((item) => item !== '')
    } else {
      items = ctx.stdin.split(/\s+/).filter((item) => item !== '')
    }
    const batches: string[][] = []
    if (replacement !== null) {
      for (const item of items) {
        batches.push([item])
      }
    } else {
      const step = size ?? Math.max(items.length, 1)
      for (let index = 0; index < items.length; index += step) {
        batches.push(items.slice(index, index + step))
      }
    }
    if (batches.length === 0 && !flagOn(parsed.flags, 'r')) {
      batches.push([])
    }
    let stdout = ''
    let stderr = ''
    let code = 0
    for (const batch of batches) {
      const words =
        replacement !== null
          ? command.map((word) => word.split(replacement).join(batch[0] ?? ''))
          : [...command, ...batch]
      const result = await ctx.shell.run(words.map(quoteWord).join(' '), {
        cwd: ctx.cwd,
        env: ctx.env,
        // xargs 的子进程标准输入是空的
        stdin: '',
        silent: true,
      })
      stdout += result.stdout
      stderr += result.stderr
      if (result.code !== 0) {
        code = 123
      }
    }
    return { code, stdout, stderr }
  },
}

// ---------- tee ----------

const teeApplet: Applet = {
  name: 'tee',
  summary: '把标准输入同时写到文件和屏幕',
  summaryEn: 'Copy stdin to files and stdout',
  usage: 'tee [-a] [file...]',
  run: (ctx: AppletContext): AppletResult => {
    const parsed = parseArgs(ctx.argv, { a: 'boolean' })
    if (parsed.error) {
      return usageError('tee', parsed.error)
    }
    const append = flagOn(parsed.flags, 'a')
    const text = ctx.stdin
    let errors = ''
    let status = 0
    for (const operand of parsed.operands) {
      const target = resolvePath(ctx.cwd, operand)
      try {
        if (append) {
          const previous = ctx.fs.readText(target) ?? ''
          ctx.fs.writeText(target, previous + text)
        } else {
          ctx.fs.writeText(target, text)
        }
      } catch (error) {
        errors += `tee: ${operand}: ${reasonOf(error)}\n`
        status = 1
      }
    }
    // tee 是透传：内容原样输出，不补换行
    return { code: status, stdout: text, stderr: errors }
  },
}

/** 文本处理类命令表 */
export const TEXT_APPLETS: Applet[] = [
  headApplet,
  tailApplet,
  grepApplet,
  sedApplet,
  awkApplet,
  sortApplet,
  uniqApplet,
  cutApplet,
  trApplet,
  wcApplet,
  nlApplet,
  revApplet,
  tacApplet,
  pasteApplet,
  findApplet,
  xargsApplet,
  teeApplet,
]
