import { create } from 'zustand'

/**
 * WebVM（CheerpX）的开关与镜像配置。
 *
 * 与 NanoVM 一样只存 localStorage。WebVM 的磁盘是一个云端 ext2 镜像：
 * CheerpX 按块从 disks.webvm.io 流式读取，写操作落在 IndexedDB 覆盖层里，
 * 所以同一台设备二次启动不需要重新下载整块磁盘。
 */

const KEY = 'chat-demo:webvm-config'

export type WebVmImageId = 'debian' | 'debian-2023' | 'custom'

export type WebVmConfig = {
  /** 总开关：关闭后侧栏入口与设置卡片都不可用 */
  enabled: boolean
  /** 允许模型调用 WebVM shell */
  allowAgent: boolean
  /** 首次打开 WebVM 时自动启动（关闭后显示「启动 WebVM」按钮） */
  autoBoot: boolean
  /** 根文件系统镜像 */
  imageId: WebVmImageId
  /** 自定义镜像地址（imageId === 'custom' 时生效） */
  customImageUrl: string
  /** 启动命令，按空格切分；默认 /bin/bash --login */
  command: string
  /** 单条 Agent 命令超时（毫秒） */
  timeoutMs: number
  /** IndexedDB 覆盖层名前缀，换镜像时会自动带上镜像标识 */
  cacheId: string
}

/** CheerpX 官方的 WebVM 云端镜像；镜像本身是只读的，改动写进 IndexedDB 覆盖层 */
export const WEBVM_IMAGES: Record<
  Exclude<WebVmImageId, 'custom'>,
  { url: string; label: string; detail: string }
> = {
  debian: {
    url: 'wss://disks.webvm.io/debian_buster_large_permis_fixed_01-06-2026.ext2',
    label: 'Debian 10 (buster) · 完整',
    detail: 'bash / coreutils / gcc / g++ / Python 3 / Node.js / Ruby / Lua / make / git / vim',
  },
  'debian-2023': {
    url: 'wss://disks.webvm.io/debian_large_20230522_5044875331.ext2',
    label: 'Debian 10 (buster) · 2023 镜像',
    detail: '旧版 WebVM 镜像，体积与工具链相近，作为备用',
  },
}

export const WEBVM_IMAGE_IDS: WebVmImageId[] = ['debian', 'debian-2023', 'custom']

export const WEBVM_TIMEOUT_MIN_MS = 5_000
export const WEBVM_TIMEOUT_MAX_MS = 120_000

const defaults: WebVmConfig = {
  enabled: true,
  allowAgent: false,
  autoBoot: true,
  imageId: 'debian',
  customImageUrl: '',
  command: '/bin/bash --login',
  timeoutMs: 30_000,
  cacheId: 'nanovm-webvm',
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min

/** 自定义镜像地址：wss / https，或同源 / 相对的 ext2 文件 */
export const isWebVmImageUrl = (value: string): boolean =>
  /^(wss|https):\/\//i.test(value) || /^\/[^/]/.test(value) || /^\.{0,2}\//.test(value)

const normalizeCommand = (value: string): string => {
  const command = value.replace(/\s+/g, ' ').trim().slice(0, 200)
  return command || defaults.command
}

const read = (): WebVmConfig => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return { ...defaults }
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...defaults }
    }
    const source = parsed as Partial<WebVmConfig>
    const imageId: WebVmImageId =
      source.imageId === 'debian' || source.imageId === 'debian-2023' || source.imageId === 'custom'
        ? source.imageId
        : defaults.imageId
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
      allowAgent: typeof source.allowAgent === 'boolean' ? source.allowAgent : defaults.allowAgent,
      autoBoot: typeof source.autoBoot === 'boolean' ? source.autoBoot : defaults.autoBoot,
      imageId,
      customImageUrl:
        typeof source.customImageUrl === 'string' ? source.customImageUrl.trim().slice(0, 500) : '',
      command: normalizeCommand(source.command ?? defaults.command),
      timeoutMs: clamp(
        source.timeoutMs ?? defaults.timeoutMs,
        WEBVM_TIMEOUT_MIN_MS,
        WEBVM_TIMEOUT_MAX_MS
      ),
      cacheId:
        typeof source.cacheId === 'string' && source.cacheId.trim()
          ? source.cacheId.trim().slice(0, 60)
          : defaults.cacheId,
    }
  } catch {
    return { ...defaults }
  }
}

const write = (config: WebVmConfig) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

export const useWebVMConfig = create<WebVmConfig>(() => read())

export const webVMConfig = (): WebVmConfig => useWebVMConfig.getState()

export const setWebVMConfig = (patch: Partial<WebVmConfig>) => {
  const next = { ...useWebVMConfig.getState(), ...patch }
  next.customImageUrl = next.customImageUrl.trim().slice(0, 500)
  next.command = normalizeCommand(next.command)
  next.timeoutMs = clamp(next.timeoutMs, WEBVM_TIMEOUT_MIN_MS, WEBVM_TIMEOUT_MAX_MS)
  next.cacheId = next.cacheId.trim().slice(0, 60) || defaults.cacheId
  write(next)
  useWebVMConfig.setState(next)
}

export const setWebVMEnabled = (enabled: boolean) => setWebVMConfig({ enabled })
export const setWebVMAllowAgent = (allowAgent: boolean) => setWebVMConfig({ allowAgent })

/** 模型是否真的能调用 WebVM 工具：总开关 + 允许模型调用 */
export const webVMAgentAvailable = (): boolean => {
  const config = useWebVMConfig.getState()
  return config.enabled && config.allowAgent
}

/** 当前镜像的地址；自定义地址不合法时回落到默认镜像 */
export const webVMImageUrl = (config = webVMConfig()): string => {
  if (config.imageId === 'custom') {
    return isWebVmImageUrl(config.customImageUrl) ? config.customImageUrl : WEBVM_IMAGES.debian.url
  }
  return WEBVM_IMAGES[config.imageId].url
}

/** 镜像缓存键：不同镜像共用覆盖层会让第二个镜像读到脏块 */
export const webVMCacheKey = (config = webVMConfig()): string => {
  if (config.imageId !== 'custom') {
    return `${config.cacheId}:${config.imageId}`
  }
  let hash = 0
  for (const char of webVMImageUrl(config)) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return `${config.cacheId}:custom:${hash.toString(36)}`
}

/** 启动命令拆成 [文件, 参数...]；只是按空格切，不处理引号 */
export const webVMCommandParts = (config = webVMConfig()): { file: string; args: string[] } => {
  const parts = config.command.split(' ').filter(Boolean)
  if (parts.length === 0) {
    return { file: '/bin/bash', args: ['--login'] }
  }
  return { file: parts[0], args: parts.slice(1) }
}

export const resetWebVMConfig = () => {
  write({ ...defaults })
  useWebVMConfig.setState({ ...defaults })
}
