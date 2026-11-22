import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useEffect, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import {
  bootWebVm,
  checkWebVmEnvironment,
  clearWebVmScreen,
  exportWebVmHome,
  importWebVmFiles,
  resetWebVm,
  resizeWebVm,
  restartWebVm,
  sendWebVmText,
  subscribeWebVmOutput,
  useWebVM,
} from '../../services/webvm/session.js'
import { enableCrossOriginIsolation } from '../../services/webvm/coi.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { WebVmResetDialog } from './WebVmResetDialog.js'
import styles from './WebVM.module.css'

/** CheerpX 的 Linux 只有一个控制台；终端字号跟 NanoVM 保持一致 */
const FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Noto Sans Mono CJK SC', monospace"

type Palette = {
  background: string
  foreground: string
  cursor: string
  selection: string
}

const readPalette = (): Palette => {
  const computed = getComputedStyle(document.body)
  const read = (name: string, fallback: string) =>
    computed.getPropertyValue(name).trim() || fallback
  return {
    background: read('--dsw-alias-bg-base', '#ffffff'),
    foreground: read('--dsw-alias-label-primary', '#1f2329'),
    cursor: read('--dsw-alias-label-primary', '#1f2329'),
    selection: read('--dsw-alias-brand-primary', '#4d6bfe'),
  }
}

const xtermTheme = (palette: Palette) => ({
  background: palette.background,
  foreground: palette.foreground,
  cursor: palette.cursor,
  cursorAccent: palette.background,
  selectionBackground: palette.selection,
  black: '#1f2329',
  red: '#d93025',
  green: '#188038',
  yellow: '#b06000',
  blue: '#1a73e8',
  magenta: '#a142f4',
  cyan: '#007b83',
  white: '#e8eaed',
  brightBlack: '#5f6368',
  brightRed: '#f28b82',
  brightGreen: '#81c995',
  brightYellow: '#fdd663',
  brightBlue: '#8ab4f8',
  brightMagenta: '#d7aefb',
  brightCyan: '#78d9ec',
  brightWhite: '#ffffff',
})

const ONLINE_URL = 'https://chat-unrestricted.fur0.com/'

const openOnline = () => {
  // WebView 里 window.open 不会触发 shouldOverrideUrlLoading；直接赋值 location
  // 会让主框架导航被 shouldOverrideUrlLoading 接住，交给系统浏览器打开。
  window.location.assign(ONLINE_URL)
}

const statusTone = (status: string): 'ready' | 'loading' | 'error' | 'idle' => {
  if (status === 'ready') {
    return 'ready'
  }
  if (status === 'loading' || status === 'connecting' || status === 'booting') {
    return 'loading'
  }
  if (status === 'error') {
    return 'error'
  }
  return 'idle'
}

/**
 * WebVM 终端：xterm.js + CheerpX 的 VT100 控制台。
 *
 * 这个组件是懒加载的（xterm 与样式单独一个 chunk），只有真正切到 WebVM 时
 * 才会下载。切回 NanoVM 时组件保持挂载、仅用 CSS 隐藏，所以滚动历史与输入
 * 状态都还在；CheerpX 进程本身在 session 模块里，和面板开合无关。
 */
export const WebVmTerminal = ({
  visible,
  compact = false,
}: {
  visible: boolean
  compact?: boolean
}) => {
  const t = useTranslate()
  const status = useWebVM((state) => state.status)
  const detail = useWebVM((state) => state.detail)
  const error = useWebVM((state) => state.error)
  const bootMs = useWebVM((state) => state.bootMs)
  const startedAt = useWebVM((state) => state.startedAt)
  const coi = useWebVM((state) => state.coi)
  const coiReason = useWebVM((state) => state.coiReason)
  const busy = useWebVM((state) => state.busy)
  const clearToken = useWebVM((state) => state.clearToken)
  const autoBoot = useWebVMConfig((state) => state.autoBoot)
  const imageId = useWebVMConfig((state) => state.imageId)
  const customImageUrl = useWebVMConfig((state) => state.customImageUrl)

  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const [coiBusy, setCoiBusy] = useState(false)
  const [coiError, setCoiError] = useState<string | null>(null)
  const [resetOpen, setResetOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [envText, setEnvText] = useState('')
  const [envBusy, setEnvBusy] = useState(false)
  const importRef = useRef<HTMLInputElement>(null)
  const rootPending = useRef(false)
  const rootTail = useRef('')

  const booting = status === 'loading' || status === 'connecting' || status === 'booting'
  const webview = coi === 'unsupported' && coiReason === 'webview'

  // 启动计时：只用于给用户一个「已经等了多久」的反馈
  useEffect(() => {
    if (!booting || !startedAt) {
      setElapsed(0)
      return
    }
    setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    const timer = window.setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [booting, startedAt])

  // xterm 只创建一次；主题跟随应用明暗切换
  useEffect(() => {
    const host = hostRef.current
    if (!host) {
      return
    }
    const palette = readPalette()
    const terminal = new Terminal({
      cursorBlink: true,
      cursorStyle: 'block',
      fontFamily: FONT_FAMILY,
      fontSize: compact ? 12 : 13,
      lineHeight: 1.2,
      scrollback: 5000,
      // CheerpX 的 PTY 换行只发 LF；xterm 必须自己回到行首，否则每行都会向右错位
      convertEol: true,
      allowProposedApi: false,
      theme: xtermTheme(palette),
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(host)
    termRef.current = terminal
    fitRef.current = fit

    const textarea = terminal.textarea
    const onTerminalFocus = () => {
      if (!window.matchMedia('(pointer: coarse)').matches) {
        return
      }
      const resetScroll = () => {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0)
        }
      }
      resetScroll()
      requestAnimationFrame(resetScroll)
      window.setTimeout(resetScroll, 120)
    }
    textarea?.addEventListener('focus', onTerminalFocus)

    const write = subscribeWebVmOutput((chunk) => {
      terminal.write(chunk)
      if (rootPending.current) {
        rootTail.current = (rootTail.current + new TextDecoder().decode(chunk)).slice(-200)
        if (/password:/i.test(rootTail.current)) {
          rootPending.current = false
          rootTail.current = ''
          sendWebVmText('password\r')
        }
      }
      // 便于移动端排查滚动问题：记录当前 buffer 类型 / 行数 / 已滚动行数
      host.dataset.buffer = `${terminal.buffer.active.type}:${terminal.buffer.active.length}:${terminal.buffer.active.baseY}:${terminal.buffer.active.viewportY}`
    })
    host.dataset.scrollback = String(terminal.options.scrollback)
    const data = terminal.onData((value) => sendWebVmText(value))
    const scrollSync = terminal.onScroll(() => {
      host.dataset.viewportY = String(terminal.buffer.active.viewportY)
    })

    /*
     * xterm 6 的滚动条是自绘的，移动端没有原生 touch 滚动；这里按行把竖向滑动
     * 转成 scrollLines。桌面端滚轮仍由 xterm 自己处理，不会重复。
     */
    let lastTouchY = 0
    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 1) {
        lastTouchY = event.touches[0].clientY
      }
    }
    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return
      }
      const currentY = event.touches[0].clientY
      const delta = lastTouchY - currentY
      const row = host.querySelector('.xterm-rows > div')
      const cell = row ? row.getBoundingClientRect().height : 16
      const lines = Math.trunc(delta / Math.max(8, cell))
      if (lines !== 0) {
        terminal.scrollLines(lines)
        lastTouchY -= lines * Math.max(8, cell)
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      // xterm 自己的触摸处理可能 stopPropagation；在捕获阶段接管，避免双重滚动
      event.stopPropagation()
    }
    host.addEventListener('touchstart', onTouchStart, { passive: true, capture: true })
    host.addEventListener('touchmove', onTouchMove, { passive: false, capture: true })
    const resize = terminal.onResize(({ cols, rows }) => {
      window.clearTimeout(resizeTimer)
      resizeTimer = window.setTimeout(() => resizeWebVm(cols, rows), 150)
    })
    let resizeTimer = 0

    const applyTheme = () => {
      terminal.options.theme = xtermTheme(readPalette())
    }
    const observer = new MutationObserver(applyTheme)
    observer.observe(document.body, { attributes: true, attributeFilter: ['data-ds-dark-theme'] })

    const fitNow = () => {
      const rect = host.getBoundingClientRect()
      if (rect.width < 30 || rect.height < 30) {
        return
      }
      try {
        fit.fit()
      } catch {
        // 容器尺寸为 0 时 xterm 会抛错，等下一次 resize
        return
      }
      // 不要只依赖 onResize 的 150ms 防抖：CheerpX 启动前必须拿到终端的真实列数，
      // 否则 bash 会按默认 100 列格式化 help / 多列输出，在窄面板里错位折行。
      resizeWebVm(terminal.cols, terminal.rows)
      host.dataset.cols = String(terminal.cols)
      host.dataset.rows = String(terminal.rows)
    }
    const sizeObserver = new ResizeObserver(fitNow)
    sizeObserver.observe(host)
    fitNow()

    return () => {
      textarea?.removeEventListener('focus', onTerminalFocus)
      host.removeEventListener('touchstart', onTouchStart, { capture: true })
      host.removeEventListener('touchmove', onTouchMove, { capture: true })
      scrollSync.dispose()
      data.dispose()
      resize.dispose()
      write()
      observer.disconnect()
      sizeObserver.disconnect()
      window.clearTimeout(resizeTimer)
      terminal.dispose()
      termRef.current = null
      fitRef.current = null
    }
    // 只在挂载时创建；compact 变化通过重新挂载外层来生效
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 切回 WebVM 时重新适配尺寸（隐藏期间容器是 0×0）
  useEffect(() => {
    if (!visible) {
      return
    }
    const timer = window.setTimeout(() => {
      const host = hostRef.current
      if (!host) {
        return
      }
      try {
        fitRef.current?.fit()
      } catch {
        // 忽略尺寸瞬时错误
      }
      focusTerminal()
    }, 30)
    return () => window.clearTimeout(timer)
  }, [visible])

  useEffect(() => {
    if (clearToken > 0) {
      termRef.current?.clear()
    }
  }, [clearToken])

  // 软键盘弹出会让 visualViewport 连续 resize；部分 Android WebView 还会在
  // resize 之后再次把页面滚动到隐藏输入框。这里在键盘动画期间再兜底两次。
  useEffect(() => {
    if (!visible || !window.matchMedia('(pointer: coarse)').matches) {
      return
    }
    const viewport = window.visualViewport
    if (!viewport) {
      return
    }
    let timers: number[] = []
    const reset = () => {
      if (window.scrollY !== 0 || window.scrollX !== 0) {
        window.scrollTo(0, 0)
      }
    }
    const onResize = () => {
      reset()
      timers.push(window.setTimeout(reset, 180))
      timers.push(window.setTimeout(reset, 360))
    }
    viewport.addEventListener('resize', onResize)
    return () => {
      viewport.removeEventListener('resize', onResize)
      for (const timer of timers) {
        window.clearTimeout(timer)
      }
      timers = []
    }
  }, [visible])

  // 打开 WebVM 时按配置自动启动
  useEffect(() => {
    if (!visible || !autoBoot) {
      return
    }
    if (status === 'idle' && coi === 'isolated') {
      // 等一帧确保停靠/底部面板已完成布局，再把真实 cols 交给 CheerpX
      const timer = window.setTimeout(() => {
        prepareTerminalSize()
        void bootWebVm()
      }, 60)
      return () => window.clearTimeout(timer)
    }
    return undefined
  }, [autoBoot, coi, status, visible])

  // shell 就绪后再校准一次；启动期间容器尺寸可能刚稳定下来
  useEffect(() => {
    if (!visible || status !== 'ready') {
      return
    }
    const timer = window.setTimeout(() => {
      prepareTerminalSize()
    }, 80)
    return () => window.clearTimeout(timer)
  }, [status, visible])

  /**
   * 手机浏览器在 xterm 的隐藏 textarea 获得焦点时，会为了"把输入框滚进
   * 可视区"而滚动整个页面；底部面板虽然 fixed，终点位置仍会跟着偏移，
   * 看起来就是终端和输入法一起漂移。用 preventScroll 聚焦，并在下一帧
   * 把页面滚回原点；桌面端保持原行为。
   */
  const focusTerminal = () => {
    const term = termRef.current
    if (!term) {
      return
    }
    const textarea = term.textarea
    if (textarea) {
      textarea.focus({ preventScroll: true })
    } else {
      term.focus()
    }
    if (window.matchMedia('(pointer: coarse)').matches) {
      const resetScroll = () => {
        if (window.scrollY !== 0 || window.scrollX !== 0) {
          window.scrollTo(0, 0)
        }
      }
      resetScroll()
      requestAnimationFrame(resetScroll)
      window.setTimeout(resetScroll, 120)
    }
  }

  /** 启动前把 xterm 的真实行列数同步给 CheerpX，避免 shell 按默认 100 列排版 */
  const prepareTerminalSize = () => {
    const term = termRef.current
    if (!term) {
      return
    }
    try {
      fitRef.current?.fit()
    } catch {
      // 容器还没布局完，用当前尺寸
    }
    resizeWebVm(term.cols, term.rows)
    const host = hostRef.current
    if (host) {
      host.dataset.cols = String(term.cols)
      host.dataset.rows = String(term.rows)
    }
  }

  const start = () => {
    prepareTerminalSize()
    if (status === 'error') {
      void restartWebVm()
      return
    }
    void bootWebVm()
  }

  const enableCoi = async () => {
    setCoiBusy(true)
    setCoiError(null)
    try {
      await enableCrossOriginIsolation()
      // 正常路径会刷新页面；如果已经隔离，直接启动
      void bootWebVm()
    } catch (reason) {
      setCoiError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      setCoiBusy(false)
    }
  }

  const onImport = async (files: File[]) => {
    if (files.length === 0) {
      return
    }
    try {
      const result = await importWebVmFiles(files)
      showToast({ key: 'webvmImportDone', params: { count: result.count } })
    } catch (reason) {
      showToast({
        key: 'webvmImportFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  const onExport = async () => {
    try {
      const blob = await exportWebVmHome()
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'webvm-home.tar.gz'
      link.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      showToast({ key: 'webvmExportDone' })
    } catch (reason) {
      showToast({
        key: 'webvmExportFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  const checkEnv = async () => {
    setEnvOpen(true)
    setEnvBusy(true)
    try {
      setEnvText(await checkWebVmEnvironment())
    } catch (reason) {
      setEnvText(
        t('webvmEnvFailed', {
          reason: reason instanceof Error ? reason.message : String(reason),
        })
      )
    } finally {
      setEnvBusy(false)
    }
  }

  const reset = async () => {
    setResetOpen(false)
    try {
      await resetWebVm(true)
      showToast({ key: 'webvmResetDone' })
    } catch (reason) {
      showToast({
        key: 'webvmResetFailed',
        params: { reason: reason instanceof Error ? reason.message : String(reason) },
        type: 'error',
      })
    }
  }

  const imageLabel =
    imageId === 'custom'
      ? customImageUrl || t('webvmImageCustom')
      : imageId === 'debian-2023'
        ? t('webvmImageDebian2023')
        : t('webvmImageDebian')

  const statusText =
    status === 'loading'
      ? t('webvmStatusLoading')
      : status === 'connecting'
        ? t('webvmStatusConnecting')
        : status === 'booting'
          ? t('webvmStatusBooting')
          : status === 'ready'
            ? t('webvmStatusReady', { ms: bootMs ?? 0 })
            : status === 'error'
              ? t('webvmStatusError', { reason: error ?? '—' })
              : status === 'coi'
                ? coi === 'unsupported'
                  ? t('webvmStatusUnsupported')
                  : t('webvmStatusCoi')
                : t('webvmStatusIdle')

  const key = (value: string) => {
    sendWebVmText(value)
    focusTerminal()
  }

  const scrollPage = (direction: -1 | 1) => {
    termRef.current?.scrollPages(direction)
  }

  const paste = async () => {
    try {
      const text = await navigator.clipboard?.readText()
      if (!text) {
        return
      }
      sendWebVmText(text)
      focusTerminal()
    } catch {
      showToast({ key: 'webvmPasteFailed', type: 'error' })
    }
  }

  /** 一键切到 root：检测到 su 的 Password: 提示后再输入镜像 root 密码 */
  const becomeRoot = () => {
    rootPending.current = true
    rootTail.current = ''
    sendWebVmText('su - root\r')
    focusTerminal()
    window.setTimeout(() => {
      rootPending.current = false
      rootTail.current = ''
    }, 6000)
  }

  return (
    <div className={styles.wrap} data-status={status}>
      <div className={styles.statusRow}>
        <span className={styles.dot} data-status={statusTone(status)} aria-hidden />
        <span className={styles.statusText} title={statusText}>
          {statusText}
        </span>
        <span className={styles.imageLabel} title={imageLabel}>
          {imageLabel}
        </span>
        {busy ? (
          <span className={styles.busy}>
            {busy === 'import'
              ? t('webvmImport')
              : busy === 'export'
                ? t('webvmExport')
                : t('webvmEnvBusy')}
          </span>
        ) : null}
      </div>

      <div className={styles.stage}>
        <div
          ref={hostRef}
          className={styles.terminal}
          data-compact={compact ? 'true' : undefined}
          onClick={focusTerminal}
          role="application"
          aria-label={t('webvmTabLabel')}
        />

        {status === 'coi' ? (
          <div className={styles.overlay}>
            <div className={styles.card}>
              <div className={styles.cardTitle}>
                {webview ? t('webvmUnsupportedTitle') : t('webvmCoiTitle')}
              </div>
              {webview ? null : <div className={styles.cardText}>{t('webvmCoiHint')}</div>}
              {webview ? (
                <>
                  <div className={styles.error}>{t('webvmCoiWebView')}</div>
                  <div className={styles.note}>{t('webvmBrowserHint')}</div>
                </>
              ) : coi === 'unsupported' ? (
                <div className={styles.error}>{t('webvmCoiUnsupported')}</div>
              ) : null}
              {coiError ? <div className={styles.error}>{coiError}</div> : null}
              <div className={styles.cardActions}>
                {coi === 'registerable' ? (
                  <button
                    type="button"
                    className={styles.primary}
                    disabled={coiBusy}
                    onClick={() => void enableCoi()}
                  >
                    {coiBusy ? t('webvmCoiReloading') : t('webvmCoiButton')}
                  </button>
                ) : null}
                {webview ? (
                  <button type="button" className={styles.primary} onClick={openOnline}>
                    {t('webvmOpenBrowser')}
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => openSettings('nanovm')}
                >
                  {t('settings')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {status === 'idle' ? (
          <div className={styles.overlay}>
            <div className={styles.card}>
              <div className={styles.cardTitle}>{t('webvmTitle')}</div>
              <div className={styles.cardText}>{t('webvmStartHint')}</div>
              <div className={styles.cardActions}>
                <button type="button" className={styles.primary} onClick={start}>
                  {t('webvmStart')}
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => openSettings('nanovm')}
                >
                  {t('settings')}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {booting ? (
          <div className={styles.overlay}>
            <div className={styles.card}>
              <div className={styles.cardTitle}>
                <span className={styles.spinner} aria-hidden />
                {t('webvmTitle')}
              </div>
              <div className={styles.cardText}>{detail ?? statusText}</div>
              <div className={styles.progressLine}>
                {t('webvmBootElapsed', { seconds: elapsed })}
              </div>
              <div className={styles.bar} aria-hidden>
                <span />
              </div>
              <div className={styles.note}>{t('webvmStartHint')}</div>
            </div>
          </div>
        ) : null}

        {status === 'error' ? (
          <div className={styles.overlay}>
            <div className={styles.card}>
              <div className={styles.cardTitle}>{t('webvmErrorTitle')}</div>
              <div className={styles.error}>{error ?? '—'}</div>
              <div className={styles.cardActions}>
                <button type="button" className={styles.primary} onClick={start}>
                  {t('webvmRetry')}
                </button>
                <button
                  type="button"
                  className={styles.secondary}
                  onClick={() => setResetOpen(true)}
                >
                  {t('webvmReset')}
                </button>
              </div>
              <div className={styles.note}>{t('webvmNoNetwork')}</div>
            </div>
          </div>
        ) : null}
      </div>

      {envOpen ? (
        <div className={styles.envPanel}>
          <div className={styles.envHead}>
            <span>{t('webvmEnv')}</span>
            <button type="button" className={styles.linkButton} onClick={() => setEnvOpen(false)}>
              {t('close')}
            </button>
          </div>
          <pre className={styles.envPre}>{envBusy ? t('webvmEnvBusy') : envText}</pre>
        </div>
      ) : null}

      <div className={styles.toolbar} data-compact={compact ? 'true' : undefined}>
        <button type="button" className={styles.tool} onClick={() => key('\x1b')}>
          Esc
        </button>
        <button type="button" className={styles.tool} onClick={() => key('\t')}>
          Tab
        </button>
        <button type="button" className={styles.tool} onClick={() => key('\x03')}>
          Ctrl+C
        </button>
        <button type="button" className={styles.tool} onClick={() => key('\x04')}>
          Ctrl+D
        </button>
        <button
          type="button"
          className={styles.tool}
          title={t('webvmScrollUp')}
          onClick={() => scrollPage(-1)}
        >
          PgUp
        </button>
        <button
          type="button"
          className={styles.tool}
          title={t('webvmScrollDown')}
          onClick={() => scrollPage(1)}
        >
          PgDn
        </button>
        <button
          type="button"
          className={styles.tool}
          title={t('webvmBecomeRoot')}
          onClick={becomeRoot}
        >
          Root
        </button>
        <button type="button" className={styles.tool} onClick={() => void paste()}>
          {t('webvmPaste')}
        </button>
        <button type="button" className={styles.tool} onClick={() => key('\x1b[A')}>
          ↑
        </button>
        <button type="button" className={styles.tool} onClick={() => key('\x1b[B')}>
          ↓
        </button>
        <button type="button" className={styles.tool} onClick={focusTerminal}>
          {t('webvmKeyboard')}
        </button>
        <span className={styles.toolSpacer} />
        <button
          type="button"
          className={styles.tool}
          disabled={busy !== null || status === 'coi'}
          onClick={() => importRef.current?.click()}
        >
          {t('webvmImport')}
        </button>
        <button
          type="button"
          className={styles.tool}
          disabled={busy !== null || status !== 'ready'}
          onClick={() => void onExport()}
        >
          {t('webvmExport')}
        </button>
        <button
          type="button"
          className={styles.tool}
          disabled={status === 'coi'}
          onClick={() => void checkEnv()}
        >
          {t('webvmEnv')}
        </button>
        <button type="button" className={styles.tool} onClick={clearWebVmScreen}>
          {t('webvmClear')}
        </button>
        <button
          type="button"
          className={styles.tool}
          disabled={status === 'coi' || status === 'idle'}
          onClick={() => setResetOpen(true)}
        >
          {t('webvmReset')}
        </button>
        <button type="button" className={styles.tool} onClick={() => openSettings('nanovm')}>
          {t('webvmSettingsTitle')}
        </button>
      </div>
      <div className={styles.tip}>{t('webvmTerminalHint')}</div>

      <input
        ref={importRef}
        type="file"
        multiple
        hidden
        onChange={(event) => {
          const files = Array.from(event.target.files ?? [])
          event.target.value = ''
          void onImport(files)
        }}
      />
      {resetOpen ? (
        <WebVmResetDialog onClose={() => setResetOpen(false)} onConfirm={() => void reset()} />
      ) : null}
    </div>
  )
}
