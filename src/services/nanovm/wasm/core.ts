/**
 * NanoVM Slim 手写的 WebAssembly 内核。
 *
 * 不引入任何第三方依赖：模块字节码用 LEB128 与段落组装函数直接拼出来，
 * 段落顺序（type → function → memory → global → export → code → data）贴在下面，
 * 改起来和读汇编一样直接。
 *
 * 导出的东西：
 *   memory          线性内存，initial == maximum == memoryMB * 16 页（配额不可增长）
 *   alloc(n)        8 字节对齐的 bump 分配，超出配额返回 0
 *   reset()         指针回到堆起点，阶段之间复用同一块内存
 *   memcpy(d,s,n)   线性内存内部拷贝
 *   memset(p,v,n)   线性内存内部填充
 *   used()          已用字节
 *   peak()          峰值已用字节（启动至今的高水位）
 *   base()          堆起点
 *
 * shell 的管道缓冲就落在这块内存里：每个阶段先把 stdin 拷进来，命令输出再写回内存
 * 读出成字符串，阶段收尾 reset()。所以「给虚拟机分多少内存」是真的在限制一条管道
 * 能搬多大的数据，超了就是 Cannot allocate memory。
 */

/** 数据段偏移：页面开头留一点空位，读起来更像真实内存布局 */
const DATA_OFFSET = 16

/** 数据段里的标识，堆从它后面开始 */
const BANNER = 'NanoVM Slim · WASM core · 2.7.3'

const I32 = 0x7f
const EMPTY_BLOCK = 0x40
const FUNC_TYPE = 0x60
const MUTABLE = 0x01
const EXTERN_FUNC = 0x00
const EXTERN_MEMORY = 0x02

/** 指令码 */
const OP = {
  block: 0x02,
  loop: 0x03,
  if: 0x04,
  else: 0x05,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  localGet: 0x20,
  localSet: 0x21,
  globalGet: 0x23,
  globalSet: 0x24,
  i32Load8u: 0x2d,
  i32Store8: 0x3a,
  memorySize: 0x3f,
  i32Const: 0x41,
  i32Add: 0x6a,
  i32Sub: 0x6b,
  i32And: 0x71,
  i32Shl: 0x74,
  i32GtU: 0x4b,
  i32GeU: 0x4f,
} as const

// ---------- 字节组装 ----------

const alignTo = (value: number, alignment: number): number =>
  Math.ceil(value / alignment) * alignment

/** 无符号 LEB128 */
const uleb128 = (input: number): number[] => {
  const out: number[] = []
  let value = Math.max(0, Math.trunc(input)) >>> 0
  for (;;) {
    const byte = value & 0x7f
    value >>>= 7
    out.push(value === 0 ? byte : byte | 0x80)
    if (value === 0) {
      return out
    }
  }
}

/** 有符号 LEB128（i32.const 用） */
const sleb128 = (input: number): number[] => {
  const out: number[] = []
  let value = Math.trunc(input) | 0
  for (;;) {
    const byte = value & 0x7f
    value >>= 7
    const done = (value === 0 && (byte & 0x40) === 0) || (value === -1 && (byte & 0x40) !== 0)
    out.push(done ? byte : byte | 0x80)
    if (done) {
      return out
    }
  }
}

const textBytes = (text: string): number[] => [...new TextEncoder().encode(text)]

/** 段落：id + 负载长度 + 负载 */
const section = (id: number, payload: number[]): number[] => [
  id,
  ...uleb128(payload.length),
  ...payload,
]

/** 向量：元素个数 + 依次拼接 */
const vector = (items: number[][]): number[] => [...uleb128(items.length), ...items.flat()]

const funcType = (params: number[], results: number[]): number[] => [
  FUNC_TYPE,
  ...uleb128(params.length),
  ...params,
  ...uleb128(results.length),
  ...results,
]

const exportEntry = (name: string, kind: number, index: number): number[] => {
  const bytes = textBytes(name)
  return [...uleb128(bytes.length), ...bytes, kind, ...uleb128(index)]
}

// ---------- 指令片段 ----------

const localGet = (index: number): number[] => [OP.localGet, ...uleb128(index)]
const localSet = (index: number): number[] => [OP.localSet, ...uleb128(index)]
const globalGet = (index: number): number[] => [OP.globalGet, ...uleb128(index)]
const globalSet = (index: number): number[] => [OP.globalSet, ...uleb128(index)]
const i32Const = (value: number): number[] => [OP.i32Const, ...sleb128(value)]
const branch = (op: number, label: number): number[] => [op, ...uleb128(label)]
const memByte = (op: number): number[] => [op, 0x00, 0x00]

/** 逐字节循环：在 (dst, src/val, len) 上做拷贝或填充，公共骨架 */
const byteLoop = (valueFetch: number[]): number[] => [
  ...i32Const(0),
  ...localSet(3),
  OP.block,
  EMPTY_BLOCK,
  OP.loop,
  EMPTY_BLOCK,
  // 局部变量 3 是循环下标；i >= len 时跳出
  ...localGet(3),
  ...localGet(2),
  OP.i32GeU,
  ...branch(OP.brIf, 1),
  // dst + i
  ...localGet(0),
  ...localGet(3),
  OP.i32Add,
  ...valueFetch,
  ...memByte(OP.i32Store8),
  ...localGet(3),
  ...i32Const(1),
  OP.i32Add,
  ...localSet(3),
  ...branch(OP.br, 0),
  OP.end,
  OP.end,
]

/** 一个函数定义：局部变量个数（全是 i32）+ 指令序列（不含收尾的 end） */
type KernelFunction = {
  typeIndex: number
  locals: number
  body: number[]
}

const buildModule = (pages: number): Uint8Array<ArrayBuffer> => {
  const banner = textBytes(BANNER)
  const heapBase = alignTo(DATA_OFFSET + banner.length, 8)

  // alloc(n): (n + 7) & -8 → 找不到空间返回 0
  const allocBody: number[] = [
    ...localGet(0),
    ...i32Const(7),
    OP.i32Add,
    ...i32Const(-8),
    OP.i32And,
    ...localSet(1),
    ...globalGet(0),
    ...localSet(2),
    ...localGet(2),
    ...localGet(1),
    OP.i32Add,
    ...localSet(3),
    // limit = 当前页数 << 16
    OP.memorySize,
    0x00,
    ...i32Const(16),
    OP.i32Shl,
    ...localSet(4),
    ...localGet(3),
    ...localGet(4),
    OP.i32GtU,
    OP.if,
    I32,
    ...i32Const(0),
    OP.else,
    ...localGet(3),
    ...globalSet(0),
    // 峰值水位：used > peak 时更新
    ...localGet(3),
    ...i32Const(heapBase),
    OP.i32Sub,
    ...globalGet(1),
    OP.i32GtU,
    OP.if,
    EMPTY_BLOCK,
    ...localGet(3),
    ...i32Const(heapBase),
    OP.i32Sub,
    ...globalSet(1),
    OP.end,
    ...localGet(2),
    OP.end,
  ]

  const functions: KernelFunction[] = [
    { typeIndex: 1, locals: 4, body: allocBody },
    { typeIndex: 2, locals: 0, body: [...i32Const(heapBase), ...globalSet(0)] },
    {
      typeIndex: 3,
      locals: 1,
      // memcpy(dst, src, len)
      body: byteLoop([...localGet(1), ...localGet(3), OP.i32Add, ...memByte(OP.i32Load8u)]),
    },
    {
      typeIndex: 3,
      locals: 1,
      // memset(ptr, val, len)
      body: byteLoop([...localGet(1)]),
    },
    { typeIndex: 0, locals: 0, body: [...globalGet(0), ...i32Const(heapBase), OP.i32Sub] },
    { typeIndex: 0, locals: 0, body: [...globalGet(1)] },
    { typeIndex: 0, locals: 0, body: [...i32Const(heapBase)] },
  ]

  const header = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]
  const typeSection = section(
    1,
    vector([
      funcType([], [I32]),
      funcType([I32], [I32]),
      funcType([], []),
      funcType([I32, I32, I32], []),
    ])
  )
  const functionSection = section(3, vector(functions.map((entry) => uleb128(entry.typeIndex))))
  // memory：flags 0x01 表示同时给下限和上限，两者相等 => 无法 grow
  const memorySection = section(5, vector([[0x01, ...uleb128(pages), ...uleb128(pages)]]))
  const globalSection = section(
    6,
    vector([
      [I32, MUTABLE, ...i32Const(heapBase), OP.end],
      [I32, MUTABLE, ...i32Const(0), OP.end],
    ])
  )
  const exportSection = section(
    7,
    vector([
      exportEntry('memory', EXTERN_MEMORY, 0),
      exportEntry('alloc', EXTERN_FUNC, 0),
      exportEntry('reset', EXTERN_FUNC, 1),
      exportEntry('memcpy', EXTERN_FUNC, 2),
      exportEntry('memset', EXTERN_FUNC, 3),
      exportEntry('used', EXTERN_FUNC, 4),
      exportEntry('peak', EXTERN_FUNC, 5),
      exportEntry('base', EXTERN_FUNC, 6),
    ])
  )
  const codeSection = section(
    10,
    vector(
      functions.map((entry) => {
        const locals =
          entry.locals === 0 ? uleb128(0) : [...uleb128(1), ...uleb128(entry.locals), I32]
        const body = [...locals, ...entry.body, OP.end]
        return [...uleb128(body.length), ...body]
      })
    )
  )
  const dataSection = section(
    11,
    vector([[0x00, ...i32Const(DATA_OFFSET), OP.end, ...uleb128(banner.length), ...banner]])
  )

  return new Uint8Array([
    ...header,
    ...typeSection,
    ...functionSection,
    ...memorySection,
    ...globalSection,
    ...exportSection,
    ...codeSection,
    ...dataSection,
  ])
}

// ---------- 内核实例 ----------

type KernelExports = {
  memory: WebAssembly.Memory
  alloc: (size: number) => number
  reset: () => void
  memcpy: (dst: number, source: number, length: number) => void
  memset: (pointer: number, value: number, length: number) => void
  used: () => number
  peak: () => number
  base: () => number
}

const readExports = (instance: WebAssembly.Instance): KernelExports => {
  const raw = instance.exports
  const memory = raw.memory
  if (!(memory instanceof WebAssembly.Memory)) {
    throw new Error('NanoVM WASM 内核缺少 memory 导出')
  }
  const read = (name: string): ((...args: number[]) => number) => {
    const value = raw[name]
    if (typeof value !== 'function') {
      throw new Error(`NanoVM WASM 内核缺少 ${name} 导出`)
    }
    return value as (...args: number[]) => number
  }
  const alloc = read('alloc')
  const reset = read('reset')
  const memcpy = read('memcpy')
  const memset = read('memset')
  const used = read('used')
  const peak = read('peak')
  const base = read('base')
  return {
    memory,
    alloc: (size) => alloc(size),
    reset: () => {
      reset()
    },
    memcpy: (dst, source, length) => {
      memcpy(dst, source, length)
    },
    memset: (pointer, value, length) => {
      memset(pointer, value, length)
    },
    used: () => used(),
    peak: () => peak(),
    base: () => base(),
  }
}

/** 同一个页数只编译一次：改内存配额会走新的页数，各留一份 */
const compiled = new Map<number, WebAssembly.Module>()

const compileModule = (pages: number): WebAssembly.Module => {
  const cached = compiled.get(pages)
  if (cached) {
    return cached
  }
  const module = new WebAssembly.Module(buildModule(pages))
  compiled.set(pages, module)
  return module
}

/** WASM 线性内存用量，`free` / `vm info` 展示用 */
export type WasmKernelStats = {
  wasm: boolean
  totalMB: number
  usedBytes: number
  peakBytes: number
}

/** 一次管道阶段使用的线性内存缓冲 */
export type StageBuffer = {
  /** stdin 拷进内存时用掉的字节数 */
  inputBytes: number
  /** 把阶段输出写回线性内存再读出来；超出配额返回 null */
  write: (text: string) => string | null
  /** 当前已用字节（含输入与输出） */
  usedBytes: () => number
  /** 阶段收尾：擦掉缓冲头并复位指针 */
  release: () => void
}

export type WasmKernel = {
  /** 线性内存总字节数（等于配额） */
  readonly totalBytes: number
  /** 堆起点，跳过了数据段 */
  readonly heapBase: number
  stats: () => WasmKernelStats
  /** 拷贝字节进线性内存；返回起始指针，0 表示内存不足 */
  copyIn: (bytes: Uint8Array) => number
  /** 从线性内存读出字节 */
  readBytes: (pointer: number, length: number) => Uint8Array
  /** 从线性内存读出文本 */
  readText: (pointer: number, length: number) => string
  /** WASM 内部的 memcpy / memset，需要直接整理线性内存时用 */
  memcpy: (dst: number, source: number, length: number) => void
  memset: (pointer: number, value: number, length: number) => void
  used: () => number
  peak: () => number
  free: () => number
  /** 全部复位（执行新命令前调用） */
  reset: () => void
  /** 开一个管道阶段缓冲；stdin 大于配额时返回 null */
  stage: (stdin: string) => StageBuffer | null
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export const createWasmKernel = (memoryMB: number): WasmKernel => {
  // 1 MB == 16 页；最少 1 页，避免配置异常时实例化失败
  const pages = Math.max(1, Math.round(memoryMB * 16))
  const instance = new WebAssembly.Instance(compileModule(pages))
  const exports = readExports(instance)
  const totalBytes = exports.memory.buffer.byteLength
  const heapBase = exports.base()

  // memory 不可增长，所以视图可以缓存；万一宿主换了 buffer 再重建
  let view = new Uint8Array(exports.memory.buffer)
  const bytes = (): Uint8Array => {
    if (view.byteLength !== exports.memory.buffer.byteLength) {
      view = new Uint8Array(exports.memory.buffer)
    }
    return view
  }

  const copyIn = (input: Uint8Array): number => {
    if (input.byteLength === 0) {
      return exports.alloc(0)
    }
    const pointer = exports.alloc(input.byteLength)
    if (pointer === 0) {
      return 0
    }
    bytes().set(input, pointer)
    return pointer
  }

  const readBytes = (pointer: number, length: number): Uint8Array =>
    bytes().slice(pointer, pointer + length)

  const stats = (): WasmKernelStats => ({
    wasm: true,
    totalMB: totalBytes / (1024 * 1024),
    usedBytes: exports.used(),
    peakBytes: exports.peak(),
  })

  const stage = (stdin: string): StageBuffer | null => {
    const input = encoder.encode(stdin)
    const inputPointer = copyIn(input)
    if (inputPointer === 0 && input.byteLength > 0) {
      return null
    }
    return {
      inputBytes: input.byteLength,
      usedBytes: () => exports.used(),
      write: (text: string) => {
        const output = encoder.encode(text)
        const pointer = copyIn(output)
        if (pointer === 0 && output.byteLength > 0) {
          return null
        }
        // 写进去再读回来：管道数据确实经过线性内存
        return decoder.decode(readBytes(pointer, output.byteLength))
      },
      release: () => {
        // 擦掉缓冲头（最多一页），再复位指针，阶段之间不残留明文
        const wipe = Math.min(exports.used(), 4096)
        if (wipe > 0) {
          exports.memset(heapBase, 0, wipe)
        }
        exports.reset()
      },
    }
  }

  return {
    totalBytes,
    heapBase,
    stats,
    copyIn,
    readBytes,
    readText: (pointer, length) => decoder.decode(readBytes(pointer, length)),
    memcpy: (dst, source, length) => {
      exports.memcpy(dst, source, length)
    },
    memset: (pointer, value, length) => {
      exports.memset(pointer, value, length)
    },
    used: () => exports.used(),
    peak: () => exports.peak(),
    free: () => totalBytes - exports.used(),
    reset: () => {
      exports.reset()
    },
    stage,
  }
}
