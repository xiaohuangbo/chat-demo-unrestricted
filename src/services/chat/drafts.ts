import { create } from 'zustand'
import type { TranslationMessage } from '../../i18n/index.js'
import { createId } from '../../utils/id.js'
import {
  cancelUpload,
  getMaxCount,
  isImage,
  resolveMimeType,
  restartUpload,
  uploadAttachment,
  validateFiles,
  type UploadTask,
} from '../attachments.js'
import {
  INLINE_CONTEXT_TOKEN_LIMIT,
  LARGE_TEXT_TOKEN_LIMIT,
  isTextAttachmentName,
  readAttachmentText,
  splitTextAttachment,
  textTokenWeight,
} from '../attachmentLargeText.js'
import { createPoisonSidecar, type AttachmentPoisonConfig } from '../attachmentPoison.js'
import { showToast } from '../../components/base/toastState.js'
import { useSettings } from '../settings.js'
import { isLocalModel } from '../local/catalog.js'
import type { FileAttachment } from './types.js'

export type DraftAttachment = {
  /** 本地标识，也是 IndexedDB 原件与上传任务的 key */
  id: string
  file: File
  isImage: boolean
  /** 伴随投毒文本本身不再投毒 */
  skipPoison?: boolean
  /** 由附件投毒自动生成的伴随附件 */
  generated?: boolean
  /** 实验性 1M 上下文：不上传，发送时正文直接拼进本轮提问 */
  inline?: boolean
}

type Draft = { text: string; attachments: DraftAttachment[] }

export const EMPTY_DRAFT: Draft = { text: '', attachments: [] }

/** 草稿只保存在本次页面的内存中，独立于会话详情缓存；null 是新对话的草稿。 */
export const useDrafts = create<{ drafts: Map<string | null, Draft> }>(() => ({
  drafts: new Map(),
}))

export const getDraft = (sessionId: string | null): Draft =>
  useDrafts.getState().drafts.get(sessionId) ?? EMPTY_DRAFT

const updateDraft = (sessionId: string | null, update: (draft: Draft) => Draft) =>
  useDrafts.setState((state) => {
    const draft = update(state.drafts.get(sessionId) ?? EMPTY_DRAFT)
    const drafts = new Map(state.drafts)
    if (draft.text || draft.attachments.length > 0) {
      drafts.set(sessionId, draft)
    } else {
      drafts.delete(sessionId)
    }
    return { drafts }
  })

export const setDraftText = (sessionId: string | null, text: string) =>
  updateDraft(sessionId, (draft) => ({ ...draft, text }))

const upload = (attachment: DraftAttachment, apiKey: string) => {
  // 上传任务负责记录错误，输入框的附件卡片展示失败及重试入口。
  void uploadAttachment(
    apiKey,
    attachment.id,
    attachment.file,
    attachment.file.name,
    attachment.isImage,
    { skipPoison: attachment.skipPoison }
  ).catch(() => {})
}

/** 把用户选中的文件展开成草稿附件：大文本按设置拆分成多个分片，或标记为直接放入上下文 */
const expandDraftAttachment = async (file: File): Promise<DraftAttachment[]> => {
  const plain: DraftAttachment[] = [
    { id: createId(), file, isImage: isImage(resolveMimeType(file)) },
  ]
  const { attachmentLargeText, attachmentLargeTextInline } = useSettings.getState()
  if (!attachmentLargeText || plain[0].isImage || !isTextAttachmentName(file.name)) {
    return plain
  }
  const text = await readAttachmentText(file).catch(() => '')
  if (text === '') {
    return plain
  }
  const tokens = textTokenWeight(text)
  if (tokens <= LARGE_TEXT_TOKEN_LIMIT) {
    return plain
  }
  // 实验性：不拆分也不上传，正文在发送时拼进本轮提问，占用 1M 上下文
  if (attachmentLargeTextInline) {
    if (tokens > INLINE_CONTEXT_TOKEN_LIMIT) {
      showToast({
        key: 'attachmentsLargeTextTooLarge',
        params: { tokens: Math.round(tokens).toLocaleString() },
      })
      return []
    }
    return [{ id: createId(), file, isImage: false, inline: true }]
  }
  const parts = splitTextAttachment(file.name, text)
  if (parts.length <= 1) {
    return plain
  }
  return parts.map((part) => ({ id: createId(), file: part, isImage: false }))
}

/** 整批校验通过后才创建预览和开始上传。 */
export const addDraftFiles = async (
  sessionId: string | null,
  files: File[],
  apiKey: string
): Promise<TranslationMessage | null> => {
  if (files.length === 0) {
    return null
  }
  const error = validateFiles(files, getDraft(sessionId).attachments.length)
  if (error) {
    return error
  }
  const expanded: DraftAttachment[] = []
  for (const file of files) {
    expanded.push(...(await expandDraftAttachment(file)))
  }
  if (expanded.length === 0) {
    return null
  }
  // 拆分后的分片与伴随文本附件都占名额；超出时截断并提示，避免整批被拒
  const current = getDraft(sessionId).attachments.length
  const available = Math.max(0, getMaxCount() - current)
  const limited = useSettings.getState().attachmentLimits && expanded.length > available
  const added = limited ? expanded.slice(0, available) : expanded
  if (limited) {
    showToast({ key: 'attachmentsLargeTextPartsLimited', params: { count: added.length } })
  }
  if (added.length === 0) {
    return null
  }
  // 伴随文本附件是普通附件，占一个名额；名额不足时只为前面的文件生成
  const poison = useSettings.getState().attachmentPoison
  const sidecars: DraftAttachment[] = []
  if (poison.enabled && poison.methods.includes('sidecar') && poison.content.trim() !== '') {
    const remaining = Math.max(0, getMaxCount() - current - added.length)
    for (const attachment of added.filter((item) => !item.inline).slice(0, remaining)) {
      const file = createPoisonSidecar(attachment.file.name, poison.content)
      sidecars.push({
        id: createId(),
        file,
        isImage: false,
        skipPoison: true,
        generated: true,
      })
    }
  }
  const next = [...added, ...sidecars]
  updateDraft(sessionId, (draft) => ({ ...draft, attachments: [...draft.attachments, ...next] }))
  // 本地模型不走 Files API：附件原件留在 IndexedDB，发送时由页面读成纯文本；
  // 直接放入上下文的附件同样不上传
  if (!isLocalModel(useSettings.getState().model)) {
    next
      .filter((attachment) => !attachment.inline)
      .forEach((attachment) => upload(attachment, apiKey))
  }
  return null
}

export const retryDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment && !attachment.inline) {
    upload(attachment, apiKey)
  }
}

/** 附件投毒开关变化时强制按当前设置重新上传（中止旧任务，避免旧配置的结果覆盖新任务） */
export const restartDraftAttachment = (
  sessionId: string | null,
  attachmentId: string,
  apiKey: string
) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (attachment && !attachment.inline) {
    restartUpload(
      apiKey,
      attachment.id,
      attachment.file,
      attachment.file.name,
      attachment.isImage,
      { skipPoison: attachment.skipPoison }
    )
  }
}

/** 发送按钮和实际提交共用规则：有内容，且全部附件已上传成功。 */
export const prepareDraftMessage = (
  draft: Draft,
  tasks: Record<string, UploadTask>,
  localOnly = false
) => {
  const text = draft.text.trim()
  if (!text && draft.attachments.length === 0) {
    return null
  }
  const files: (FileAttachment & { serverId: string; blob: Blob })[] = []
  for (const attachment of draft.attachments) {
    const task = tasks[attachment.id]
    // 直接放入 1M 上下文的附件不走 Files API，没有上传任务
    const inline = attachment.inline === true
    if (!localOnly && !inline && (task?.status !== 'done' || !task.serverId)) {
      return null
    }
    files.push({
      id: attachment.id,
      serverId: task?.status === 'done' ? task.serverId : '',
      name: attachment.file.name,
      size: attachment.file.size,
      isImage: attachment.isImage,
      mimeType: resolveMimeType(attachment.file),
      poison: task?.status === 'done' ? task.poison : '',
      ...(localOnly ? { imageSizeChecked: true } : {}),
      ...(attachment.generated ? { generated: true } : {}),
      ...(inline ? { inline: true } : {}),
      blob: attachment.file,
    })
  }
  return { text, files }
}

export const removeDraftAttachment = (sessionId: string | null, attachmentId: string) => {
  const attachment = getDraft(sessionId).attachments.find((item) => item.id === attachmentId)
  if (!attachment) {
    return
  }
  cancelUpload(attachment.id)
  updateDraft(sessionId, (draft) => ({
    ...draft,
    attachments: draft.attachments.filter((item) => item.id !== attachmentId),
  }))
}

/**
 * 附件投毒设置变化时同步草稿：移除旧的伴随文本附件，按新配置重新生成；
 * 原附件由调用方重新上传，确保采用新配置。
 */
export const syncDraftSidecars = (sessionId: string | null, apiKey: string) => {
  const draft = getDraft(sessionId)
  const generated = draft.attachments.filter((attachment) => attachment.generated)
  const originals = draft.attachments.filter((attachment) => !attachment.generated)
  generated.forEach((attachment) => cancelUpload(attachment.id))

  const poison: AttachmentPoisonConfig = useSettings.getState().attachmentPoison
  const sidecars: DraftAttachment[] = []
  if (poison.enabled && poison.methods.includes('sidecar') && poison.content.trim() !== '') {
    const eligible = originals.filter((attachment) => !attachment.inline)
    const available = Math.max(0, getMaxCount() - originals.length)
    for (const original of eligible.slice(0, available)) {
      const file = createPoisonSidecar(original.file.name, poison.content)
      sidecars.push({
        id: createId(),
        file,
        isImage: false,
        skipPoison: true,
        generated: true,
      })
    }
  }
  updateDraft(sessionId, (current) => ({
    ...current,
    attachments: [...originals, ...sidecars],
  }))
  sidecars.forEach((attachment) => upload(attachment, apiKey))
}

/** 发送成功后原件与 serverId 已交给会话，保留上传完成态。 */
export const clearSentDraft = (sessionId: string | null) => {
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

/** 删除会话或替换历史成功后，释放尚未发送的草稿及上传任务。 */
export const clearDraft = (sessionId: string | null) => {
  getDraft(sessionId).attachments.forEach((attachment) => cancelUpload(attachment.id))
  updateDraft(sessionId, () => EMPTY_DRAFT)
}

export const clearAllDrafts = () => {
  for (const draft of useDrafts.getState().drafts.values()) {
    draft.attachments.forEach((attachment) => cancelUpload(attachment.id))
  }
  useDrafts.setState({ drafts: new Map() })
}
