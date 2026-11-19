/**
 * CheerpX 运行时加载器。
 *
 * CheerpX 本体不在 npm 包里：`@leaningtech/cheerpx` 只是一个 26KB 的加载器，
 * 真正会从 Leaning Technologies 的 CDN（cxrtnc.leaningtech.com）拉 ESM 模块。
 * 这里不引入那个包，直接用运行时 `import()`，这样 rspack 不会尝试把 URL 当模块解析。
 *
 * 加载前必须已经跨源隔离（SharedArrayBuffer 的要求），否则模块自己也会报错；
 * 先在这里给出一句可读的错误，调用方好显示「启用 WebVM 运行环境」。
 */

/** 与 WebVM 当前使用的 CheerpX 版本保持一致；升级时只改这一行 */
export const CHEERPX_VERSION = '1.4.0'

const CHEERPX_URL = `https://cxrtnc.leaningtech.com/${CHEERPX_VERSION}/cx.esm.js`
const LOAD_TIMEOUT_MS = 30_000

export type CheerpXDevice = {
  delete?: () => void
}

export type CheerpXBlockDevice = CheerpXDevice

export type CheerpXIDBDevice = CheerpXDevice & {
  reset: () => Promise<void>
}

export type CheerpXDataDevice = CheerpXDevice & {
  writeFile: (path: string, data: string | Uint8Array) => Promise<void>
}

export type CheerpXMount = {
  type: 'ext2' | 'dir' | 'devs' | 'devpts' | 'proc' | 'sys'
  path: string
  dev?: CheerpXDevice
}

export type CheerpXRunOptions = {
  env?: string[]
  cwd?: string
  uid?: number
  gid?: number
}

export type CheerpXLinux = CheerpXDevice & {
  run: (
    fileName: string,
    args: string[],
    options?: CheerpXRunOptions
  ) => Promise<{ status: number }>
  setCustomConsole: (
    write: (buffer: Uint8Array, vt: number) => void,
    columns: number,
    rows: number
  ) => (keyCode: number) => void
}

export type CheerpXModule = {
  Linux: {
    create: (options: {
      mounts: CheerpXMount[]
      networkInterface?: unknown
    }) => Promise<CheerpXLinux>
  }
  CloudDevice: { create: (url: string) => Promise<CheerpXBlockDevice> }
  HttpBytesDevice: { create: (url: string) => Promise<CheerpXBlockDevice> }
  IDBDevice: { create: (name: string) => Promise<CheerpXIDBDevice> }
  OverlayDevice: {
    create: (source: CheerpXBlockDevice, cache: CheerpXIDBDevice) => Promise<CheerpXBlockDevice>
  }
  DataDevice: { create: () => Promise<CheerpXDataDevice> }
}

let pending: Promise<CheerpXModule> | null = null

const withTimeout = <T>(promise: Promise<T>, ms: number, message: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    )
  })

/**
 * 从 CDN 加载 CheerpX。失败后清掉缓存的 Promise，允许用户点「重试」。
 * 用 `new Function` 包一层，避免打包器把 https:// 当静态依赖处理。
 */
export const loadCheerpX = async (): Promise<CheerpXModule> => {
  if (typeof window === 'undefined') {
    throw new Error('CheerpX 只能在浏览器里运行')
  }
  if (!window.crossOriginIsolated) {
    throw new Error('WebVM 需要跨源隔离（COOP/COEP）才能运行 CheerpX')
  }
  if (!pending) {
    const importer = new Function('url', 'return import(url)') as (
      url: string
    ) => Promise<CheerpXModule>
    pending = withTimeout(
      importer(CHEERPX_URL),
      LOAD_TIMEOUT_MS,
      'CheerpX 运行时加载超时，请检查网络后重试'
    ).catch((error: unknown) => {
      pending = null
      throw error instanceof Error ? error : new Error(String(error))
    })
  }
  return pending
}

/** 测试与重试用：丢掉已加载的模块引用（不会卸载已经在跑的 VM） */
export const resetCheerpXLoader = () => {
  pending = null
}
