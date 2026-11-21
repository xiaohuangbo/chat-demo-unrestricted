import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './AvatarCropModal.module.css'

const VIEWPORT_SIZE = 240
const OUTPUT_SIZE = 384

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/**
 * 头像裁剪弹窗：圆形取景框 + 拖拽平移 + 缩放滑块，输出 384×384 JPEG Data URL。
 *
 * 图片先按短边铺满取景框，再允许 1–4 倍缩放；圆形遮罩外的区域半透明变暗，
 * 让用户看到真正的圆形裁剪结果，而不是把方形图片直接塞进圆形头像位。
 */
export const AvatarCropModal = ({
  file,
  onClose,
  onConfirm,
}: {
  file: File
  onClose: () => void
  onConfirm: (dataUrl: string) => void
}) => {
  const t = useTranslate()
  const [imageUrl, setImageUrl] = useState<string | null>(null)
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null)
  const [loadError, setLoadError] = useState(false)
  const [zoom, setZoom] = useState(1)
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const imgRef = useRef<HTMLImageElement | null>(null)
  const dragRef = useRef<{
    pointerId: number
    startX: number
    startY: number
    originX: number
    originY: number
  } | null>(null)

  useEffect(() => {
    const url = URL.createObjectURL(file)
    setImageUrl(url)
    setZoom(1)
    setPan({ x: 0, y: 0 })
    setNaturalSize(null)
    setLoadError(false)
    return () => {
      URL.revokeObjectURL(url)
    }
  }, [file])

  const baseScale = naturalSize ? VIEWPORT_SIZE / Math.min(naturalSize.w, naturalSize.h) : 1
  const drawnW = naturalSize ? naturalSize.w * baseScale * zoom : VIEWPORT_SIZE
  const drawnH = naturalSize ? naturalSize.h * baseScale * zoom : VIEWPORT_SIZE
  const maxPanX = Math.max(0, (drawnW - VIEWPORT_SIZE) / 2)
  const maxPanY = Math.max(0, (drawnH - VIEWPORT_SIZE) / 2)
  const clampedX = clamp(pan.x, -maxPanX, maxPanX)
  const clampedY = clamp(pan.y, -maxPanY, maxPanY)

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!naturalSize) {
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: clampedX,
      originY: clampedY,
    }
  }

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) {
      return
    }
    setPan({
      x: clamp(drag.originX + (event.clientX - drag.startX), -maxPanX, maxPanX),
      y: clamp(drag.originY + (event.clientY - drag.startY), -maxPanY, maxPanY),
    })
  }

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === event.pointerId) {
      dragRef.current = null
    }
  }

  const handleConfirm = () => {
    const img = imgRef.current
    if (!img || !naturalSize) {
      return
    }
    const canvas = document.createElement('canvas')
    canvas.width = OUTPUT_SIZE
    canvas.height = OUTPUT_SIZE
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      return
    }
    // 取景框内容等比缩放到输出尺寸；圆外像素填白，头像列表再用圆形裁切显示
    const ratio = OUTPUT_SIZE / VIEWPORT_SIZE
    const dx = (VIEWPORT_SIZE / 2 + clampedX - drawnW / 2) * ratio
    const dy = (VIEWPORT_SIZE / 2 + clampedY - drawnH / 2) * ratio
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, OUTPUT_SIZE, OUTPUT_SIZE)
    ctx.drawImage(img, dx, dy, drawnW * ratio, drawnH * ratio)
    onConfirm(canvas.toDataURL('image/jpeg', 0.9))
  }

  return (
    <Modal
      title={t('avatarCropTitle')}
      closable
      onClose={onClose}
      footer={
        <>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button disabled={!naturalSize || loadError} onClick={handleConfirm}>
            {t('avatarCropConfirm')}
          </Button>
        </>
      }
    >
      <div className={styles.cropContainer}>
        <div
          className={styles.cropStage}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
        >
          {imageUrl && !loadError ? (
            <img
              ref={imgRef}
              src={imageUrl}
              alt=""
              className={styles.cropImage}
              style={{
                width: `${drawnW}px`,
                height: `${drawnH}px`,
                transform: `translate3d(calc(-50% + ${clampedX}px), calc(-50% + ${clampedY}px), 0)`,
              }}
              onLoad={(event) => {
                const target = event.currentTarget
                setLoadError(false)
                setNaturalSize({
                  w: target.naturalWidth || target.width,
                  h: target.naturalHeight || target.height,
                })
              }}
              onError={() => {
                setLoadError(true)
                setNaturalSize(null)
              }}
            />
          ) : null}
          <div className={styles.cropMask} aria-hidden />
        </div>
        <div className={styles.cropControls}>
          <span className={styles.cropHint}>
            {loadError ? t('avatarCropLoadFailed') : t('avatarCropHint')}
          </span>
          <label className={styles.cropSliderRow}>
            <span>{t('avatarCropZoom')}</span>
            <input
              type="range"
              min={1}
              max={4}
              step={0.05}
              value={zoom}
              onChange={(event) => {
                const nextZoom = Number(event.target.value)
                if (naturalSize) {
                  const nextDrawnW = naturalSize.w * baseScale * nextZoom
                  const nextDrawnH = naturalSize.h * baseScale * nextZoom
                  const nextMaxPanX = Math.max(0, (nextDrawnW - VIEWPORT_SIZE) / 2)
                  const nextMaxPanY = Math.max(0, (nextDrawnH - VIEWPORT_SIZE) / 2)
                  setPan((prev) => ({
                    x: clamp(prev.x, -nextMaxPanX, nextMaxPanX),
                    y: clamp(prev.y, -nextMaxPanY, nextMaxPanY),
                  }))
                }
                setZoom(nextZoom)
              }}
            />
          </label>
        </div>
      </div>
    </Modal>
  )
}
