/**
 * 跨源隔离（COOP/COEP）开关。
 *
 * CheerpX 需要 SharedArrayBuffer，而浏览器只在 crossOriginIsolated 的页面里
 * 允许它。静态托管（GitHub Pages 等）没法加响应头，所以在「第一次启用 WebVM」
 * 时注册一个很小的 service worker：它给同源响应补上 COOP/COEP，然后刷新一次。
 *
 * 之后每次访问都由这个 SW 接管，crossOriginIsolated 直接为 true；
 * APK 的本地 HTTP 服务自己就带这两个头，根本不会走到这里。
 */

const PENDING_KEY = 'chat-demo:webvm-pending-boot'
const UNKERNEL_PENDING_KEY = 'chat-demo:unkernel-pending-boot'
const ATTEMPT_KEY = 'chat-demo:webvm-coi-attempt'
const CONTROLLER_TIMEOUT_MS = 8000
const RELOAD_GUARD_MS = 15_000

export type CoiState = 'isolated' | 'registerable' | 'unsupported'

export type CoiSnapshot = {
  state: CoiState
  /** 不可用时的原因：secure-context / service-worker */
  reason?: string
}

export const readCoiState = (): CoiSnapshot => {
  if (typeof window === 'undefined') {
    return { state: 'unsupported', reason: 'no-window' }
  }
  if (window.crossOriginIsolated) {
    return { state: 'isolated' }
  }
  // Android WebView 至今不支持跨源隔离（Chromium issue 40914606），
  // 即使响应带 COOP/COEP，crossOriginIsolated 也永远是 false。
  if (/;\s*wv\b/i.test(navigator.userAgent)) {
    return { state: 'unsupported', reason: 'webview' }
  }
  if (!window.isSecureContext) {
    return { state: 'unsupported', reason: 'secure-context' }
  }
  if (!('serviceWorker' in navigator)) {
    return { state: 'unsupported', reason: 'service-worker' }
  }
  return { state: 'registerable' }
}

/** 记住「刷新后自动打开 WebVM」的意图，避免用户还要再点一次侧栏 */
export const markPendingWebVmBoot = () => {
  try {
    sessionStorage.setItem(PENDING_KEY, '1')
  } catch {
    // 隐私模式忽略
  }
}

/** 多 CPU 的 Unkernel 也需要跨源隔离；刷新后自动打开 Unkernel。 */
export const markPendingUnkernelBoot = () => {
  try {
    sessionStorage.setItem(UNKERNEL_PENDING_KEY, '1')
  } catch {
    // 隐私模式忽略
  }
}

export const consumePendingUnkernelBoot = (): boolean => {
  try {
    if (sessionStorage.getItem(UNKERNEL_PENDING_KEY) !== '1') {
      return false
    }
    sessionStorage.removeItem(UNKERNEL_PENDING_KEY)
    return true
  } catch {
    return false
  }
}

export const consumePendingWebVmBoot = (): boolean => {
  try {
    if (sessionStorage.getItem(PENDING_KEY) !== '1') {
      return false
    }
    sessionStorage.removeItem(PENDING_KEY)
    return true
  } catch {
    return false
  }
}

const waitForController = (): Promise<boolean> => {
  if (navigator.serviceWorker.controller) {
    return Promise.resolve(true)
  }
  return new Promise((resolve) => {
    let settled = false
    const finish = (value: boolean) => {
      if (settled) {
        return
      }
      settled = true
      navigator.serviceWorker.removeEventListener('controllerchange', onChange)
      resolve(value)
    }
    const onChange = () => finish(true)
    navigator.serviceWorker.addEventListener('controllerchange', onChange)
    window.setTimeout(() => finish(!!navigator.serviceWorker.controller), CONTROLLER_TIMEOUT_MS)
  })
}

/**
 * 注册 coi-sw.js 并刷新页面。正常路径不会返回（页面已经重载）；
 * 失败时抛出一句可以直接显示给用户的中文原因。
 */
const enableIsolation = async (markPending: () => void): Promise<void> => {
  const state = readCoiState()
  if (state.state === 'isolated') {
    return
  }
  if (state.state === 'unsupported') {
    throw new Error(
      state.reason === 'secure-context'
        ? '当前页面不是安全上下文，多 CPU / WebVM 需要 HTTPS 或 localhost'
        : '当前浏览器不支持 Service Worker，无法开启跨源隔离'
    )
  }
  try {
    const raw = sessionStorage.getItem(ATTEMPT_KEY)
    if (raw && Date.now() - Number(raw) < RELOAD_GUARD_MS) {
      throw new Error('跨源隔离仍未生效，请确认浏览器允许 Service Worker 后重试')
    }
    sessionStorage.setItem(ATTEMPT_KEY, String(Date.now()))
  } catch {
    // sessionStorage 不可用时不做防抖
  }

  markPending()
  const scriptUrl = new URL('coi-sw.js', document.baseURI).href
  const registration = await navigator.serviceWorker.register(scriptUrl, { scope: './' })
  await navigator.serviceWorker.ready
  // registration.active 在首次注册时可能已激活但还没接管页面，等 controllerchange
  const controlled = await waitForController()
  if (!controlled && !registration.active) {
    throw new Error('Service Worker 未能激活，请刷新页面后重试')
  }
  window.location.reload()
}

export const enableCrossOriginIsolation = (): Promise<void> => enableIsolation(markPendingWebVmBoot)

/** 为多 CPU 的 Unkernel 开启跨源隔离；刷新后自动打开 Unkernel。 */
export const enableCrossOriginIsolationForUnkernel = (): Promise<void> =>
  enableIsolation(markPendingUnkernelBoot)
