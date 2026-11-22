import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { useUnkernelConfig } from '../../services/unkernel/config.js'
import { openUnkernel, useUnkernel } from '../../services/unkernel/session.js'
import styles from './PullToUnkernel.module.css'

/** 触发下拉进入的累计距离（桌面滚轮 / 手机拖动） */
const WHEEL_THRESHOLD = 240
const TOUCH_THRESHOLD = 96
/** 滚轮累计在这么久的停顿后清零 */
const WHEEL_RESET_MS = 900

const isEditableTarget = (target: EventTarget | null): boolean => {
  const el = target instanceof Element ? target : null
  return !!el?.closest(
    'input, textarea, select, button, a, pre, code, [contenteditable="true"], [role="dialog"], #panel, #terms'
  )
}

const scrollableTarget = (target: EventTarget | null): HTMLElement | null => {
  const el = target instanceof Element ? target : null
  return el?.closest<HTMLElement>('[data-unkernel-pull]') ?? null
}

/**
 * 从聊天主页面下拉进入 Unkernel Linux。
 *
 * 桌面端在顶部继续向上滚（下拉过冲），手机端用纵向拖动；只在聊天滚动区位于顶部、
 * 没有打开对话框 / 文本选中时触发，避免和正常滚动、输入框冲突。
 */
export const PullToUnkernel = () => {
  const t = useTranslate()
  const enabled = useUnkernelConfig((state) => state.enabled)
  const open = useUnkernel((state) => state.open)
  const [progress, setProgress] = useState(0)
  const [touched, setTouched] = useState(false)
  const state = useRef({
    wheel: 0,
    wheelAt: 0,
    startY: 0,
    pulling: false,
    fired: false,
    hideTimer: 0 as ReturnType<typeof setTimeout> | 0,
  })

  useEffect(() => {
    if (!enabled || open) {
      setProgress(0)
      setTouched(false)
      return
    }
    const reset = () => {
      state.current.wheel = 0
      state.current.wheelAt = 0
      state.current.pulling = false
      state.current.fired = false
      if (state.current.hideTimer) {
        clearTimeout(state.current.hideTimer)
        state.current.hideTimer = 0
      }
      setProgress(0)
      setTouched(false)
    }

    const blocked = (target: EventTarget | null) =>
      isEditableTarget(target) || (window.getSelection()?.toString().length ?? 0) > 0

    const onWheel = (event: WheelEvent) => {
      if (event.deltaY >= 0 || blocked(event.target)) {
        return
      }
      const scroll = scrollableTarget(event.target)
      if (!scroll || scroll.scrollTop > 0) {
        return
      }
      const now = Date.now()
      if (now - state.current.wheelAt > WHEEL_RESET_MS) {
        state.current.wheel = 0
      }
      state.current.wheelAt = now
      state.current.wheel = Math.min(WHEEL_THRESHOLD, state.current.wheel - event.deltaY)
      const next = state.current.wheel / WHEEL_THRESHOLD
      setProgress(next)
      setTouched(true)
      if (state.current.hideTimer) {
        clearTimeout(state.current.hideTimer)
      }
      state.current.hideTimer = setTimeout(() => {
        state.current.wheel = 0
        state.current.wheelAt = 0
        state.current.hideTimer = 0
        setProgress(0)
        setTouched(false)
      }, WHEEL_RESET_MS)
      if (next >= 1 && !state.current.fired) {
        state.current.fired = true
        reset()
        openUnkernel()
      }
    }

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length !== 1 || blocked(event.target)) {
        state.current.pulling = false
        return
      }
      const scroll = scrollableTarget(event.target)
      if (!scroll || scroll.scrollTop > 0) {
        state.current.pulling = false
        return
      }
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      state.current.startY = touch.clientY
      state.current.pulling = true
    }

    const onTouchMove = (event: TouchEvent) => {
      if (!state.current.pulling || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      if (!touch) {
        return
      }
      const dy = touch.clientY - state.current.startY
      if (dy <= 0) {
        setProgress(0)
        return
      }
      if (event.cancelable) {
        event.preventDefault()
      }
      setTouched(true)
      setProgress(Math.min(1, dy / TOUCH_THRESHOLD))
    }

    const onTouchEnd = () => {
      const pulling = state.current.pulling
      state.current.pulling = false
      const reached = progressRef.current >= 1
      if (pulling && reached && !state.current.fired) {
        state.current.fired = true
        reset()
        openUnkernel()
      } else {
        setProgress(0)
        setTouched(false)
      }
    }

    window.addEventListener('wheel', onWheel, { passive: true })
    window.addEventListener('touchstart', onTouchStart, { passive: true })
    window.addEventListener('touchmove', onTouchMove, { passive: false })
    window.addEventListener('touchend', onTouchEnd, { passive: true })
    window.addEventListener('touchcancel', reset, { passive: true })
    const current = state.current
    return () => {
      if (current.hideTimer) {
        clearTimeout(current.hideTimer)
        current.hideTimer = 0
      }
      window.removeEventListener('wheel', onWheel)
      window.removeEventListener('touchstart', onTouchStart)
      window.removeEventListener('touchmove', onTouchMove)
      window.removeEventListener('touchend', onTouchEnd)
      window.removeEventListener('touchcancel', reset)
    }
  }, [enabled, open])

  // 事件处理函数里读取最新进度，避免闭包捕获旧值
  const progressRef = useRef(progress)
  progressRef.current = progress

  if (!enabled || open || progress <= 0) {
    return null
  }
  return (
    <div
      className={styles.pull}
      data-touch={touched || undefined}
      aria-hidden="true"
      style={{ '--pull-progress': progress } as CSSProperties}
    >
      <div className={styles.track}>
        <span className={styles.fill} />
      </div>
      <span className={styles.label}>
        {progress >= 1 ? t('pullUnkernelRelease') : t('pullUnkernelHint')}
      </span>
    </div>
  )
}
