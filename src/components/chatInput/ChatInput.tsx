import clsx from 'clsx'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import {
  IconAttachmentOutline22,
  IconCameraOutline22,
  IconDataOutline16,
  IconGalleryOutline22,
  IconGlobeLanguageOutline14,
  IconPaperclipOutline16,
  IconPlusOutline18,
  IconRefreshOutline16,
  IconSendOutline16,
  IconStopFill16,
} from '../base/icons.js'
import {
  matchesRefusalKeyword,
  setAutoJailbreak,
  setSearch,
  useSettings,
} from '../../services/settings.js'
import { useIsMobile } from '../../app/viewport.js'
import { sendMessage, stopReply, useChatStore } from '../../services/chat/store.js'
import {
  addDraftFiles,
  EMPTY_DRAFT,
  getDraft,
  prepareDraftMessage,
  removeDraftAttachment,
  restartDraftAttachment,
  retryDraftAttachment,
  setDraftText,
  syncDraftSidecars,
  useDrafts,
} from '../../services/chat/drafts.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconButton } from '../base/IconButton.js'
import { Tooltip } from '../base/Tooltip.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import { isLocalModel } from '../../services/local/catalog.js'
import { isAndroidApp } from '../../services/update.js'
import { openStats } from '../session/statsDialogState.js'
import { DragMask, useFileDrop } from './DragMask.js'
import { showToast } from '../base/toastState.js'
import { acceptFilesAttr, useUploads } from '../../services/attachments.js'
import { DraftAttachments } from './DraftAttachments.js'
import { useVoiceInput } from './useVoiceInput.js'
import { VoiceButton } from './VoiceButton.js'
import { ParseltongueButton } from './ParseltonguePanel.js'
import { CustomCotButton } from './CustomCotPanel.js'
import { ModelPicker } from './ModelPicker.js'
import { RolePicker } from '../companion/RolePicker.js'
import { ModePicker } from './ModePicker.js'
import { ThinkingSlider } from './ThinkingSlider.js'
import { ContextRing } from './ContextRing.js'
import { Spectrum } from './Spectrum.js'
import { useTranslate } from '../../i18n/index.js'
import styles from './ChatInput.module.css'

/** 输入框：自适应高度的文本框 + 文件 + 深度思考与智能搜索开关 + 语音输入 + 发送 / 停止 */
export const ChatInput = memo(function ChatInput({ sessionId }: { sessionId: string | null }) {
  // 切换目标时释放录音、转写和 DOM 状态；文字与附件由草稿服务保留。
  return <Input key={sessionId === null ? 'new' : `session:${sessionId}`} sessionId={sessionId} />
})

const Input = ({ sessionId }: { sessionId: string | null }) => {
  const t = useTranslate()
  const draft = useDrafts((state) => state.drafts.get(sessionId) ?? EMPTY_DRAFT)
  const { text, attachments } = draft
  const setText = (value: string) => setDraftText(sessionId, value)
  const localModel = useSettings((state) => isLocalModel(state.model))
  const draftReady = useUploads(
    (state) => prepareDraftMessage(draft, state.tasks, localModel) !== null
  )
  const streaming = useChatStore(
    (state) => sessionId !== null && Object.hasOwn(state.streaming, sessionId)
  )
  const importingHistory = useChatStore((state) => state.importingHistory)
  const isMobile = useIsMobile()
  const search = useSettings((state) => state.search)
  const autoJailbreak = useSettings((state) => state.autoJailbreak)
  const attachmentPoisonEnabled = useSettings((state) => state.attachmentPoison.enabled)
  const attachmentPoisonSidecar = useSettings((state) =>
    state.attachmentPoison.methods.includes('sidecar')
  )
  // 只跟随启用状态与伴随附件开关，避免在设置里每敲一个字都重传伴随附件
  const sidecarMode = `${attachmentPoisonEnabled ? 1 : 0}:${attachmentPoisonSidecar ? 1 : 0}`
  const lastSidecarMode = useRef(sidecarMode)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const cameraInputRef = useRef<HTMLInputElement>(null)
  const galleryInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  // 只有安卓壳里才把回形针换成「+」拍照 / 相册 / 文件面板，桌面网页保持原样
  const androidApp = isAndroidApp()
  const [plusOpen, setPlusOpen] = useState(false)

  /** 选附件前先确认可用的 API Key；本地模型不需要 */
  const canPickFiles = () => isLocalModel(useSettings.getState().model) || ensureApiKey()

  const acceptFiles = (files: File[]) => {
    // 本地模型不需要 API Key：文本附件在发送时由页面直接读取
    const needsKey = !isLocalModel(useSettings.getState().model)
    if (
      files.length === 0 ||
      useChatStore.getState().importingHistory ||
      (needsKey && !ensureApiKey())
    ) {
      return
    }
    const error = addDraftFiles(sessionId, files, useSettings.getState().apiKey ?? '')
    if (error) {
      showToast(error)
    }
  }
  const retryFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory && ensureApiKey()) {
        retryDraftAttachment(sessionId, id, useSettings.getState().apiKey ?? '')
      }
    },
    [sessionId]
  )
  const removeFile = useCallback(
    (id: string) => {
      if (!useChatStore.getState().importingHistory) {
        removeDraftAttachment(sessionId, id)
      }
    },
    [sessionId]
  )
  const dragging = useFileDrop(acceptFiles)

  /** 转写结果插入到光标处，并把光标移到插入内容之后 */
  const voice = useVoiceInput((transcript) => {
    const textarea = textareaRef.current
    const current = getDraft(sessionId).text
    const start = textarea?.selectionStart ?? current.length
    const end = textarea?.selectionEnd ?? current.length
    setText(current.slice(0, start) + transcript + current.slice(end))
    requestAnimationFrame(() => {
      textarea?.focus({ preventScroll: true })
      textarea?.setSelectionRange(start + transcript.length, start + transcript.length)
    })
  }, sessionId)

  // 欢迎页导入后会话 ID 不变，不能依赖卸载取消语音；订阅开始事件也覆盖快速完成的导入。
  const cancelVoice = voice.cancel
  useEffect(
    () =>
      useChatStore.subscribe((state, previous) => {
        if (state.importingHistory && !previous.importingHistory) {
          cancelVoice()
        }
      }),
    [cancelVoice]
  )

  // 移动端录音时用频谱替代输入框内容
  const recording = voice.status === 'recording'

  // 附件投毒启用状态或伴随附件开关变化时：同步伴随附件，并按当前配置重新上传原附件
  useEffect(() => {
    if (lastSidecarMode.current === sidecarMode) {
      return
    }
    lastSidecarMode.current = sidecarMode
    const apiKey = useSettings.getState().apiKey ?? ''
    syncDraftSidecars(sessionId, apiKey)
    for (const attachment of getDraft(sessionId).attachments) {
      if (!attachment.generated) {
        restartDraftAttachment(sessionId, attachment.id, apiKey)
      }
    }
  }, [sessionId, sidecarMode])

  // 排队、上传中或上传失败的附件都留在输入框，全部上传成功后才能发送
  const canSend = !importingHistory && !streaming && voice.status === 'idle' && draftReady

  const send = () => {
    if (
      useChatStore.getState().importingHistory ||
      voice.status !== 'idle' ||
      !prepareDraftMessage(getDraft(sessionId), useUploads.getState().tasks, localModel)
    ) {
      return
    }
    // 文本与上传完成态由提交动作读取最新快照，不使用上一次渲染的草稿。
    // 关键词拒答与本地模型（WebLLM / MLC-LLM）都在本地或自建服务上生成，不需要 API Key。
    const needsApiKey = !matchesRefusalKeyword(text) && !isLocalModel(useSettings.getState().model)
    if ((needsApiKey && !ensureApiKey()) || !sendMessage(sessionId)) {
      return
    }
    stopReadAloud()
    if (isMobile) {
      textareaRef.current?.blur()
    } else {
      textareaRef.current?.focus()
    }
  }

  /*
   * 思维链 / 智能搜索 / 深度思考三个开关。
   * 桌面端接在模式胶囊后面（同一排），手机端放进 .advanced 单独一排并显示文字标签，
   * 这样窄屏也能一眼看到功能名，而不是只看到一个无文字的圆图标。
   */
  const jailbreakToggle = (
    <Tooltip content={t('autoJailbreakTooltip')}>
      <button
        type="button"
        className={clsx(styles.toggle, styles.wideToggle, autoJailbreak && styles.selected)}
        aria-label={t('autoJailbreak')}
        aria-pressed={autoJailbreak}
        onClick={() => setAutoJailbreak(!autoJailbreak)}
      >
        <IconRefreshOutline16 />
        <span className={styles.toggleLabel}>{t('autoJailbreak')}</span>
      </button>
    </Tooltip>
  )

  const parseltongueToggle = (
    <Tooltip content={t('parseltongueToggleTooltip')}>
      <ParseltongueButton
        text={text}
        triggerClassName={clsx(styles.toggle, styles.wideToggle)}
        selectedClassName={styles.selected}
        labelClassName={styles.toggleLabel}
      />
    </Tooltip>
  )

  const advanced = (
    <>
      <CustomCotButton
        triggerClassName={styles.toggle}
        selectedClassName={styles.selected}
        labelClassName={styles.toggleLabel}
      />
      <Tooltip content={t('deactivatedSearchTooltip')}>
        <button
          type="button"
          className={clsx(styles.toggle, search && styles.selected)}
          aria-label={t('search')}
          aria-pressed={search}
          onClick={() => setSearch(!search)}
        >
          <IconGlobeLanguageOutline14 />
          <span className={styles.toggleLabel}>{t('search')}</span>
        </button>
      </Tooltip>
      <ThinkingSlider />
    </>
  )

  return (
    <div
      className={clsx(styles.wrapper, sessionId === null ? styles.home : styles.session)}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          textareaRef.current?.focus({ preventScroll: true })
        }
      }}
    >
      <DraftAttachments items={attachments} onRetry={retryFile} onRemove={removeFile} />
      <div className={styles.textareaWrapper}>
        <textarea
          ref={textareaRef}
          className={clsx(styles.textarea, recording && isMobile && styles.textareaHidden)}
          placeholder={t('chatInputPlaceholderChat')}
          rows={2}
          // 移动端不自动聚焦，避免一打开就弹出键盘
          autoFocus={!isMobile}
          disabled={importingHistory}
          value={text}
          onChange={(event) => setText(event.target.value)}
          onMouseDown={(event) => {
            // 首次点击时手动聚焦，避免 Safari 把整个页面滚到输入框位置。
            if (isMobile && event.button === 0 && document.activeElement !== event.currentTarget) {
              event.preventDefault()
              event.currentTarget.focus({ preventScroll: true })
            }
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              send()
            }
          }}
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files)
            if (files.length > 0) {
              event.preventDefault()
              acceptFiles(files)
            }
          }}
        />
        {recording && isMobile ? <Spectrum getAnalyser={voice.getAnalyser} /> : null}
        <div className={styles.mirror} aria-hidden>
          {`${text}\n`}
        </div>
      </div>
      <div className={styles.functionRow}>
        {/*
          桌面端：第一排模型 / 自动越狱 / 扰动，第二排在 toolbarBreak 之后放模式、
          思维链、智能搜索与深度思考（和 v2.6.x 完全一致）。
          手机端：第一排仍是模型 / 模式 / 自动越狱 / 扰动的横向滚动条，
          思维链 / 智能搜索 / 深度思考单独成排（.advanced），带文字标签，
          和发送按钮那一排上下相邻——不再藏在滚动条最右端。
        */}
        <div className={styles.toggles}>
          <ModelPicker />
          <RolePicker sessionId={sessionId} />
          <span className={styles.toolbarDivider} aria-hidden />
          {isMobile ? null : (
            <>
              {jailbreakToggle}
              {parseltongueToggle}
            </>
          )}
          {/* 桌面端在此换行：下面的模式与三个开关占第二排 */}
          {isMobile ? null : <span className={styles.toolbarBreak} aria-hidden />}
          <ModePicker
            triggerClassName={styles.toggle}
            selectedClassName={styles.selected}
            labelClassName={styles.toggleLabel}
          />
          {isMobile ? null : advanced}
        </div>
        {isMobile ? (
          <div className={styles.advanced}>
            {jailbreakToggle}
            {parseltongueToggle}
            {advanced}
          </div>
        ) : null}
        <div className={styles.right}>
          <ContextRing sessionId={sessionId} streaming={streaming} onOpen={openStats} />
          <IconButton
            className={styles.statsButton}
            size="m"
            tone="tertiary"
            icon={<IconDataOutline16 />}
            tooltip={t('statsOpen')}
            onClick={openStats}
          />
          <VoiceButton
            status={voice.status}
            disabled={!voice.available}
            seconds={voice.seconds}
            onClick={() => {
              if (
                voice.status !== 'idle' ||
                (!useChatStore.getState().importingHistory && ensureApiKey())
              ) {
                void voice.toggle()
              }
            }}
          />
          {androidApp ? (
            <Tooltip content={t('chatInputMoreActions')}>
              <button
                type="button"
                className={clsx(styles.plusButton, plusOpen && styles.plusOpen)}
                aria-label={t('chatInputMoreActions')}
                aria-expanded={plusOpen}
                disabled={importingHistory}
                onClick={() => setPlusOpen((value) => !value)}
              >
                <span className={styles.plusIcon}>
                  <IconPlusOutline18 />
                </span>
              </button>
            </Tooltip>
          ) : (
            <IconButton
              size="m"
              tone="primary"
              icon={<IconPaperclipOutline16 />}
              tooltip={t('uploadFile')}
              disabled={importingHistory}
              onClick={() => canPickFiles() && fileInputRef.current?.click()}
            />
          )}
          {androidApp ? (
            <>
              <input
                ref={cameraInputRef}
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(event) => {
                  acceptFiles(Array.from(event.target.files ?? []))
                  event.target.value = ''
                  setPlusOpen(false)
                }}
              />
              <input
                ref={galleryInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => {
                  acceptFiles(Array.from(event.target.files ?? []))
                  event.target.value = ''
                  setPlusOpen(false)
                }}
              />
            </>
          ) : null}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            accept={acceptFilesAttr()}
            onChange={(event) => {
              acceptFiles(Array.from(event.target.files ?? []))
              event.target.value = ''
              setPlusOpen(false)
            }}
          />
          {streaming && sessionId ? (
            <button
              type="button"
              className={styles.sendButton}
              aria-label={t('chatInputStopButtonTooltip')}
              onClick={() => {
                stopReadAloud()
                stopReply(sessionId)
              }}
            >
              <IconStopFill16 />
            </button>
          ) : (
            <button
              type="button"
              className={clsx(styles.sendButton, !canSend && styles.disabled)}
              aria-label={t('send')}
              aria-disabled={!canSend}
              onClick={send}
            >
              <IconSendOutline16 />
            </button>
          )}
        </div>
      </div>
      {androidApp ? (
        <div
          className={clsx(styles.moreTray, plusOpen && styles.moreTrayOpen)}
          aria-hidden={!plusOpen}
        >
          <div className={styles.moreTrayInner}>
            <div className={styles.moreGrid}>
              <button
                type="button"
                className={styles.moreCard}
                tabIndex={plusOpen ? 0 : -1}
                disabled={importingHistory}
                onClick={() => canPickFiles() && cameraInputRef.current?.click()}
              >
                <IconCameraOutline22 />
                <span>{t('chatInputTakePhoto')}</span>
              </button>
              <button
                type="button"
                className={styles.moreCard}
                tabIndex={plusOpen ? 0 : -1}
                disabled={importingHistory}
                onClick={() => canPickFiles() && galleryInputRef.current?.click()}
              >
                <IconGalleryOutline22 />
                <span>{t('chatInputPhotoLibrary')}</span>
              </button>
              <button
                type="button"
                className={styles.moreCard}
                tabIndex={plusOpen ? 0 : -1}
                disabled={importingHistory}
                onClick={() => canPickFiles() && fileInputRef.current?.click()}
              >
                <IconAttachmentOutline22 />
                <span>{t('chatInputPickFiles')}</span>
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {dragging ? <DragMask /> : null}
    </div>
  )
}
