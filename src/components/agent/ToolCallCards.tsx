import clsx from 'clsx'
import { useState } from 'react'
import { useTranslate, type TranslationKey } from '../../i18n/index.js'
import type { ToolArtifact } from '../../services/agent/tools.js'
import { summarizeToolInput, toolDuration, type ChatToolCall } from '../../services/agent/types.js'
import { IconCheckOutline16, IconWarningOutline16, IconDownloadOutline16 } from '../base/icons.js'
import { GenuiCard } from './GenuiCard.js'
import styles from './ToolCallCards.module.css'

/**
 * 回复里的浏览器工具卡片。
 *
 * 三块内容：调用摘要（工具名 + 参数 + 状态 + 耗时）、结果预览（可折叠）、产物。
 * 产物分两种：file 给预览与下载，widget 直接塞进沙箱 iframe 渲染。
 * 沙箱只给 allow-scripts，不给 allow-same-origin，组件拿不到聊天页面的数据。
 */

const STATUS_LABEL: Record<ChatToolCall['status'], TranslationKey> = {
  running: 'toolStatusRunning',
  done: 'toolStatusDone',
  error: 'toolStatusError',
  rejected: 'toolStatusRejected',
}

const DownloadButton = ({ artifact }: { artifact: ToolArtifact }) => {
  const t = useTranslate()
  const download = () => {
    const blob = new Blob([artifact.text], { type: artifact.mime })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = artifact.name
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }
  return (
    <button type="button" className={styles.artifactButton} onClick={download}>
      <IconDownloadOutline16 />
      {t('toolArtifactDownload')}
    </button>
  )
}

const ArtifactCard = ({ artifact }: { artifact: ToolArtifact }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  if (artifact.kind === 'widget') {
    return (
      <div className={styles.widget}>
        <iframe
          className={styles.widgetFrame}
          title={artifact.name}
          sandbox="allow-scripts allow-forms allow-popups"
          srcDoc={artifact.text}
          loading="lazy"
        />
        <div className={styles.widgetActions}>
          <DownloadButton artifact={artifact} />
        </div>
      </div>
    )
  }
  if (artifact.kind === 'genui') {
    return (
      <div className={styles.genui}>
        <GenuiCard text={artifact.text} title={artifact.name.replace(/\.genui\.json$/, '')} />
        <div className={styles.widgetActions}>
          <DownloadButton artifact={artifact} />
        </div>
      </div>
    )
  }
  return (
    <div className={styles.artifact}>
      <div className={styles.artifactHead}>
        <span className={styles.artifactName} title={artifact.name}>
          {artifact.name}
        </span>
        <span className={styles.artifactSize}>{artifact.size} B</span>
        <button
          type="button"
          className={styles.artifactButton}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? t('toolArtifactHide') : t('toolArtifactPreview')}
        </button>
        <DownloadButton artifact={artifact} />
      </div>
      {open ? (
        <pre className={styles.artifactPreview} aria-label={artifact.name}>
          {artifact.text.length > 20_000
            ? `${artifact.text.slice(0, 20_000)}\n\n…（已截断预览）`
            : artifact.text}
        </pre>
      ) : null}
    </div>
  )
}

const ToolCallCard = ({ call }: { call: ChatToolCall }) => {
  const t = useTranslate()
  const [open, setOpen] = useState(false)
  const duration = toolDuration(call)
  const failed = call.status === 'error' || call.status === 'rejected'
  return (
    <div className={styles.card} data-status={call.status}>
      <button
        type="button"
        className={styles.head}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className={styles.statusIcon} aria-hidden>
          {failed ? <IconWarningOutline16 /> : <IconCheckOutline16 />}
        </span>
        <span className={styles.label}>{call.label}</span>
        <span className={styles.summary}>{summarizeToolInput(call)}</span>
        <span className={styles.meta}>
          {duration ? <span className={styles.duration}>{duration}</span> : null}
          <span className={styles.status}>{t(STATUS_LABEL[call.status])}</span>
        </span>
      </button>
      {call.detail && call.status === 'running' ? (
        <div className={styles.detail}>{call.detail}</div>
      ) : null}
      {open ? (
        <div className={styles.body}>
          <div className={styles.bodyTitle}>{t('toolInputTitle')}</div>
          <pre className={styles.input}>{JSON.stringify(call.input, null, 2)}</pre>
          {call.content ? (
            <>
              <div className={styles.bodyTitle}>{t('toolResultTitle')}</div>
              <pre className={styles.result}>{call.content}</pre>
            </>
          ) : null}
        </div>
      ) : null}
      {call.artifacts?.length ? (
        <div className={styles.artifacts}>
          {call.artifacts.map((artifact) => (
            <ArtifactCard key={artifact.id} artifact={artifact} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 一条回复里的全部工具调用；没有调用时返回 null */
export const ToolCallCards = ({ calls }: { calls: ChatToolCall[] | undefined }) => {
  if (!calls || calls.length === 0) {
    return null
  }
  return (
    <div className={clsx(styles.list)} aria-label="tool calls">
      {calls.map((call) => (
        <ToolCallCard key={call.id} call={call} />
      ))}
    </div>
  )
}
