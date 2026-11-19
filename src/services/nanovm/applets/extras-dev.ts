import type { Applet, AppletContext, AppletResult } from '../types.js'
import { ERRNO_TEXT, VmError } from '../types.js'
import type { FsEntry } from '../fs.js'
import { resolvePath } from '../fs.js'
import {
  fail,
  humanSize,
  interrupted,
  joinLines,
  ok,
  parseArgs,
  readInputBytes,
  splitLines,
  type ParsedArgs,
} from './helpers.js'

/**
 * 开发者工具补充命令。
 *
 * 这一组是写脚本 / 改文件时最常缺的一批：patch（unified diff）、bc（任意精度
 * 定点计算器）、expr（整数与字符串表达式）、tree / fmt / time / uuid / getopt /
 * tsort / envsubst / dotenv / sponge。全部直接跑在 VFS 上，不依赖任何外部进程：
 * 只有 time 会通过 ctx.shell.run 调子命令，其余都是纯 TypeScript 实现。
 *
 * 约定沿用 extras-text.ts / extras-data.ts：-h 或 --help 打印 usage 后退出 0；
 * 未知选项按 `<命令>: <错误>` 输出并退出 2；文件读写失败统一走
 * `<命令>: <路径>: No such file or directory` 并以 1 退出；长循环检查
 * interrupted，被 Ctrl+C / 超时打断时返回 130。
 *
 * 与 GNU 的取舍写在每个命令的注释里：能对齐的（bc 的 scale 规则、expr 的退出码、
 * getopt 的输出格式、patch 的 hunk 校验）都按 GNU 做；做不到的（patch 的 .rej
 * 文件、bc 的交互模式、time 的 user/sys 计时）在对应位置明确说明。
 */

// ---------- 共用小工具 ----------

/** 只有 `-h` / `--help` 单独出现时才当求助，和 extras-text.ts 一致 */
const wantsHelp = (argv: string[]): boolean =>
  argv.length === 2 && (argv[1] === '-h' || argv[1] === '--help')

/** 用法错误：退出码 2 */
const usageError = (command: string, message: string): AppletResult =>
  fail(`${command}: ${message}\n`, 2)

/** 运行期错误：默认退出码 1 */
const runtimeError = (command: string, message: string, code = 1): AppletResult =>
  fail(`${command}: ${message}\n`, code)

/** 把异常翻译成人读的原因（VmError 用 errno 文案） */
const describeError = (error: unknown): string => {
  if (error instanceof VmError) {
    return ERRNO_TEXT[error.code] ?? error.message
  }
  return error instanceof Error ? error.message : String(error)
}

/** 文件读取失败的统一文案：`<命令>: <路径>: No such file or directory` */
const fileError = (command: string, path: string, error: unknown): AppletResult =>
  fail(`${command}: ${path}: ${describeError(error)}\n`)

const flagOn = (flags: ParsedArgs['flags'], name: string): boolean => flags[name] === true

const flagText = (flags: ParsedArgs['flags'], name: string): string | null => {
  const value = flags[name]
  return typeof value === 'string' ? value : null
}

const DECODER = new TextDecoder()

/** 读一个操作数并解码；`-` 表示标准输入 */
const readTextOperand = (ctx: AppletContext, operand: string): string =>
  operand === '-' ? ctx.stdin : DECODER.decode(readInputBytes(ctx, operand))

/** 超时 / Ctrl+C 的统一返回码 */
const ABORTED: AppletResult = { code: 130 }

/** shell 里安全拼一个词（time 调子命令时用，和 text.ts 的 quoteWord 一致） */
const quoteWord = (word: string): string => {
  if (word === '') {
    return "''"
  }
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(word)) {
    return word
  }
  return `'${word.replace(/'/g, `'\\''`)}'`
}

// ---------- patch ----------

const patchUsage =
  'patch [-p N] [-i 补丁文件] [-R] [-N] [-f] [--dry-run] [目标文件]｜应用 unified diff（diff -u 的输出）'

/** hunk 里的一行：上下文 / 新增 / 删除 */
type HunkLine = { kind: ' ' | '+' | '-'; text: string }

type PatchHunk = {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  lines: HunkLine[]
  /** `\ No newline at end of file` 出现在旧 / 新一侧 */
  noNewlineOld: boolean
  noNewlineNew: boolean
}

type PatchSection = {
  oldPath: string
  newPath: string
  hunks: PatchHunk[]
}

/** 从 `--- a/x\t时间戳` 里取出路径；/dev/null 原样保留 */
const patchHeaderPath = (line: string): string => {
  const trimmed = line.trim()
  if (trimmed === '/dev/null') {
    return '/dev/null'
  }
  const tab = trimmed.indexOf('\t')
  return tab >= 0 ? trimmed.slice(0, tab).trim() : trimmed
}

/**
 * 解析 unified diff。结构不对（找不到文件头、@@ 写坏、行数对不上）返回 null，
 * 调用方统一报 `patch: **** malformed patch`。
 * 兼容 git diff 的 index / mode / rename 等扩展行，它们直接跳过。
 */
const parseUnifiedDiff = (text: string): PatchSection[] | null => {
  const raw = text.split('\n')
  const sections: PatchSection[] = []
  let current: PatchSection | null = null
  let index = 0
  const isFileHeader = (position: number): boolean =>
    raw[position]?.startsWith('--- ') === true && raw[position + 1]?.startsWith('+++ ') === true
  while (index < raw.length) {
    const line = raw[index]
    if (line === '' || line.startsWith('diff ')) {
      index += 1
      continue
    }
    // git diff 的扩展行（index / mode / similarity / rename）一律忽略
    if (
      /^(index |old mode |new mode |new file mode |deleted file mode |similarity index |rename )/.test(
        line
      )
    ) {
      index += 1
      continue
    }
    if (isFileHeader(index)) {
      current = {
        oldPath: patchHeaderPath(line.slice(4)),
        newPath: patchHeaderPath(raw[index + 1].slice(4)),
        hunks: [],
      }
      sections.push(current)
      index += 2
      continue
    }
    if (line.startsWith('@@')) {
      if (current === null) {
        return null
      }
      const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line)
      if (!match) {
        return null
      }
      const hunk: PatchHunk = {
        oldStart: Number(match[1]),
        oldCount: match[2] === undefined ? 1 : Number(match[2]),
        newStart: Number(match[3]),
        newCount: match[4] === undefined ? 1 : Number(match[4]),
        lines: [],
        noNewlineOld: false,
        noNewlineNew: false,
      }
      index += 1
      let oldSeen = 0
      let newSeen = 0
      let lastKind: HunkLine['kind'] | null = null
      while (index < raw.length) {
        const body = raw[index]
        if (body.startsWith('@@') || body.startsWith('diff ') || isFileHeader(index)) {
          break
        }
        if (body.startsWith('\\')) {
          // `\ No newline at end of file`：标记的是上一行所在的那一侧
          if (lastKind === '-' || lastKind === ' ') {
            hunk.noNewlineOld = true
          }
          if (lastKind === '+' || lastKind === ' ') {
            hunk.noNewlineNew = true
          }
          index += 1
          continue
        }
        if (oldSeen >= hunk.oldCount && newSeen >= hunk.newCount) {
          break
        }
        let kind: HunkLine['kind']
        let bodyText: string
        if (body === '') {
          // 有些工具会把只有空白的上下文行末尾空格删掉，这里按空上下文行对待
          kind = ' '
          bodyText = ''
        } else if (body[0] === ' ' || body[0] === '+' || body[0] === '-') {
          kind = body[0]
          bodyText = body.slice(1)
        } else {
          return null
        }
        hunk.lines.push({ kind, text: bodyText })
        if (kind !== '+') {
          oldSeen += 1
        }
        if (kind !== '-') {
          newSeen += 1
        }
        lastKind = kind
        index += 1
      }
      if (oldSeen !== hunk.oldCount || newSeen !== hunk.newCount) {
        return null
      }
      current.hunks.push(hunk)
      continue
    }
    // 其它内容（邮件签名、补丁说明）忽略
    index += 1
  }
  return sections.some((section) => section.hunks.length > 0) ? sections : null
}

/** 反向补丁：交换新旧两侧，并把 +/- 对调（-R 用） */
const reverseSection = (section: PatchSection): PatchSection => ({
  oldPath: section.newPath,
  newPath: section.oldPath,
  hunks: section.hunks.map((hunk) => ({
    oldStart: hunk.newStart,
    oldCount: hunk.newCount,
    newStart: hunk.oldStart,
    newCount: hunk.oldCount,
    lines: hunk.lines.map((line) => ({
      kind: line.kind === '+' ? '-' : line.kind === '-' ? '+' : ' ',
      text: line.text,
    })),
    noNewlineOld: hunk.noNewlineNew,
    noNewlineNew: hunk.noNewlineOld,
  })),
})

/** 按 -p 去掉路径前缀；/dev/null 不动，剥完为空返回 null */
const stripPathPrefix = (path: string, strip: number): string | null => {
  if (path === '/dev/null') {
    return path
  }
  if (strip === 0) {
    return path
  }
  const parts = path.split('/').filter((part) => part !== '')
  if (parts.length <= strip) {
    return null
  }
  return `${path.startsWith('/') ? '/' : ''}${parts.slice(strip).join('/')}`
}

const hunkTemplate = (hunk: PatchHunk): string[] =>
  hunk.lines.filter((line) => line.kind !== '+').map((line) => line.text)

const hunkReplacement = (hunk: PatchHunk): string[] =>
  hunk.lines.filter((line) => line.kind !== '-').map((line) => line.text)

const matchesAt = (lines: string[], position: number, template: string[]): boolean => {
  if (position < 0 || position + template.length > lines.length) {
    return false
  }
  for (let offset = 0; offset < template.length; offset += 1) {
    if (lines[position + offset] !== template[offset]) {
      return false
    }
  }
  return true
}

/**
 * 找 hunk 的落点：先在期望位置试，再向两侧各扩最多 2000 行。
 * GNU patch 是 fuzz + offset 搜索，这里只做 offset（不做上下文裁剪）。
 */
const findHunkPosition = (lines: string[], template: string[], expected: number): number => {
  const radius = Math.min(2000, lines.length)
  for (let delta = 0; delta <= radius; delta += 1) {
    const candidates = delta === 0 ? [expected] : [expected + delta, expected - delta]
    for (const candidate of candidates) {
      if (matchesAt(lines, candidate, template)) {
        return candidate
      }
    }
  }
  return -1
}

type HunkApplyOutcome = {
  text: string
  stdout: string
  stderr: string
  failed: number
}

/** 把一组 hunk 应用到文本上；失败的 hunk 跳过并继续后面的（GNU 行为） */
const applyHunks = (
  original: string,
  hunks: PatchHunk[],
  alreadyApplied: boolean,
  ctx: AppletContext
): HunkApplyOutcome => {
  const lines = splitLines(original)
  let shift = 0
  let output = ''
  let errors = ''
  let failed = 0
  let noNewline = false
  for (let index = 0; index < hunks.length; index += 1) {
    if ((index & 0xff) === 0 && interrupted(ctx)) {
      return { text: original, stdout: output, stderr: `${errors}patch: interrupted\n`, failed: -1 }
    }
    const hunk = hunks[index]
    const template = hunkTemplate(hunk)
    const expected = Math.max(0, hunk.oldStart - 1 + shift)
    let position = findHunkPosition(lines, template, expected)
    if (position < 0 && alreadyApplied) {
      // -N：新内容已经存在（反向能匹配）就把这个 hunk 当已应用跳过
      const reverseTemplate = hunk.lines
        .filter((line) => line.kind !== '-')
        .map((line) => line.text)
      if (findHunkPosition(lines, reverseTemplate, expected) >= 0) {
        errors += `Hunk #${index + 1} ignored (already applied)\n`
        continue
      }
    }
    if (position < 0) {
      failed += 1
      errors += `Hunk #${index + 1} FAILED at ${hunk.oldStart}.\n`
      continue
    }
    if (position !== expected) {
      output += `Hunk #${index + 1} succeeded at ${position + 1} (offset ${position - expected} lines).\n`
    }
    const replacement = hunkReplacement(hunk)
    lines.splice(position, template.length, ...replacement)
    shift += replacement.length - template.length
    noNewline = hunk.noNewlineNew
  }
  const text = lines.length === 0 ? '' : `${lines.join('\n')}${noNewline ? '' : '\n'}`
  return { text, stdout: output, stderr: errors, failed }
}

const patchApplet: Applet = {
  name: 'patch',
  summary: '应用 unified diff（diff -u 输出），支持 -p / -R / -N / --dry-run',
  summaryEn: 'Apply a unified diff to files in the virtual file system',
  usage: patchUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${patchUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {
      p: 'value',
      i: 'value',
      R: 'boolean',
      N: 'boolean',
      f: 'boolean',
      'dry-run': 'boolean',
    })
    if (parsed.error) {
      return usageError('patch', parsed.error)
    }
    let strip = 0
    const stripText = flagText(parsed.flags, 'p')
    if (stripText !== null) {
      if (!/^\d+$/.test(stripText.trim())) {
        return runtimeError('patch', `invalid -p option '${stripText}'`, 2)
      }
      strip = Number.parseInt(stripText, 10)
    }
    if (parsed.operands.length > 1) {
      return usageError('patch', `extra operand '${parsed.operands[1]}'`)
    }
    const target = parsed.operands[0]
    const patchFile = flagText(parsed.flags, 'i')
    let patchText = ctx.stdin
    if (patchFile !== null) {
      try {
        patchText = readTextOperand(ctx, patchFile)
      } catch (error) {
        return fileError('patch', patchFile, error)
      }
    }
    const parsedPatch = parseUnifiedDiff(patchText)
    if (parsedPatch === null) {
      return fail('patch: **** malformed patch\n')
    }
    // -R：先整体反向，后续逻辑只处理正向
    const sections = flagOn(parsed.flags, 'R')
      ? parsedPatch.map((section) => reverseSection(section))
      : parsedPatch
    // 指定目标文件时，把补丁里所有 hunk 都算到这一个文件上（GNU 也只用第一个文件）
    const jobs =
      target === undefined
        ? sections
        : [
            {
              oldPath: sections[0].oldPath,
              newPath: sections[0].newPath,
              hunks: sections.flatMap((section) => section.hunks),
            },
          ]
    const dryRun = flagOn(parsed.flags, 'dry-run')
    // -N 与 -f 同时给时以 -N 为准；-f 在 GNU 里是「不要问，直接做」，本 VM 没有交互提问
    const alreadyApplied = flagOn(parsed.flags, 'N')
    let stdout = ''
    let stderr = ''
    let failed = 0
    for (const job of jobs) {
      const creating = job.oldPath === '/dev/null' || job.hunks.every((hunk) => hunk.oldCount === 0)
      const rawDestination = job.newPath === '/dev/null' ? job.oldPath : job.newPath
      const sourcePath = target ?? stripPathPrefix(rawDestination, strip)
      if (sourcePath === null) {
        return runtimeError(
          'patch',
          `can't find file to patch at input line 1（-p${strip} 剥得太多）`
        )
      }
      const display = target ?? sourcePath
      const destination = resolvePath(ctx.cwd, sourcePath)
      let original = ''
      if (ctx.fs.exists(destination)) {
        try {
          original = readTextOperand(ctx, sourcePath)
        } catch (error) {
          return fileError('patch', display, error)
        }
      } else if (!creating) {
        return fail(`patch: ${display}: No such file or directory\n`)
      }
      const outcome = applyHunks(original, job.hunks, alreadyApplied, ctx)
      if (outcome.failed < 0) {
        return { code: 130, stdout, stderr: `${stderr}${outcome.stderr}` }
      }
      // 先报文件名，再报 offset / 失败信息，输出顺序和 GNU patch 一致
      stdout += dryRun ? `checking file ${display}\n` : `patching file ${display}\n`
      stdout += outcome.stdout
      stderr += outcome.stderr
      failed += outcome.failed
      if (!dryRun) {
        // 删除文件（+++ /dev/null）在 GNU 里会 unlink；VFS 没有删除语义，这里写成空文件
        const existing = ctx.fs.stat(destination)
        try {
          ctx.fs.writeText(destination, outcome.text, existing ? { mode: existing.mode } : {})
        } catch (error) {
          return fileError('patch', display, error)
        }
      }
    }
    if (failed > 0) {
      stderr += `patch: ${failed} 个 hunk 应用失败（本 VM 不生成 .rej 文件）\n`
    }
    return { code: failed > 0 ? 1 : 0, stdout, stderr }
  },
}

// ---------- bc ----------

const BC_MAX_SCALE = 1000

const bcUsage = 'bc [-l] [-q] [文件]｜任意精度十进制计算器，-l 载入数学函数（s/c/a/l/e）'

/** -l 载入的数学函数：sin / cos / atan / ln / exp */
const BC_MATH_FUNCTIONS = ['s', 'c', 'a', 'l', 'e']

/** bc 的数字：value = units / 10^scale，全程 BigInt 定点，不碰浮点 */
type BcValue = { units: bigint; scale: number }

type BcState = {
  scale: number
  ibase: number
  obase: number
  vars: Map<string, BcValue>
  mathLib: boolean
  halted: boolean
}

/** 计算 / 语法错误：错误行打印后继续处理下一行 */
class BcError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BcError'
  }
}

const bcPow10Cache: bigint[] = [1n]

/** 10^n；小指数走缓存，大指数直接求幂（避免缓存占掉整个大数组） */
const bcPow10 = (exponent: number): bigint => {
  if (exponent < 0) {
    throw new BcError('内部错误：负的十进制幂')
  }
  if (exponent > 4096) {
    return 10n ** BigInt(exponent)
  }
  while (bcPow10Cache.length <= exponent) {
    bcPow10Cache.push(bcPow10Cache[bcPow10Cache.length - 1] * 10n)
  }
  return bcPow10Cache[exponent]
}

/** 把 from 位小数的定点数换成 to 位（截断，向零取整） */
const bcRescale = (units: bigint, from: number, to: number): bigint => {
  if (from === to) {
    return units
  }
  return from > to ? units / bcPow10(from - to) : units * bcPow10(to - from)
}

const bcAdd = (left: BcValue, right: BcValue): BcValue => {
  const scale = Math.max(left.scale, right.scale)
  return {
    units: bcRescale(left.units, left.scale, scale) + bcRescale(right.units, right.scale, scale),
    scale,
  }
}

const bcSub = (left: BcValue, right: BcValue): BcValue => {
  const scale = Math.max(left.scale, right.scale)
  return {
    units: bcRescale(left.units, left.scale, scale) - bcRescale(right.units, right.scale, scale),
    scale,
  }
}

/** 乘法：scale = min(a.scale+b.scale, max(全局 scale, a.scale, b.scale))，GNU bc 规则 */
const bcMul = (left: BcValue, right: BcValue, globalScale: number): BcValue => {
  const rawScale = left.scale + right.scale
  const scale = Math.min(rawScale, Math.max(globalScale, left.scale, right.scale))
  return { units: bcRescale(left.units * right.units, rawScale, scale), scale }
}

/** 除法：结果取全局 scale，向零截断，GNU bc 规则 */
const bcDiv = (left: BcValue, right: BcValue, globalScale: number): BcValue => {
  if (right.units === 0n) {
    throw new BcError('Divide by zero')
  }
  const numerator = left.units * bcPow10(right.scale + globalScale)
  const denominator = right.units * bcPow10(left.scale)
  return { units: numerator / denominator, scale: globalScale }
}

const bcNeg = (value: BcValue): BcValue => ({ units: -value.units, scale: value.scale })

/**
 * 取模：GNU bc 内部按 a - (a/b)*b 算，且乘积保留完整精度（不走乘法截断规则），
 * 所以 scale=20 时 4.25 % 1.1 会得到 4e-21 而不是 0。
 */
const bcMod = (left: BcValue, right: BcValue, globalScale: number): BcValue => {
  const quotient = bcDiv(left, right, globalScale)
  const productScale = quotient.scale + right.scale
  const scale = Math.max(left.scale, productScale)
  const product = quotient.units * right.units
  return {
    units: bcRescale(left.units, left.scale, scale) - bcRescale(product, productScale, scale),
    scale,
  }
}

/**
 * 取整：bc 的整数参数（指数、scale/ibase/obase）必须是整数。
 * 带小数但小数位全 0（3.0）也接受。
 */
const bcToInteger = (value: BcValue): bigint => {
  if (value.scale === 0) {
    return value.units
  }
  const factor = bcPow10(value.scale)
  if (value.units % factor !== 0n) {
    throw new BcError('non-integer argument')
  }
  return value.units / factor
}

const BC_MAX_EXPONENT = 100000n

const bcPow = (base: BcValue, exponentValue: BcValue, globalScale: number): BcValue => {
  const exponent = bcToInteger(exponentValue)
  if (exponent > BC_MAX_EXPONENT || exponent < -BC_MAX_EXPONENT) {
    throw new BcError('exponent too large')
  }
  if (exponent === 0n) {
    return { units: 1n, scale: 0 }
  }
  const negative = exponent < 0n
  const power = negative ? -exponent : exponent
  // 用平方求幂，每一步保留精确 scale，最后再按 bc 规则截断
  let resultUnits = 1n
  let resultScale = 0
  let baseUnits = base.units
  let baseScale = base.scale
  let remaining = power
  while (remaining > 0n) {
    if (remaining & 1n) {
      resultUnits *= baseUnits
      resultScale += baseScale
    }
    remaining >>= 1n
    if (remaining > 0n) {
      baseUnits *= baseUnits
      baseScale += baseScale
    }
  }
  const targetScale = Math.min(resultScale, Math.max(globalScale, base.scale))
  const truncated = bcRescale(resultUnits, resultScale, targetScale)
  if (negative) {
    return bcDiv({ units: 1n, scale: 0 }, { units: truncated, scale: targetScale }, globalScale)
  }
  return { units: truncated, scale: targetScale }
}

/** 整数平方根（牛顿迭代），bc 的 sqrt 用 */
const bcIsqrt = (value: bigint): bigint => {
  if (value < 2n) {
    return value
  }
  let estimate = value
  let next = (estimate + 1n) / 2n
  while (next < estimate) {
    estimate = next
    next = (estimate + value / estimate) / 2n
  }
  return estimate
}

/** sqrt：结果 scale = max(全局 scale, 参数的 scale)，GNU bc 规则 */
const bcSqrt = (value: BcValue, globalScale: number): BcValue => {
  if (value.units < 0n) {
    throw new BcError('Square root of a negative number')
  }
  const scale = Math.max(globalScale, value.scale)
  const scaled = value.units * bcPow10(2 * scale + value.scale)
  return { units: bcIsqrt(scaled) / bcPow10(value.scale), scale }
}

/** 解析数字字面量：按 ibase 解释每位，小数位数就是结果 scale */
const bcParseLiteral = (text: string, ibase: number): BcValue => {
  const dot = text.indexOf('.')
  const integerText = dot < 0 ? text : text.slice(0, dot)
  const fractionText = dot < 0 ? '' : text.slice(dot + 1)
  let numerator = 0n
  for (const char of `${integerText}${fractionText}`) {
    let digit: number
    if (char >= '0' && char <= '9') {
      digit = char.charCodeAt(0) - 48
    } else if (char >= 'A' && char <= 'F') {
      digit = char.charCodeAt(0) - 55
    } else if (char >= 'a' && char <= 'f') {
      digit = char.charCodeAt(0) - 87
    } else {
      throw new BcError(`invalid number '${text}'`)
    }
    if (digit >= ibase) {
      throw new BcError(`digit ${char} 超出 ibase=${ibase} 的范围`)
    }
    numerator = numerator * BigInt(ibase) + BigInt(digit)
  }
  const scale = fractionText.length
  const denominator = BigInt(ibase) ** BigInt(scale)
  return { units: (numerator * bcPow10(scale)) / denominator, scale }
}

// ---------- bc 词的语法分析 ----------

type BcToken =
  | { kind: 'number'; text: string }
  | { kind: 'name'; text: string }
  | { kind: 'operator'; text: string }
  | { kind: 'end' }

// 和 GNU bc 一致：数字里大于 9 的位用大写 A–F，小写字母一律是变量 / 函数名
const bcIsDigitChar = (char: string): boolean =>
  (char >= '0' && char <= '9') || (char >= 'A' && char <= 'F') || char === '.'

const bcTokenize = (text: string): BcToken[] => {
  const tokens: BcToken[] = []
  let index = 0
  while (index < text.length) {
    const char = text[index]
    if (char === ' ' || char === '\t' || char === '\r') {
      index += 1
      continue
    }
    if (bcIsDigitChar(char) && (char !== '.' || bcIsDigitChar(text[index + 1] ?? ''))) {
      let end = index
      while (end < text.length && bcIsDigitChar(text[end])) {
        end += 1
      }
      tokens.push({ kind: 'number', text: text.slice(index, end) })
      index = end
      continue
    }
    if (/[A-Za-z_]/.test(char)) {
      let end = index + 1
      while (end < text.length && /[A-Za-z0-9_]/.test(text[end])) {
        end += 1
      }
      tokens.push({ kind: 'name', text: text.slice(index, end) })
      index = end
      continue
    }
    if ('+-*/%^()=,<>=!'.includes(char)) {
      // 只认单字符运算符；比较运算在 bc 里不是表达式语法，但留 == / <= 等给更清楚的报错
      tokens.push({ kind: 'operator', text: char })
      index += 1
      continue
    }
    if (char === ';' || char === '\n') {
      tokens.push({ kind: 'operator', text: ';' })
      index += 1
      continue
    }
    throw new BcError(`syntax error: 不认识的字符 '${char}'`)
  }
  tokens.push({ kind: 'end' })
  return tokens
}

/** 递归下降解析器；算符优先级按 bc：^ > 一元 +/- > * / % > + - */
class BcParser {
  private readonly tokens: BcToken[]
  private readonly state: BcState
  private index = 0

  constructor(tokens: BcToken[], state: BcState) {
    this.tokens = tokens
    this.state = state
  }

  peek(): BcToken {
    return this.tokens[this.index] ?? { kind: 'end' }
  }

  take(): BcToken {
    const token = this.peek()
    this.index += 1
    return token
  }

  expect(text: string): void {
    const token = this.take()
    if (token.kind !== 'operator' || token.text !== text) {
      throw new BcError(`syntax error: 期望 '${text}'`)
    }
  }

  atEnd(): boolean {
    return this.peek().kind === 'end'
  }

  private peekOperator(text: string): boolean {
    const token = this.peek()
    return token.kind === 'operator' && token.text === text
  }

  parseExpression(): BcValue {
    let value = this.parseTerm()
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'operator' || (token.text !== '+' && token.text !== '-')) {
        return value
      }
      this.index += 1
      const right = this.parseTerm()
      value = token.text === '+' ? bcAdd(value, right) : bcSub(value, right)
    }
  }

  private parseTerm(): BcValue {
    let value = this.parsePower()
    for (;;) {
      const token = this.peek()
      if (
        token.kind !== 'operator' ||
        (token.text !== '*' && token.text !== '/' && token.text !== '%')
      ) {
        return value
      }
      this.index += 1
      const right = this.parsePower()
      if (token.text === '*') {
        value = bcMul(value, right, this.state.scale)
      } else if (token.text === '/') {
        value = bcDiv(value, right, this.state.scale)
      } else {
        value = bcMod(value, right, this.state.scale)
      }
    }
  }

  /** 一元 +/- 比 ^ 先结合（GNU bc 里 -2^2 得到 4） */
  private parsePower(): BcValue {
    let sign = 1n
    for (;;) {
      const token = this.peek()
      if (token.kind !== 'operator' || (token.text !== '-' && token.text !== '+')) {
        break
      }
      if (token.text === '-') {
        sign = -sign
      }
      this.index += 1
    }
    let base = this.parsePrimary()
    if (sign < 0n) {
      base = bcNeg(base)
    }
    const token = this.peek()
    if (token.kind === 'operator' && token.text === '^') {
      this.index += 1
      const exponent = this.parsePower()
      return bcPow(base, exponent, this.state.scale)
    }
    return base
  }

  private parsePrimary(): BcValue {
    const token = this.take()
    if (token.kind === 'number') {
      return bcParseLiteral(token.text, this.state.ibase)
    }
    if (token.kind === 'name') {
      if (token.text === 'scale' || token.text === 'ibase' || token.text === 'obase') {
        const value = this.state[token.text]
        return { units: BigInt(value), scale: 0 }
      }
      const next = this.peek()
      if (next.kind === 'operator' && next.text === '(') {
        this.index += 1
        const args: BcValue[] = []
        if (!this.peekOperator(')')) {
          args.push(this.parseExpression())
          while (this.peekOperator(',')) {
            this.index += 1
            args.push(this.parseExpression())
          }
        }
        this.expect(')')
        return this.callFunction(token.text, args)
      }
      return this.state.vars.get(token.text) ?? { units: 0n, scale: 0 }
    }
    if (token.kind === 'operator' && token.text === '(') {
      const value = this.parseExpression()
      this.expect(')')
      return value
    }
    throw new BcError('syntax error')
  }

  private callFunction(name: string, args: BcValue[]): BcValue {
    if (name === 'sqrt') {
      if (args.length !== 1) {
        throw new BcError('sqrt 需要 1 个参数')
      }
      return bcSqrt(args[0], this.state.scale)
    }
    if (!this.state.mathLib) {
      throw new BcError(`未定义的函数 '${name}'（数学函数需要 -l）`)
    }
    if (!BC_MATH_FUNCTIONS.includes(name)) {
      throw new BcError(`未定义的函数 '${name}'`)
    }
    if (args.length !== 1) {
      throw new BcError(`${name} 需要 1 个参数`)
    }
    const work = this.state.scale + 12
    const units = bcFixedValue(args[0], work)
    let result: bigint
    switch (name) {
      case 's':
        result = bcFixedSinCos(units, work, false)
        break
      case 'c':
        result = bcFixedSinCos(units, work, true)
        break
      case 'a':
        result = bcFixedAtan(units, work)
        break
      case 'l':
        result = bcFixedLn(units, work)
        break
      default:
        result = bcFixedExp(units, work)
        break
    }
    return { units: bcRescale(result, work, this.state.scale), scale: this.state.scale }
  }
}

// ---------- bc 数学库（BigInt 定点） ----------

/** 把 BcValue 转成 work 位小数的纯 BigInt 定点数 */
const bcFixedValue = (value: BcValue, work: number): bigint =>
  bcRescale(value.units, value.scale, work)

const bcFixedMul = (left: bigint, right: bigint, work: number): bigint =>
  (left * right) / bcPow10(work)

const bcFixedDiv = (left: bigint, right: bigint, work: number): bigint => {
  if (right === 0n) {
    throw new BcError('Divide by zero')
  }
  return (left * bcPow10(work)) / right
}

/** atan(1/n) 的泰勒级数：1/n - 1/(3n^3) + 1/(5n^5) - ... */
const bcFixedAtanInv = (n: bigint, work: number): bigint => {
  const square = n * n
  let term = bcPow10(work) / n
  let sum = term
  let index = 1n
  while (term !== 0n && index < 100000n) {
    term /= square
    const part = term / (2n * index + 1n)
    if (part === 0n) {
      break
    }
    sum += index % 2n === 0n ? part : -part
    index += 1n
  }
  return sum
}

/** π 用 Machin 公式：π = 16·atan(1/5) − 4·atan(1/239) */
const bcFixedPi = (work: number): bigint =>
  16n * bcFixedAtanInv(5n, work) - 4n * bcFixedAtanInv(239n, work)

/** ln 2 = 2·atanh(1/3) */
const bcFixedLn2 = (work: number): bigint => {
  const third = bcPow10(work) / 3n
  return 2n * bcFixedAtanhSeries(third, work)
}

/** atanh(x) = x + x^3/3 + x^5/5 + ...，要求 |x| ≤ 1/3 */
const bcFixedAtanhSeries = (x: bigint, work: number): bigint => {
  const square = bcFixedMul(x, x, work)
  let term = x
  let sum = x
  let index = 1n
  while (term !== 0n && index < 100000n) {
    term = bcFixedMul(term, square, work)
    const part = term / (2n * index + 1n)
    if (part === 0n) {
      break
    }
    sum += part
    index += 1n
  }
  return sum
}

/** sin / cos 的泰勒级数；先把参数归约到 [-π, π] */
const bcFixedSinCos = (x: bigint, work: number, cosine: boolean): bigint => {
  const twoPi = 2n * bcFixedPi(work)
  let reduced = x % twoPi
  const pi = twoPi / 2n
  if (reduced > pi) {
    reduced -= twoPi
  } else if (reduced < -pi) {
    reduced += twoPi
  }
  const square = bcFixedMul(reduced, reduced, work)
  let term = cosine ? bcPow10(work) : reduced
  let sum = term
  let index = 1n
  while (term !== 0n && index < 100000n) {
    const factor = cosine ? (2n * index - 1n) * (2n * index) : 2n * index * (2n * index + 1n)
    term = -bcFixedMul(term, square, work) / factor
    if (term === 0n) {
      break
    }
    sum += term
    index += 1n
  }
  return sum
}

/** |x| ≤ 1 的 atan；0.5 以上先化成 π/4 + atan((x-1)/(x+1)) 加速收敛 */
const bcFixedAtanUnit = (x: bigint, work: number): bigint => {
  const one = bcPow10(work)
  if (x * 2n > one) {
    const reduced = bcFixedDiv(x - one, x + one, work)
    return bcFixedPi(work) / 4n + bcFixedAtanSeries(reduced, work)
  }
  return bcFixedAtanSeries(x, work)
}

/** atan(x) 的级数（|x| ≤ 0.5）：x - x^3/3 + x^5/5 - ... */
const bcFixedAtanSeries = (x: bigint, work: number): bigint => {
  const square = bcFixedMul(x, x, work)
  let term = x
  let sum = x
  let index = 1n
  while (term !== 0n && index < 100000n) {
    term = -bcFixedMul(term, square, work)
    const part = term / (2n * index + 1n)
    if (part === 0n) {
      break
    }
    sum += part
    index += 1n
  }
  return sum
}

const bcFixedAtan = (x: bigint, work: number): bigint => {
  const one = bcPow10(work)
  const negative = x < 0n
  const absolute = negative ? -x : x
  const result =
    absolute > one
      ? bcFixedPi(work) / 2n - bcFixedAtanUnit(bcFixedDiv(one, absolute, work), work)
      : bcFixedAtanUnit(absolute, work)
  return negative ? -result : result
}

/** e^x：负数取倒数，大参数先折半再平方回去 */
const bcFixedExp = (x: bigint, work: number): bigint => {
  const negative = x < 0n
  let value = negative ? -x : x
  let halvings = 0
  const limit = 20n * bcPow10(work)
  while (value > limit && halvings < 64) {
    value /= 2n
    halvings += 1
  }
  let term = bcPow10(work)
  let sum = term
  let index = 1n
  while (term !== 0n && index < 100000n) {
    term = bcFixedMul(term, value, work) / index
    if (term === 0n) {
      break
    }
    sum += term
    index += 1n
  }
  for (let step = 0; step < halvings; step += 1) {
    sum = bcFixedMul(sum, sum, work)
  }
  return negative ? bcFixedDiv(bcPow10(work), sum, work) : sum
}

/** ln(x)：先把 x 缩放到 [1,2)，再用 atanh 级数加 k·ln2 */
const bcFixedLn = (x: bigint, work: number): bigint => {
  if (x <= 0n) {
    throw new BcError('ln of non-positive number')
  }
  const one = bcPow10(work)
  let mantissa = x
  let exponent = 0n
  while (mantissa >= 2n * one) {
    mantissa /= 2n
    exponent += 1n
  }
  while (mantissa < one) {
    mantissa *= 2n
    exponent -= 1n
  }
  const reduced = bcFixedDiv(mantissa - one, mantissa + one, work)
  return 2n * bcFixedAtanhSeries(reduced, work) + exponent * bcFixedLn2(work)
}

/** 按 GNU bc 的规则打印：整数部分省掉前导 0，小数位数跟随 scale */
const bcFormat = (value: BcValue, obase: number): string => {
  if (value.units === 0n) {
    return '0'
  }
  const negative = value.units < 0n
  const absolute = negative ? -value.units : value.units
  const digits = absolute.toString().padStart(value.scale + 1, '0')
  const integerDigits = value.scale === 0 ? digits : digits.slice(0, digits.length - value.scale)
  const fractionDigits = value.scale === 0 ? '' : digits.slice(digits.length - value.scale)
  const sign = negative ? '-' : ''
  if (obase === 10) {
    if (value.scale === 0) {
      return `${sign}${integerDigits}`
    }
    return `${sign}${integerDigits === '0' ? '' : integerDigits}.${fractionDigits}`
  }
  const integerText = BigInt(integerDigits).toString(obase).toUpperCase()
  if (value.scale === 0) {
    return `${sign}${integerText}`
  }
  // 非十进制的小数位数按精度换算：ceil(scale·log(10)/log(obase))，与 GNU bc 一致
  const fractionCount = Math.ceil((value.scale * Math.log(10)) / Math.log(obase) - 1e-12)
  let remainder = BigInt(fractionDigits)
  let fractionText = ''
  for (let index = 0; index < fractionCount; index += 1) {
    remainder *= BigInt(obase)
    fractionText += (remainder / bcPow10(value.scale)).toString(obase).toUpperCase()
    remainder %= bcPow10(value.scale)
  }
  // 整数部分为 0 时省掉前导 0（GNU bc 输出 `.80` 而不是 `0.80`）
  const integerPrefix = integerDigits === '0' ? '' : integerText
  return `${sign}${integerPrefix}.${fractionText}`
}

/** 执行一条语句；返回要打印的文本，赋值语句返回 null */
const bcExecuteStatement = (text: string, state: BcState): string | null => {
  const statement = text.trim()
  if (statement === '') {
    return null
  }
  const tokens = bcTokenize(statement)
  if (tokens[0].kind === 'name' && tokens[0].text === 'quit') {
    state.halted = true
    return null
  }
  // 赋值：name = expr（scale / ibase / obase 是内建变量）
  if (
    tokens[0].kind === 'name' &&
    tokens[1].kind === 'operator' &&
    tokens[1].text === '=' &&
    tokens.length > 2
  ) {
    const parser = new BcParser(tokens.slice(2), state)
    const value = parser.parseExpression()
    if (!parser.atEnd()) {
      throw new BcError('syntax error')
    }
    const name = tokens[0].text
    if (name === 'scale' || name === 'ibase' || name === 'obase') {
      const integer = bcToInteger(value)
      if (name === 'scale') {
        if (integer < 0n || integer > BigInt(BC_MAX_SCALE)) {
          throw new BcError(`scale 超出范围（0–${BC_MAX_SCALE}）`)
        }
        state.scale = Number(integer)
      } else {
        if (integer < 2n || integer > 16n) {
          throw new BcError(`${name} 超出范围（2–16）`)
        }
        state[name] = Number(integer)
      }
      return null
    }
    state.vars.set(name, value)
    return null
  }
  const parser = new BcParser(tokens, state)
  const value = parser.parseExpression()
  if (!parser.atEnd()) {
    throw new BcError('syntax error')
  }
  return bcFormat(value, state.obase)
}

const bcRun = (ctx: AppletContext, text: string, state: BcState): AppletResult => {
  let stdout = ''
  let stderr = ''
  let code = 0
  for (const line of text.split('\n')) {
    if (state.halted) {
      break
    }
    if (interrupted(ctx)) {
      return { code: 130, stdout, stderr: `${stderr}bc: interrupted\n` }
    }
    for (const statement of line.split(';')) {
      if (state.halted) {
        break
      }
      try {
        const printed = bcExecuteStatement(statement, state)
        if (printed !== null) {
          stdout += `${printed}\n`
        }
      } catch (error) {
        // 和 GNU bc 一样：错误行报错后继续处理下一行，不中断整个会话
        const message = error instanceof Error ? error.message : String(error)
        stderr += `bc: ${message}\n`
        break
      }
    }
  }
  return { code, stdout, stderr }
}

const bcApplet: Applet = {
  name: 'bc',
  summary: '任意精度十进制计算器，-l 载入 s/c/a/l/e 数学函数',
  summaryEn: 'Arbitrary precision decimal calculator with BigInt fixed-point math',
  usage: bcUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${bcUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { l: 'boolean', q: 'boolean' })
    if (parsed.error) {
      return usageError('bc', parsed.error)
    }
    if (parsed.operands.length > 1) {
      return usageError('bc', `extra operand '${parsed.operands[1]}'`)
    }
    const state: BcState = {
      scale: 0,
      ibase: 10,
      obase: 10,
      vars: new Map<string, BcValue>(),
      mathLib: flagOn(parsed.flags, 'l'),
      halted: false,
    }
    if (state.mathLib) {
      // GNU bc -l 默认 scale=20
      state.scale = 20
    }
    let text = ctx.stdin
    const file = parsed.operands[0]
    if (file !== undefined) {
      try {
        text = file === '-' ? ctx.stdin : DECODER.decode(readInputBytes(ctx, file))
      } catch (error) {
        return fileError('bc', file, error)
      }
    }
    return bcRun(ctx, text, state)
  },
}

// ---------- expr ----------

const exprUsage = 'expr 表达式...｜整数运算、比较、逻辑、字符串匹配；结果为 0 或空串时退出 1'

/** expr 的表达式错误：GNU 用退出码 2 表示用法 / 运算错误 */
class ExprError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExprError'
  }
}

const EXPR_COMPARISONS = ['=', '!=', '<', '<=', '>', '>=']

/** 结果既不是空串也不是 0：GNU 用它决定退出码 */
const exprIsZero = (text: string): boolean => {
  if (text === '' || text === '0') {
    return true
  }
  if (!/^[+-]?\d+$/.test(text)) {
    return false
  }
  return BigInt(text) === 0n
}

/** 算术语义要求整数操作数 */
const exprInteger = (text: string): bigint => {
  if (!/^[+-]?\d+$/.test(text.trim())) {
    throw new ExprError('non-integer argument')
  }
  return BigInt(text.trim())
}

/** BRE 的 `\(` `\)` 在 JS 正则里就是分组；其它 BRE 写法不额外转换 */
const exprBreToJs = (pattern: string): string => pattern.replace(/\\\(/g, '(').replace(/\\\)/g, ')')

type ExprValue = { text: string }

/**
 * expr 的递归下降解析器。优先级（低 → 高）：
 * `|` < `&` < 比较 < `+ -` < `* / %` < `:` < 一元 +/- < primary。
 * 和 GNU 一样，`(` `)` 作为独立参数可以分组。
 */
class ExprParser {
  private readonly tokens: string[]
  private index = 0

  constructor(tokens: string[]) {
    this.tokens = tokens
  }

  private peek(): string | undefined {
    return this.tokens[this.index]
  }

  private take(): string {
    const token = this.tokens[this.index]
    if (token === undefined) {
      throw new ExprError('syntax error')
    }
    this.index += 1
    return token
  }

  private expect(token: string): void {
    if (this.peek() !== token) {
      throw new ExprError('syntax error')
    }
    this.index += 1
  }

  parse(): ExprValue {
    const value = this.parseOr()
    if (this.index < this.tokens.length) {
      throw new ExprError('syntax error')
    }
    return value
  }

  private parseOr(): ExprValue {
    let value = this.parseAnd()
    while (this.peek() === '|') {
      this.index += 1
      const right = this.parseAnd()
      value = exprIsZero(value.text) ? right : value
    }
    return value
  }

  private parseAnd(): ExprValue {
    let value = this.parseComparison()
    while (this.peek() === '&') {
      this.index += 1
      const right = this.parseComparison()
      value = { text: !exprIsZero(value.text) && !exprIsZero(right.text) ? value.text : '0' }
    }
    return value
  }

  private parseComparison(): ExprValue {
    let value = this.parseAdditive()
    for (;;) {
      const token = this.peek()
      if (token === undefined || !EXPR_COMPARISONS.includes(token)) {
        return value
      }
      this.index += 1
      const right = this.parseAdditive()
      const bothInteger =
        /^[+-]?\d+$/.test(value.text.trim()) && /^[+-]?\d+$/.test(right.text.trim())
      let result: number
      if (bothInteger) {
        const leftNumber = exprInteger(value.text)
        const rightNumber = exprInteger(right.text)
        result = leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1
      } else {
        result = value.text === right.text ? 0 : value.text < right.text ? -1 : 1
      }
      const matched =
        token === '='
          ? result === 0
          : token === '!='
            ? result !== 0
            : token === '<'
              ? result < 0
              : token === '<='
                ? result <= 0
                : token === '>'
                  ? result > 0
                  : result >= 0
      value = { text: matched ? '1' : '0' }
    }
  }

  private parseAdditive(): ExprValue {
    let value = this.parseMultiplicative()
    for (;;) {
      const token = this.peek()
      if (token !== '+' && token !== '-') {
        return value
      }
      this.index += 1
      const right = this.parseMultiplicative()
      const leftNumber = exprInteger(value.text)
      const rightNumber = exprInteger(right.text)
      value = {
        text: (token === '+' ? leftNumber + rightNumber : leftNumber - rightNumber).toString(),
      }
    }
  }

  private parseMultiplicative(): ExprValue {
    let value = this.parseMatch()
    for (;;) {
      const token = this.peek()
      if (token !== '*' && token !== '/' && token !== '%') {
        return value
      }
      this.index += 1
      const right = this.parseMatch()
      const leftNumber = exprInteger(value.text)
      const rightNumber = exprInteger(right.text)
      if ((token === '/' || token === '%') && rightNumber === 0n) {
        throw new ExprError('division by zero')
      }
      const result =
        token === '*'
          ? leftNumber * rightNumber
          : token === '/'
            ? leftNumber / rightNumber
            : leftNumber % rightNumber
      value = { text: result.toString() }
    }
  }

  private parseMatch(): ExprValue {
    let value = this.parseUnary()
    while (this.peek() === ':') {
      this.index += 1
      const pattern = this.parseUnary()
      value = exprMatch(value.text, pattern.text)
    }
    return value
  }

  private parseUnary(): ExprValue {
    const token = this.peek()
    if (token === '+') {
      this.index += 1
      return this.parseUnary()
    }
    if (token === '-') {
      this.index += 1
      const value = this.parseUnary()
      return { text: (-exprInteger(value.text)).toString() }
    }
    return this.parsePrimary()
  }

  private parsePrimary(): ExprValue {
    const token = this.take()
    if (token === '(') {
      const value = this.parseOr()
      this.expect(')')
      return value
    }
    if (token === ')') {
      throw new ExprError('syntax error')
    }
    if (token === 'length') {
      return { text: String([...this.parseUnary().text].length) }
    }
    if (token === 'substr') {
      const text = [...this.parseUnary().text]
      const position = exprInteger(this.parseUnary().text)
      const length = exprInteger(this.parseUnary().text)
      // GNU 语义：POSITION < 1、超出字符串或 LENGTH < 1 都返回空串
      const start = Number(position - 1n)
      if (position < 1n || length < 1n || start >= text.length) {
        return { text: '' }
      }
      return { text: text.slice(start, start + Number(length)).join('') }
    }
    if (token === 'index') {
      const text = this.parseUnary().text
      const charset = this.parseUnary().text
      for (let index = 0; index < text.length; index += 1) {
        if (charset.includes(text[index])) {
          return { text: String(index + 1) }
        }
      }
      return { text: '0' }
    }
    return { text: token }
  }
}

/** `:` 运算：BRE 从字符串开头匹配；有分组返回分组内容，否则返回匹配长度 */
const exprMatch = (text: string, pattern: string): ExprValue => {
  let regex: RegExp
  try {
    regex = new RegExp(`^${exprBreToJs(pattern)}`)
  } catch {
    throw new ExprError('Invalid regular expression')
  }
  const matched = regex.exec(text)
  const hasGroup = /\\\(/.test(pattern)
  if (!matched) {
    return { text: hasGroup ? '' : '0' }
  }
  if (hasGroup) {
    return { text: matched[1] ?? '' }
  }
  return { text: String(matched[0].length) }
}

const exprApplet: Applet = {
  name: 'expr',
  summary: '整数表达式求值：算术、比较、逻辑与字符串匹配（结果为 0 / 空串时退出 1）',
  summaryEn: 'Evaluate integer, comparison, logic and string expressions',
  usage: exprUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${exprUsage}\n`)
    }
    let words = ctx.argv.slice(1)
    if (words[0] === '--') {
      words = words.slice(1)
    }
    if (words.length === 0) {
      return usageError('expr', 'missing operand')
    }
    // 和 GNU expr 一样接受负数参数（`expr -1 + 2`），其余未知的 -x 当选项错误
    for (const word of words) {
      if (/^-{1,2}[A-Za-z]/.test(word)) {
        return usageError('expr', `unrecognized option '${word}'`)
      }
    }
    try {
      const value = new ExprParser(words).parse()
      return { code: exprIsZero(value.text) ? 1 : 0, stdout: `${value.text}\n` }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return fail(`expr: ${message}\n`, 2)
    }
  },
}

// ---------- tree ----------

const treeUsage =
  'tree [-a] [-d] [-L 深度] [-f] [-s] [-h] [目录]｜-a 含隐藏、-d 只目录、-L 限深、-f 全路径、-s 字节、-h 人类可读（-h 单独出现是帮助）'

type TreeOptions = {
  all: boolean
  dirsOnly: boolean
  maxDepth: number
  fullPath: boolean
  bytes: boolean
  human: boolean
}

type TreeWalk = {
  lines: string[]
  directories: number
  files: number
  aborted: boolean
}

/** 条目大小前缀：-s 用字节、-h 用人类可读；都没有就不占列 */
const treeSizePrefix = (entry: FsEntry, options: TreeOptions): string => {
  if (options.human) {
    return `[${humanSize(entry.size).padStart(8)}]  `
  }
  if (options.bytes) {
    return `[${String(entry.size).padStart(10)}]  `
  }
  return ''
}

const walkTree = (
  ctx: AppletContext,
  directory: string,
  prefix: string,
  depth: number,
  options: TreeOptions
): TreeWalk => {
  const entries = ctx.fs.readdir(directory, { all: true })
  const visible = entries.filter(
    (entry) =>
      (options.all || !entry.name.startsWith('.')) && (!options.dirsOnly || entry.kind === 'dir')
  )
  const result: TreeWalk = { lines: [], directories: 0, files: 0, aborted: false }
  for (let index = 0; index < visible.length; index += 1) {
    if ((index & 0x3f) === 0 && interrupted(ctx)) {
      result.aborted = true
      return result
    }
    const entry = visible[index]
    const last = index === visible.length - 1
    const label = options.fullPath ? entry.path : entry.name
    result.lines.push(`${prefix}${last ? '└── ' : '├── '}${treeSizePrefix(entry, options)}${label}`)
    if (entry.kind === 'dir') {
      result.directories += 1
      if (depth < options.maxDepth) {
        const child = walkTree(
          ctx,
          entry.path,
          `${prefix}${last ? '    ' : '│   '}`,
          depth + 1,
          options
        )
        result.lines.push(...child.lines)
        result.directories += child.directories
        result.files += child.files
        if (child.aborted) {
          result.aborted = true
          return result
        }
      }
    } else {
      result.files += 1
    }
  }
  return result
}

/** GNU tree 的单复数：1 directory / 2 directories */
const treeCount = (count: number, singular: string, plural: string): string =>
  `${count} ${count === 1 ? singular : plural}`

const treeApplet: Applet = {
  name: 'tree',
  summary: '树形列出目录；-a 隐藏、-d 只目录、-L 限深、-f 全路径、-s / -h 显示大小',
  summaryEn: 'List directory contents in a tree, with optional sizes and depth limit',
  usage: treeUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${treeUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {
      a: 'boolean',
      d: 'boolean',
      L: 'value',
      f: 'boolean',
      s: 'boolean',
      h: 'boolean',
    })
    if (parsed.error) {
      return usageError('tree', parsed.error)
    }
    if (parsed.operands.length > 1) {
      return usageError('tree', `extra operand '${parsed.operands[1]}'`)
    }
    let maxDepth = Number.POSITIVE_INFINITY
    const depthText = flagText(parsed.flags, 'L')
    if (depthText !== null) {
      if (!/^\d+$/.test(depthText.trim()) || Number(depthText) < 1) {
        return runtimeError('tree', `invalid level '${depthText}'（必须是正整数）`)
      }
      maxDepth = Number(depthText)
    }
    const display = parsed.operands[0] ?? '.'
    const target = resolvePath(ctx.cwd, display)
    const stat = ctx.fs.stat(target)
    if (!stat) {
      return fail(`tree: ${display}: No such file or directory\n`)
    }
    const options: TreeOptions = {
      all: flagOn(parsed.flags, 'a'),
      dirsOnly: flagOn(parsed.flags, 'd'),
      maxDepth,
      fullPath: flagOn(parsed.flags, 'f'),
      bytes: flagOn(parsed.flags, 's'),
      human: flagOn(parsed.flags, 'h'),
    }
    if (stat.kind === 'file') {
      const files = options.dirsOnly ? 0 : 1
      const summary = `${treeCount(0, 'directory', 'directories')}, ${treeCount(files, 'file', 'files')}`
      // -d 对文件没有可列的内容，只打摘要；普通模式先打文件名
      return ok(options.dirsOnly ? `${summary}\n` : `${display}\n\n${summary}\n`)
    }
    let walk: TreeWalk
    try {
      walk = walkTree(ctx, target, '', 1, options)
    } catch (error) {
      return fileError('tree', display, error)
    }
    if (walk.aborted) {
      return { code: 130, stderr: 'tree: interrupted\n' }
    }
    const summary = `${treeCount(walk.directories, 'directory', 'directories')}, ${treeCount(walk.files, 'file', 'files')}`
    const body = walk.lines.length > 0 ? `${walk.lines.join('\n')}\n` : ''
    return ok(`${display}\n${body}\n${summary}\n`)
  },
}

// ---------- fmt ----------

const fmtUsage = 'fmt [-w 宽度] [-s] [-u] [文件...]｜默认 75 列；-s 只拆长行、-u 只合并不拆'

/**
 * 把一段词按宽度折行。GNU fmt 的缩进规则：第一行用段落首行缩进，
 * 续行用段落第二行的缩进（单行段落就用首行缩进）。
 */
const fmtWrapWords = (
  words: string[],
  width: number,
  firstIndent: string,
  restIndent: string
): string[] => {
  if (words.length === 0) {
    return []
  }
  const lines: string[] = []
  let indent = firstIndent
  let current = indent
  for (const word of words) {
    if (current.trim() === '') {
      current += word
      continue
    }
    if (current.length + 1 + word.length <= width) {
      current += ` ${word}`
    } else {
      lines.push(current)
      indent = restIndent
      current = `${indent}${word}`
    }
  }
  if (current !== '') {
    lines.push(current)
  }
  return lines
}

/** -s：每行单独折；-u：段落合成一行；都不给：合并后重排 */
const fmtFormat = (text: string, width: number, splitOnly: boolean, uniteOnly: boolean): string => {
  const raw = text.split('\n')
  if (raw.at(-1) === '') {
    raw.pop()
  }
  const output: string[] = []
  let paragraph: string[] = []
  const flush = (): void => {
    if (paragraph.length === 0) {
      return
    }
    const firstMatch = /^[ \t]*/.exec(paragraph[0])
    const firstIndent = firstMatch === null ? '' : firstMatch[0]
    const secondLine = paragraph[1]
    const secondMatch = secondLine === undefined ? null : /^[ \t]*/.exec(secondLine)
    const restIndent = secondMatch === null ? firstIndent : secondMatch[0]
    const words = paragraph
      .map((line) => line.trim())
      .filter((line) => line !== '')
      .flatMap((line) => line.split(/\s+/))
    if (uniteOnly) {
      output.push(`${firstIndent}${words.join(' ')}`)
    } else {
      output.push(...fmtWrapWords(words, width, firstIndent, restIndent))
    }
    paragraph = []
  }
  for (const line of raw) {
    if (line.trim() === '') {
      flush()
      output.push('')
      continue
    }
    if (splitOnly && uniteOnly) {
      // 两个开关互相矛盾：保持原样，不做任何重排
      output.push(line)
      continue
    }
    if (splitOnly) {
      const indentMatch = /^[ \t]*/.exec(line)
      const indent = indentMatch === null ? '' : indentMatch[0]
      output.push(...fmtWrapWords(line.trim().split(/\s+/), width, indent, indent))
      continue
    }
    paragraph.push(line)
  }
  flush()
  return joinLines(output)
}

const fmtApplet: Applet = {
  name: 'fmt',
  summary: '把段落重排到指定宽度（默认 75），-s 只拆分、-u 只合并',
  summaryEn: 'Reflow paragraphs to a given width; -s split only, -u join only',
  usage: fmtUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${fmtUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { w: 'value', s: 'boolean', u: 'boolean' })
    if (parsed.error) {
      return usageError('fmt', parsed.error)
    }
    let width = 75
    const widthText = flagText(parsed.flags, 'w')
    if (widthText !== null) {
      if (!/^\d+$/.test(widthText.trim()) || Number(widthText) < 1) {
        return runtimeError('fmt', `invalid width '${widthText}'`)
      }
      width = Number(widthText)
    }
    const sources = parsed.operands.length > 0 ? parsed.operands : ['-']
    let output = ''
    let errors = ''
    for (const source of sources) {
      let text: string
      try {
        text = readTextOperand(ctx, source)
      } catch (error) {
        errors += `fmt: ${source}: ${describeError(error)}\n`
        continue
      }
      if (interrupted(ctx)) {
        return { code: 130, stdout: output, stderr: `${errors}fmt: interrupted\n` }
      }
      output += fmtFormat(text, width, flagOn(parsed.flags, 's'), flagOn(parsed.flags, 'u'))
    }
    return { code: errors === '' ? 0 : 1, stdout: output, stderr: errors }
  },
}

// ---------- time ----------

const timeUsage = 'time [-p] 命令 [参数...]｜统计子命令的实际耗时（real / user / sys）'

/** 秒数转 `0m1.23s`（默认格式）或 `1.23`（POSIX -p） */
const timeFormat = (seconds: number, posix: boolean): string => {
  if (posix) {
    return seconds.toFixed(2)
  }
  const minutes = Math.floor(seconds / 60)
  const rest = seconds - minutes * 60
  return `${minutes}m${rest.toFixed(2)}s`
}

const timeApplet: Applet = {
  name: 'time',
  summary: '执行子命令并统计实际耗时；-p 输出 POSIX 格式',
  summaryEn: 'Run a command and report elapsed real / user / sys time',
  usage: timeUsage,
  run: async (ctx: AppletContext): Promise<AppletResult> => {
    let index = 1
    let posix = false
    while (index < ctx.argv.length) {
      const argument = ctx.argv[index]
      if (argument === '--') {
        index += 1
        break
      }
      if (argument === '-p' || argument === '--portability') {
        posix = true
        index += 1
        continue
      }
      if (argument === '-h' || argument === '--help') {
        return ok(`${timeUsage}\n`)
      }
      if (argument.startsWith('-') && argument !== '-') {
        return usageError('time', `unrecognized option '${argument}'`)
      }
      break
    }
    const words = ctx.argv.slice(index)
    if (words.length === 0) {
      return usageError('time', 'missing operand')
    }
    const line = words.map((word) => quoteWord(word)).join(' ')
    const started = performance.now()
    let result
    try {
      result = await ctx.shell.run(line, {
        cwd: ctx.cwd,
        env: ctx.env,
        stdin: ctx.stdin,
        // 输出由 time 自己转发，避免引擎再实时渲染一遍
        silent: true,
      })
    } catch (error) {
      return fail(`time: ${describeError(error)}\n`)
    }
    const elapsed = Math.max(0, performance.now() - started) / 1000
    // VM 里没有单独的 CPU 计时：把实际耗时都算到 user，sys 恒为 0
    const stats = posix
      ? `real ${timeFormat(elapsed, true)}\nuser ${timeFormat(elapsed, true)}\nsys ${timeFormat(0, true)}\n`
      : `real\t${timeFormat(elapsed, false)}\nuser\t${timeFormat(elapsed, false)}\nsys\t${timeFormat(0, false)}\n`
    const output: AppletResult = {
      code: result.code,
      stderr: `${stats}${result.stderr}`,
    }
    if (result.stdout) {
      output.stdout = result.stdout
    }
    if (result.install) {
      output.install = result.install
    }
    return output
  },
}

// ---------- uuid ----------

const uuidUsage = 'uuid [-n 数量] [-v4] [-u]｜生成 UUID v4，默认一条'

/** 用 crypto.getRandomValues 生成一条 UUID v4 */
const uuidV4 = (): string => {
  const bytes = new Uint8Array(16)
  globalThis.crypto.getRandomValues(bytes)
  // version 4 与 RFC 4122 的 variant 位
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  let hex = ''
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, '0')
  }
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const uuidApplet: Applet = {
  name: 'uuid',
  summary: '生成 UUID v4，-n 指定条数，-u 输出大写',
  summaryEn: 'Generate version 4 UUIDs; -n count, -u uppercase',
  usage: uuidUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${uuidUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { n: 'value', u: 'boolean', v4: 'boolean', v: 'value' })
    if (parsed.error) {
      return usageError('uuid', parsed.error)
    }
    let count = 1
    const countText = flagText(parsed.flags, 'n')
    if (countText !== null) {
      if (!/^\d+$/.test(countText.trim()) || Number(countText) < 1) {
        return usageError('uuid', `invalid count '${countText}'`)
      }
      count = Number(countText)
      if (count > 100000) {
        return usageError('uuid', `count ${count} 太大（上限 100000）`)
      }
    }
    const version = flagText(parsed.flags, 'v')
    if (version !== null && version !== '4') {
      return usageError('uuid', `unsupported version '${version}'（只支持 4）`)
    }
    if (typeof globalThis.crypto?.getRandomValues !== 'function') {
      return fail('uuid: 当前环境不可用 crypto.getRandomValues\n')
    }
    const upper = flagOn(parsed.flags, 'u')
    const lines: string[] = []
    for (let index = 0; index < count; index += 1) {
      if ((index & 0x3ff) === 0 && interrupted(ctx)) {
        return { code: 130, stdout: lines.join(''), stderr: 'uuid: interrupted\n' }
      }
      const value = uuidV4()
      lines.push(`${upper ? value.toUpperCase() : value}\n`)
    }
    return ok(lines.join(''))
  },
}

// ---------- getopt ----------

const getoptUsage =
  'getopt -o 短选项 [-l 长选项] -- 参数...｜把参数重排成 shell 可 eval 的形式（GNU 风格）'

type GetoptArgument = 'none' | 'required' | 'optional'

type GetoptOption = { name: string; argument: GetoptArgument }

/** 解析 `ab:c::` 这样的短选项串 */
const parseShortOptions = (text: string): GetoptOption[] => {
  const options: GetoptOption[] = []
  let index = 0
  while (index < text.length) {
    const name = text[index]
    index += 1
    if (name === ':' || name === '+' || name === '-') {
      // 去掉 POSIX 的前缀修饰符
      continue
    }
    if (text[index] === ':') {
      index += 1
      if (text[index] === ':') {
        index += 1
        options.push({ name, argument: 'optional' })
      } else {
        options.push({ name, argument: 'required' })
      }
    } else {
      options.push({ name, argument: 'none' })
    }
  }
  return options
}

/** 解析 `file:,help,color::` 这样的长选项串 */
const parseLongOptions = (text: string): GetoptOption[] =>
  text
    .split(',')
    .filter((item) => item !== '')
    .map((item) => {
      if (item.endsWith('::')) {
        return { name: item.slice(0, -2), argument: 'optional' }
      }
      if (item.endsWith(':')) {
        return { name: item.slice(0, -1), argument: 'required' }
      }
      return { name: item, argument: 'none' }
    })

/** 单引号安全包一层，供 eval 使用 */
const getoptQuote = (word: string): string =>
  word === '' ? "''" : `'${word.replace(/'/g, `'\\''`)}'`

type GetoptToken = { text: string; quote: boolean }

/** 处理目标参数：选项重排到前面，非选项保持在后面（GNU getopt 的置换行为） */
const getoptProcess = (
  args: string[],
  shortOptions: GetoptOption[],
  longOptions: GetoptOption[]
): { tokens: GetoptToken[]; error?: string } => {
  const tokens: GetoptToken[] = []
  const operands: string[] = []
  let ended = false
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (!ended && argument === '--') {
      ended = true
      continue
    }
    if (!ended && argument.length > 1 && argument.startsWith('-') && argument !== '-') {
      if (argument.startsWith('--')) {
        const body = argument.slice(2)
        const equals = body.indexOf('=')
        const name = equals >= 0 ? body.slice(0, equals) : body
        const option = longOptions.find((item) => item.name === name)
        if (option === undefined) {
          return { tokens, error: `unrecognized option '--${name}'` }
        }
        if (option.argument === 'none') {
          if (equals >= 0) {
            return { tokens, error: `option '--${name}' doesn't allow an argument` }
          }
          tokens.push({ text: `--${name}`, quote: false })
          continue
        }
        if (equals >= 0) {
          tokens.push({ text: `--${name}`, quote: false })
          tokens.push({ text: body.slice(equals + 1), quote: true })
          continue
        }
        if (option.argument === 'optional') {
          tokens.push({ text: `--${name}`, quote: false })
          continue
        }
        const value = args[index + 1]
        if (value === undefined) {
          return { tokens, error: `option '--${name}' requires an argument` }
        }
        index += 1
        tokens.push({ text: `--${name}`, quote: false })
        tokens.push({ text: value, quote: true })
        continue
      }
      for (let position = 1; position < argument.length; position += 1) {
        const name = argument[position]
        const option = shortOptions.find((item) => item.name === name)
        if (option === undefined) {
          return { tokens, error: `invalid option -- '${name}'` }
        }
        if (option.argument === 'none') {
          tokens.push({ text: `-${name}`, quote: false })
          continue
        }
        const inline = argument.slice(position + 1)
        tokens.push({ text: `-${name}`, quote: false })
        if (inline !== '') {
          tokens.push({ text: inline, quote: true })
          break
        }
        if (option.argument === 'optional') {
          break
        }
        const value = args[index + 1]
        if (value === undefined) {
          return { tokens, error: `option requires an argument -- '${name}'` }
        }
        index += 1
        tokens.push({ text: value, quote: true })
        break
      }
      continue
    }
    operands.push(argument)
  }
  tokens.push({ text: '--', quote: false })
  for (const operand of operands) {
    tokens.push({ text: operand, quote: true })
  }
  return { tokens }
}

const getoptApplet: Applet = {
  name: 'getopt',
  summary: '解析 / 重排命令行选项，输出可直接 eval 的 shell 参数',
  summaryEn: 'Parse and reorder command line options for shell eval',
  usage: getoptUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${getoptUsage}\n`)
    }
    let shortText = ''
    let longText = ''
    let index = 1
    while (index < ctx.argv.length) {
      const argument = ctx.argv[index]
      if (argument === '--') {
        index += 1
        break
      }
      if (argument === '-o' || argument === '--options') {
        shortText = ctx.argv[index + 1] ?? ''
        index += 2
        continue
      }
      if (argument.startsWith('--options=')) {
        shortText = argument.slice('--options='.length)
        index += 1
        continue
      }
      if (argument.startsWith('-o') && argument.length > 2) {
        shortText = argument.slice(2)
        index += 1
        continue
      }
      if (argument === '-l' || argument === '--longoptions') {
        longText = ctx.argv[index + 1] ?? ''
        index += 2
        continue
      }
      if (argument.startsWith('--longoptions=')) {
        longText = argument.slice('--longoptions='.length)
        index += 1
        continue
      }
      if (argument.startsWith('-l') && argument.length > 2) {
        longText = argument.slice(2)
        index += 1
        continue
      }
      if (argument === '-a' || argument === '--alternative') {
        // GNU 的 alternative 模式只影响输出格式；这里两种模式输出一致
        index += 1
        continue
      }
      if (argument === '-q' || argument === '--quiet') {
        index += 1
        continue
      }
      if (argument === '-h' || argument === '--help') {
        return ok(`${getoptUsage}\n`)
      }
      if (argument.startsWith('-') && argument !== '-') {
        return usageError('getopt', `unrecognized option '${argument}'`)
      }
      // 没有 `--` 时，第一个非选项之后都当目标参数
      break
    }
    if (shortText === '' && longText === '') {
      return fail('getopt: 缺少 optstring 参数（用 -o 指定短选项）\n', 2)
    }
    const target = ctx.argv.slice(index)
    const outcome = getoptProcess(target, parseShortOptions(shortText), parseLongOptions(longText))
    if (outcome.error !== undefined) {
      // GNU getopt 出错时也会把 `--` 打到 stdout，方便脚本统一 eval
      return { code: 1, stdout: ' --\n', stderr: `getopt: ${outcome.error}\n` }
    }
    const words = outcome.tokens.map((token) =>
      token.quote ? getoptQuote(token.text) : token.text
    )
    return ok(` ${words.join(' ')}\n`)
  },
}

// ---------- tsort ----------

const tsortUsage = 'tsort [文件]｜按成对的先后关系做拓扑排序；有环时报错并退出 1'

type TsortGraph = {
  nodes: Set<string>
  outgoing: Map<string, string[]>
  indegree: Map<string, number>
}

const tsortBuild = (tokens: string[]): TsortGraph => {
  if (tokens.length % 2 !== 0) {
    throw new Error('input contains an odd number of tokens')
  }
  const graph: TsortGraph = {
    nodes: new Set<string>(),
    outgoing: new Map<string, string[]>(),
    indegree: new Map<string, number>(),
  }
  const edges = new Set<string>()
  for (let index = 0; index < tokens.length; index += 2) {
    const from = tokens[index]
    const to = tokens[index + 1]
    graph.nodes.add(from)
    graph.nodes.add(to)
    // 重复边只在第一次出现时计数，避免入度虚高
    const edgeKey = `${from}\u0000${to}`
    if (from === to || edges.has(edgeKey)) {
      continue
    }
    edges.add(edgeKey)
    const outgoing = graph.outgoing.get(from) ?? []
    outgoing.push(to)
    graph.outgoing.set(from, outgoing)
    graph.indegree.set(to, (graph.indegree.get(to) ?? 0) + 1)
  }
  return graph
}

const tsortApplet: Applet = {
  name: 'tsort',
  summary: '拓扑排序：输入成对的先后关系，有环时报错',
  summaryEn: 'Topologically sort a list of input pairs',
  usage: tsortUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${tsortUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {})
    if (parsed.error) {
      return usageError('tsort', parsed.error)
    }
    if (parsed.operands.length > 1) {
      return usageError('tsort', `extra operand '${parsed.operands[1]}'`)
    }
    let text = ctx.stdin
    const file = parsed.operands[0]
    if (file !== undefined) {
      try {
        text = readTextOperand(ctx, file)
      } catch (error) {
        return fileError('tsort', file, error)
      }
    }
    const tokens = text.split(/\s+/).filter((token) => token !== '')
    let graph: TsortGraph
    try {
      graph = tsortBuild(tokens)
    } catch (error) {
      return fail(`tsort: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    // Kahn 算法：入度为 0 的节点按字典序出队，结果稳定
    const ready = [...graph.nodes].filter((node) => (graph.indegree.get(node) ?? 0) === 0).sort()
    const order: string[] = []
    let processed = 0
    while (ready.length > 0) {
      if ((processed & 0xff) === 0 && interrupted(ctx)) {
        return { code: 130, stdout: order.join(''), stderr: 'tsort: interrupted\n' }
      }
      const node = ready.shift()
      if (node === undefined) {
        break
      }
      order.push(node)
      processed += 1
      for (const next of graph.outgoing.get(node) ?? []) {
        const remaining = (graph.indegree.get(next) ?? 0) - 1
        graph.indegree.set(next, remaining)
        if (remaining === 0) {
          ready.push(next)
          ready.sort()
        }
      }
    }
    if (order.length !== graph.nodes.size) {
      const sortedOut = new Set(order)
      const stuck = [...graph.nodes].filter((node) => !sortedOut.has(node)).sort()
      const lines = ['tsort: input contains a loop:', ...stuck.map((node) => `tsort: ${node}`)]
      return { code: 1, stderr: `${lines.join('\n')}\n` }
    }
    return ok(order.length > 0 ? `${order.join('\n')}\n` : '')
  },
}

// ---------- envsubst ----------

const envsubstUsage = 'envsubst [-v] [变量列表] [文件...]｜把 $VAR / ${VAR} 换成环境变量值'

/** 变量列表：`$FOO, $BAR` 或 `FOO BAR` 都接受 */
const envsubstList = (text: string): Set<string> => {
  const names = new Set<string>()
  for (const word of text.split(/[\s,]+/)) {
    const name = word.replace(/^\$/, '').replace(/^\{/, '').replace(/\}$/, '')
    if (name !== '') {
      names.add(name)
    }
  }
  return names
}

/** 替换文本里的 $VAR / ${VAR}；allow 为 null 表示全部替换，否则只替换列出的变量 */
const envsubstText = (
  text: string,
  env: Record<string, string>,
  allow: Set<string> | null
): string => {
  const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
  return text.replace(pattern, (match: string, braced: string, plain: string) => {
    // 正则里两个分支各有一个捕获组，未参与匹配的那个是 undefined
    const name = braced || plain
    if (allow !== null && !allow.has(name)) {
      return match
    }
    return env[name] ?? ''
  })
}

const envsubstApplet: Applet = {
  name: 'envsubst',
  summary: '把 $VAR / ${VAR} 用环境变量替换；-v 列出可用变量',
  summaryEn: 'Substitute $VAR and ${VAR} with environment values',
  usage: envsubstUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${envsubstUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { v: 'boolean' })
    if (parsed.error) {
      return usageError('envsubst', parsed.error)
    }
    if (flagOn(parsed.flags, 'v')) {
      const keys = Object.keys(ctx.env).sort()
      return ok(keys.map((key) => `${key}=${ctx.env[key]}\n`).join(''))
    }
    let operands = parsed.operands
    let allow: Set<string> | null = null
    if (operands.length > 0) {
      const first = operands[0]
      // 第一个参数不是文件时按「变量列表」解释（GNU envsubst 的 SHELL-FORMAT）
      const isFile = first === '-' || ctx.fs.exists(resolvePath(ctx.cwd, first))
      if (!isFile && /^[\w${},.\s-]+$/.test(first)) {
        allow = envsubstList(first)
        operands = operands.slice(1)
      }
    }
    const sources = operands.length > 0 ? operands : ['-']
    let output = ''
    let errors = ''
    for (const source of sources) {
      if (interrupted(ctx)) {
        return { code: 130, stdout: output, stderr: `${errors}envsubst: interrupted\n` }
      }
      let text: string
      try {
        text = readTextOperand(ctx, source)
      } catch (error) {
        errors += `envsubst: ${source}: ${describeError(error)}\n`
        continue
      }
      output += envsubstText(text, ctx.env, allow)
    }
    return { code: errors === '' ? 0 : 1, stdout: output, stderr: errors }
  },
}

// ---------- dotenv ----------

const dotenvUsage = "dotenv [-f .env] [--json]｜把 .env 解析成 export KEY='value' 或 JSON"

type DotenvEntry = { key: string; value: string }

type DotenvParse = {
  entries: DotenvEntry[]
  errors: string[]
}

/** 展开值里的 $VAR / ${VAR}：本文件先定义的键优先，其次进程环境变量 */
const dotenvExpand = (text: string, lookup: (name: string) => string | undefined): string => {
  const pattern = /\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/g
  return text.replace(pattern, (_match: string, braced: string, plain: string) => {
    const name = braced || plain
    return lookup(name) ?? ''
  })
}

/** 解析一个值：双引号支持转义与展开，单引号原样，裸值去掉行尾注释 */
const dotenvValue = (raw: string, lookup: (name: string) => string | undefined): string | null => {
  const text = raw.trim()
  if (text.startsWith('"')) {
    const match = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(text)
    if (match === null) {
      return null
    }
    const unescaped = match[1].replace(/\\([nrt"\\$])/g, (_all, char: string) => {
      if (char === 'n') {
        return '\n'
      }
      if (char === 'r') {
        return '\r'
      }
      if (char === 't') {
        return '\t'
      }
      return char
    })
    return dotenvExpand(unescaped, lookup)
  }
  if (text.startsWith("'")) {
    const match = /^'([^']*)'\s*(?:#.*)?$/.exec(text)
    if (match === null) {
      return null
    }
    return match[1]
  }
  const body = text.replace(/\s+#.*$/, '').trim()
  return dotenvExpand(body, lookup)
}

const dotenvParse = (text: string, env: Record<string, string>): DotenvParse => {
  const entries: DotenvEntry[] = []
  const errors: string[] = []
  const local = new Map<string, string>()
  const lookup = (name: string): string | undefined => local.get(name) ?? env[name]
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) {
      continue
    }
    const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const equals = body.indexOf('=')
    if (equals < 0) {
      errors.push(`第 ${index + 1} 行不是 KEY=VALUE`)
      continue
    }
    const key = body.slice(0, equals).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      errors.push(`第 ${index + 1} 行的变量名 '${key}' 不合法`)
      continue
    }
    const value = dotenvValue(body.slice(equals + 1), lookup)
    if (value === null) {
      errors.push(`第 ${index + 1} 行的值引号没有闭合`)
      continue
    }
    local.set(key, value)
    entries.push({ key, value })
  }
  return { entries, errors }
}

/** 输出为 shell 可 eval 的 export 语句 */
const dotenvExport = (entries: DotenvEntry[]): string =>
  entries.map((entry) => `export ${entry.key}='${entry.value.replace(/'/g, `'\\''`)}'\n`).join('')

const dotenvApplet: Applet = {
  name: 'dotenv',
  summary: '解析 .env 文件，输出 shell 可 eval 的 export 语句或 JSON',
  summaryEn: 'Parse a .env file into export statements or JSON',
  usage: dotenvUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${dotenvUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, { f: 'value', json: 'boolean' })
    if (parsed.error) {
      return usageError('dotenv', parsed.error)
    }
    if (parsed.operands.length > 0) {
      return usageError('dotenv', `extra operand '${parsed.operands[0]}'`)
    }
    const file = flagText(parsed.flags, 'f') ?? '.env'
    let text: string
    try {
      text = file === '-' ? ctx.stdin : DECODER.decode(readInputBytes(ctx, file))
    } catch (error) {
      return fileError('dotenv', file, error)
    }
    const result = dotenvParse(text, ctx.env)
    const stderr = result.errors.map((error) => `dotenv: ${file}: ${error}\n`).join('')
    if (flagOn(parsed.flags, 'json')) {
      const record: Record<string, string> = {}
      for (const entry of result.entries) {
        record[entry.key] = entry.value
      }
      return {
        code: result.errors.length > 0 ? 1 : 0,
        stdout: `${JSON.stringify(record, null, 2)}\n`,
        stderr,
      }
    }
    return {
      code: result.errors.length > 0 ? 1 : 0,
      stdout: dotenvExport(result.entries),
      stderr,
    }
  },
}

// ---------- sponge ----------

const spongeUsage = 'sponge [文件]｜先读完标准输入再写文件；不给文件时写到标准输出'

const spongeApplet: Applet = {
  name: 'sponge',
  summary: '先吸干标准输入再写文件，管道里可以原地改写目标文件',
  summaryEn: 'Soak up standard input and write it back to a file',
  usage: spongeUsage,
  run: (ctx: AppletContext): AppletResult => {
    if (wantsHelp(ctx.argv)) {
      return ok(`${spongeUsage}\n`)
    }
    const parsed = parseArgs(ctx.argv, {})
    if (parsed.error) {
      return usageError('sponge', parsed.error)
    }
    if (parsed.operands.length > 1) {
      return usageError('sponge', `extra operand '${parsed.operands[1]}'`)
    }
    if (interrupted(ctx)) {
      return ABORTED
    }
    const target = parsed.operands[0]
    // 不给文件时按 GNU sponge 的行为把输入写到标准输出
    if (target === undefined) {
      return ok(ctx.stdin)
    }
    if (ctx.fs.isDirectory(resolvePath(ctx.cwd, target))) {
      return fail(`sponge: ${target}: Is a directory\n`)
    }
    try {
      ctx.fs.writeText(resolvePath(ctx.cwd, target), ctx.stdin)
    } catch (error) {
      return fileError('sponge', target, error)
    }
    return ok('')
  },
}

/** 本文件对外导出的应用集 */
export const EXTRAS_DEV_APPLETS: Applet[] = [
  patchApplet,
  bcApplet,
  exprApplet,
  treeApplet,
  fmtApplet,
  timeApplet,
  uuidApplet,
  getoptApplet,
  tsortApplet,
  envsubstApplet,
  dotenvApplet,
  spongeApplet,
]
