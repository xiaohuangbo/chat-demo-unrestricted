import { create } from 'zustand'

/**
 * unkernel（Linux 7.x 编译成 WebAssembly）的配置。
 *
 * unkernel 页面本身在 public/unkernel/ 里，由 iframe 承载；这里只保存
 * 启动参数，改完后重建 iframe。Alpine 和 Debian 镜像都随应用分发；
 * Debian 需要更多磁盘，适合 apt / glibc 程序。
 *
 * 内核内存不在这里：页面自己的「设置 → 机器」里就有内存滑块（带自动值），
 * 而 ?mem= 会把内存固定成一个值、让页面里的改动每次启动都被覆盖，所以
 * 这里不再传 mem，交给页面自己管。
 */

const KEY = 'chat-demo:unkernel-config'

/**
 * 公共 Wisp 代理：上游默认服务器（wss://wisp.pi0.io:6680/）只接受它白名单里
 * 的页面源，本应用部署在别的源上时用这两个（页面会同时竞速）。
 */
export const PUBLIC_WISP_SERVERS = 'wss://anura.pro/,wss://wisp.mercurywork.shop/'

export type UnkernelDistro = 'alpine' | 'debian'

export type UnkernelConfig = {
  /** 侧栏入口、设置页和控制台总开关 */
  enabled: boolean
  /** 允许模型通过 unkernel_* 工具操作虚拟机 */
  allowAgent: boolean
  /** 数据盘大小（MiB），稀疏磁盘；扩大后重启，页面会自动扩容 ext4 */
  dataDiskMiB: number
  /** 发行版镜像 */
  distro: UnkernelDistro
  /** 给 guest 一张网卡（Wisp 代理） */
  network: boolean
  /** 给 guest 声卡（Web Audio） */
  sound: boolean
  /** 给 guest framebuffer / evdev 显示 */
  display: boolean
  /** 把 Alpine 的数据盘持久化到 IndexedDB */
  persistentData: boolean
  /** 在 Web Worker 里跑内核（需要 crossOriginIsolated） */
  worker: boolean
  /** guest CPU 数，默认 1 */
  cpus: number
  /** 自定义 Wisp 地址；空字符串使用 unkernel 默认服务器 */
  wispUrl: string
  /** Agent 单条命令超时（毫秒） */
  timeoutMs: number
}

const defaults: UnkernelConfig = {
  enabled: true,
  allowAgent: false,
  distro: 'alpine',
  dataDiskMiB: 8192,
  network: true,
  sound: true,
  display: true,
  persistentData: true,
  worker: false,
  cpus: 1,
  wispUrl: '',
  timeoutMs: 30_000,
}

const clamp = (value: number, min: number, max: number) =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min

const read = (): UnkernelConfig => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return { ...defaults }
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...defaults }
    }
    const source = parsed as Partial<UnkernelConfig>
    return {
      enabled: typeof source.enabled === 'boolean' ? source.enabled : defaults.enabled,
      allowAgent: typeof source.allowAgent === 'boolean' ? source.allowAgent : defaults.allowAgent,
      distro: source.distro === 'debian' ? 'debian' : 'alpine',
      dataDiskMiB: clamp(source.dataDiskMiB ?? defaults.dataDiskMiB, 4096, 32768),
      network: typeof source.network === 'boolean' ? source.network : defaults.network,
      sound: typeof source.sound === 'boolean' ? source.sound : defaults.sound,
      display: typeof source.display === 'boolean' ? source.display : defaults.display,
      persistentData:
        typeof source.persistentData === 'boolean' ? source.persistentData : defaults.persistentData,
      worker: typeof source.worker === 'boolean' ? source.worker : defaults.worker,
      cpus: clamp(source.cpus ?? defaults.cpus, 1, 4),
      wispUrl: typeof source.wispUrl === 'string' ? source.wispUrl.trim().slice(0, 300) : '',
      timeoutMs: clamp(source.timeoutMs ?? defaults.timeoutMs, 5_000, 120_000),
    }
  } catch {
    return { ...defaults }
  }
}

const write = (config: UnkernelConfig) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(config))
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

export const useUnkernelConfig = create<UnkernelConfig>(() => read())

export const unkernelConfig = (): UnkernelConfig => useUnkernelConfig.getState()

export const setUnkernelConfig = (patch: Partial<UnkernelConfig>) => {
  const next = { ...useUnkernelConfig.getState(), ...patch }
  next.distro = next.distro === 'debian' ? 'debian' : 'alpine'
  next.dataDiskMiB = clamp(next.dataDiskMiB, 4096, 32768)
  next.cpus = clamp(next.cpus, 1, 4)
  next.timeoutMs = clamp(next.timeoutMs, 5_000, 120_000)
  next.wispUrl = next.wispUrl.trim().slice(0, 300)
  write(next)
  useUnkernelConfig.setState(next)
}

export const resetUnkernelConfig = () => {
  // The data disk only grows: a reset to the 8 GiB default would make the page
  // refuse a disk already grown past it, so keep the larger size.
  const keepDisk = useUnkernelConfig.getState().dataDiskMiB
  const next = { ...defaults, dataDiskMiB: Math.max(defaults.dataDiskMiB, keepDisk) }
  write(next)
  useUnkernelConfig.setState(next)
}

export const unkernelAgentAvailable = (): boolean => {
  const config = useUnkernelConfig.getState()
  return config.enabled && config.allowAgent
}

/**
 * unkernel 页面地址。页面在 public/unkernel/ 下，所有资源都挂在
 * /unkernel/ 前缀；查询参数由 unkernel 的 config.ts 解析。
 */
export const unkernelUrl = (config = unkernelConfig()): string => {
  const params = new URLSearchParams()
  params.set('distro', config.distro)
  // 内存交给页面自己的「设置 → 机器」管：这里传 mem 会把内存固定住，
  // 页面里的改动每次启动都被覆盖。
  // 新版页面按 GiB 传数据盘大小（datasize），旧的 disk（MiB）参数已移除。
  params.set('datasize', String(Math.round(config.dataDiskMiB / 1024)))
  params.set('net', config.network ? '1' : '0')
  params.set('sound', config.sound ? '1' : '0')
  params.set('display', config.display ? '1' : '0')
  params.set('data', config.persistentData ? '1' : '0')
  params.set('worker', config.worker || config.cpus > 1 ? '1' : '0')
  params.set('cpus', String(config.cpus))
  // 页面默认把 deb.debian.org 等纯 HTTP 主机交给它自己的 CORS 镜像
  // （mirror.unkernel.dev）用 fetch() 代答。该镜像只接受白名单里的 Origin
  // （https://unkernel.dev、http://localhost:* 等），本应用跑在别的源上
  // （127.0.0.1:3080、局域网地址、APK 的 http://127.0.0.1:18765）会
  // 直接收到 403 Origin not allowed，guest 里的 apt update / apt install
  // 于是报 403。routes=0 让 guest 的纯 HTTP 也走 Wisp，Debian 更新不再
  // 经过镜像；页面自己的脚本本来就会检查名字是否被路由（198.51.100.0/24），
  // 关掉路由后它们自动改用上游地址。
  params.set('routes', '0')
  // 上游默认 Wisp（wss://wisp.pi0.io:6680/）只接受白名单里的页面源；留空时用
  // 公共代理，页面里会同时竞速两个服务器。
  params.set('wisp', config.wispUrl || PUBLIC_WISP_SERVERS)
  return `/unkernel/index.html?${params.toString()}`
}
