import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { translate } from '../../i18n/index.js'
import { ApiError, streamMessage } from '../api/client.js'
import { supportsServerTitle, supportsServerTools } from '../api/models.js'
import { isLocalModel } from '../local/catalog.js'
import { activeRole, getRole, roleSystemPrompt } from '../companion.js'
import { useProfile } from '../profile.js'
import { streamLocalMessage } from '../local/stream.js'
import { buildLocalAugment } from '../local/augment.js'
import type { ChatModel, CreateMessageRequest, MessageParam } from '../api/types.js'
import type { SessionCompression } from './types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import {
  cancelUpload,
  checkImageFileIds,
  describeUploadError,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import {
  matchesRefusalKeyword,
  reasoningEffortValue,
  thinkingBudget,
  useSettings,
} from '../settings.js'
import { attachmentPoisonSignature } from '../attachmentPoison.js'
import {
  attachPoisonResults,
  formatSearchPoisonContext,
  parsePoisonNow,
  poisonStreamEvent,
  sanitizePoisonedReply,
  shouldTakeoverSearch,
} from '../searchPoison.js'
import { composeSystemPrompt } from './systemPrompt.js'
import { customCotSnapshot, formatCustomCotContext } from './customCot.js'
import { noteContextUsage } from './contextUsage.js'
import { buildContextBreakdown, noteContextBreakdown } from './contextBreakdown.js'
import { noteAutoTune, useFeedback } from './feedbackStore.js'
import { beginLiveRun, finishLiveRun, noteDelta, noteUsage } from './liveStats.js'
import { estimatePages, noteRunTiming } from './sessionStats.js'
import { enabledAgentTools } from '../agent/agentToolSettings.js'
import { createToolCall, runAgentToolCall, toolResultForModel } from '../agent/runTool.js'
import { modePolicy, modeSystemNote } from './mode.js'
import type { ChatToolCall } from '../agent/types.js'
import { autoCompressNeeded, compressSession } from './compression.js'
import { extractMemoriesFromTurn, formatSavedMemories } from './savedMemory.js'
import { formatMemoryBankContext } from './memoryBank.js'
import { noteDailyUsage } from './dailyUsage.js'
import { noteLedgerUsage } from './usageLedger.js'
import { contextWindowFor, useContextUsage } from './contextUsage.js'
import { showToast } from '../../components/base/toastState.js'
import { readAttachmentText } from '../attachmentLargeText.js'
import { computeAutoTuneParams } from '../unrestricted/autotune.js'
import { applyParseltongue } from '../unrestricted/parseltongue.js'
import { depthDirective, jailbreakSystemPrompt } from '../unrestricted/prompts.js'
import { looksLikeRefusal } from '../unrestricted/refusal.js'
import { applyHallOfFameCombo, HALL_OF_FAME } from '../unrestricted/libertas.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  getContextRounds,
  getReplyAnswerText,
  getReplyThinking,
  rewriteReplyBlocks,
  settleReply,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'

/** deepseek-flash 同时支持深度思考与图片输入 */
const MODEL: ChatModel = 'deepseek-flash'

/** 文档解析计费按页算，客户端拿不到页数，这里与会话统计用同一套体积估算 */
const PARSE_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])
const parsedPages = (files: { name: string; size: number }[]): number =>
  files.reduce((sum, file) => {
    const dot = file.name.lastIndexOf('.')
    const ext = dot > 0 ? file.name.slice(dot + 1).toLowerCase() : ''
    return PARSE_EXTS.has(ext) ? sum + estimatePages(file.size) : sum
  }, 0)

/**
 * 自动越狱的临时状态：
 * - 被拒绝后，用下一套 L1B3RT4S 组合的系统提示词覆盖一次请求；
 * - 计数按提问 id 累计，避免同一问题无限重试。
 */
let autoRetryOverride: string | null = null
const autoRetryCounts = new Map<string, number>()
const AUTO_RETRY_LIMIT = 2
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/**
 * 安全审核字段：默认开启基础风控；勾选「跳过安全审核」或进入越狱模式时不携带该字段，
 * 与传 low 等价，不再额外审核模型输入与输出。
 */
const safetyCheck = (
  unrestricted: boolean,
  skipSafetyCheck: boolean
): CreateMessageRequest['safety_check'] =>
  unrestricted || skipSafetyCheck ? undefined : { level: 'high' }
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 阅读链接始终开启，智能搜索开关控制是否另行声明搜索工具（含边想边搜）。 */
const serverTools = (search: boolean): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = [
    { type: 'deepseek_read_url', name: 'deepseek_read_url' },
  ]
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/**
 * 本轮下发的工具列表：服务端工具 + 已开启的浏览器工具。
 * 浏览器工具由设置里的主开关与逐项开关过滤，关闭时模型完全看不到它。
 */
const requestTools = (
  search: boolean,
  allowAgentTools: boolean,
  model: string
): CreateMessageRequest['tools'] => {
  // V4 Pro 不支持服务端联网工具；带任一服务端工具会被 API 直接拒绝
  const tools = supportsServerTools(model) ? serverTools(search) : []
  if (!allowAgentTools) {
    return tools
  }
  for (const tool of enabledAgentTools()) {
    tools.push({
      name: tool.id,
      description: tool.description,
      input_schema: tool.inputSchema,
    })
  }
  return tools
}

/** 一轮里客户端工具往返的默认上限；PTC / 创造模式由 mode.ts 放宽 */
const MAX_TOOL_ROUNDS = 4

/**
 * 回复结束：防撤回开启时保留服务端已下发的内容，
 * 关闭时按协议丢弃拒绝回复的正文与思考，只保留工具块。
 */
const settle = (
  reply: AssistantMessage,
  status: 'done' | 'stopped' | 'error',
  now: number,
  error?: AssistantMessage['error']
) => settleReply(reply, status, now, error, useSettings.getState().keepReplyContent)

/** 允许自动补标题的请求；手动重命名后取消本轮标题写入，包含主动清空标题的情况。 */
const titleRequests = new Set<AbortController>()

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title && a.createdAt === b.createdAt && a.updatedAt === b.updatedAt

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions: sameSummary(previous, session)
        ? state.sessions
        : sortSessions(
            state.sessions.map((summary) =>
              summary.id === id ? toSessionSummary(session) : summary
            )
          ),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model, customCotEnabled, customCot } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking,
    // 快照本轮注入的思维链，之后续写 / 展示都以它为准，不受设置改动影响
    customCot: customCotSnapshot(customCotEnabled, customCot),
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 命中本地关键词拒答时直接生成一条已完成的拒答回复，不发起 API 请求。 */
const createRefusedReply = (): AssistantMessage => {
  const { refusalMessage, model } = useSettings.getState()
  const text = refusalMessage.trim() || translate('replyRefused')
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking: false,
    search: false,
    prefix: false,
    status: 'done',
    stopReason: 'refusal',
    blocks: [{ type: 'text', text, isTemplate: true }],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settle(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const session = sameSummary(settled, summary) ? settled : { ...settled, ...summary }
      touchSession(id)
      set((state) => ({ sessionCache: { ...state.sessionCache, [id]: session } }))
      if (session !== stored) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

/**
 * 新建会话。`systemPrompt` 只作用于接下来创建的这个会话，
 * 不写入全局设置，避免实验台导入的组合覆盖用户选择的提示词预设。
 */
let pendingSystemPrompt: string | null = null

export const newChat = (options?: { systemPrompt?: string | null }) => {
  if (!get().importingHistory) {
    pendingSystemPrompt = options?.systemPrompt?.trim() ? options.systemPrompt.trim() : null
    set({ activeId: null })
    trimSessionCache()
  }
}

/** 修改某个会话的系统提示词；传 null 恢复按全局设置组装 */
export const setSessionSystemPrompt = (sessionId: string, systemPrompt: string | null) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => {
    const next = { ...session }
    if (systemPrompt !== null && systemPrompt.trim() !== '') {
      next.systemPrompt = systemPrompt.trim()
    } else {
      delete next.systemPrompt
    }
    return next
  })
  persist(sessionId)
}

/** 写入或清除会话压缩摘要 */
export const setSessionCompression = (
  sessionId: string,
  compression: SessionCompression | null
) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => {
    const next = { ...session }
    if (compression) {
      next.compression = compression
    } else {
      delete next.compression
    }
    return next
  })
  persist(sessionId)
}

/**
 * 把当前会话的可见分支复制到一个全新会话：消息 id 全部重建，原会话保持不变。
 * 用于从长对话里另开一条线的场景；系统提示词与压缩摘要一并继承。
 * 生成中、导入中或会话未加载时返回 null。
 */
export const forkSession = (sessionId: string): string | null => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return null
  }
  const source = getSession(sessionId)
  if (!source) {
    return null
  }
  const visible = getVisibleMessages(source)
  if (visible.length === 0) {
    return null
  }
  const now = Date.now()
  const idMap = new Map<string, string>()
  const messages = visible.map((message) => {
    const id = createId()
    idMap.set(message.id, id)
    const copy = { ...message, id }
    // 对齐 DSH 的 fork 归属：继承来的用量不计入新会话统计，避免父子重复计费
    if (copy.role === 'assistant') {
      delete copy.usage
    }
    return copy as Message
  })
  const remapped = messages.map((message, index) => ({
    ...message,
    parentId: index === 0 ? null : messages[index - 1].id,
    selectedChildId: messages[index + 1]?.id,
  })) as Message[]
  // 压缩摘要只有在截止消息也复制过来时才继承，避免新会话引用不到旧 id
  const mappedCutoff = source.compression ? idMap.get(source.compression.upToMessageId) : undefined
  const session: Session = {
    id: createId(),
    title: `${source.title || translate('untitledChat')}${translate('forkTitleSuffix')}`,
    createdAt: now,
    updatedAt: now,
    messages: remapped,
    rootMessageId: remapped[0]?.id ?? null,
    ...(source.roleId ? { roleId: source.roleId } : {}),
    ...(source.systemPrompt ? { systemPrompt: source.systemPrompt } : {}),
    ...(source.compression && mappedCutoff
      ? { compression: { ...source.compression, upToMessageId: mappedCutoff } }
      : {}),
  }
  touchSession(session.id)
  set((state) => ({
    sessions: [toSessionSummary(session), ...state.sessions],
    sessionCache: { ...state.sessionCache, [session.id]: session },
    activeId: session.id,
  }))
  persist(session.id)
  trimSessionCache()
  return session.id
}

export type SeededChat = {
  title: string
  /** 会话级系统提示词；不写入全局设置 */
  systemPrompt?: string
  userText: string
  assistantText: string
  model?: ChatModel | null
}

/**
 * 用一条现成的问答新建会话（例如把变体赛跑的胜出结果带进聊天继续）。
 * 系统提示词挂在会话上，不会覆盖设置里的提示词预设；用户消息保留实际发送的改写文本。
 */
export const createSeededChat = (seed: SeededChat): string | null => {
  if (get().importingHistory) {
    return null
  }
  const now = Date.now()
  const userId = createId()
  const replyId = createId()
  const user: UserMessage = {
    id: userId,
    role: 'user',
    content: seed.userText,
    files: [],
    createdAt: now,
    parentId: null,
    selectedChildId: replyId,
  }
  const reply: AssistantMessage = {
    id: replyId,
    role: 'assistant',
    createdAt: now + 1,
    model: seed.model ?? MODEL,
    thinking: false,
    search: false,
    prefix: true,
    status: 'done',
    blocks: [{ type: 'text', text: seed.assistantText }],
  }
  const session: Session = {
    id: createId(),
    title: seed.title,
    createdAt: now,
    updatedAt: now + 1,
    messages: [user, reply],
    rootMessageId: userId,
    ...(seed.systemPrompt ? { systemPrompt: seed.systemPrompt } : {}),
  }
  touchSession(session.id)
  set((state) => ({
    sessions: [toSessionSummary(session), ...state.sessions],
    sessionCache: { ...state.sessionCache, [session.id]: session },
    activeId: session.id,
  }))
  persist(session.id)
  trimSessionCache()
  return session.id
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    pendingSystemPrompt = null
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

/** 切换会话角色；角色提示词在下一轮请求时生效 */
export const setSessionRole = (id: string, roleId: string) => {
  updateSession(id, (session) => ({ ...session, roleId }))
  set((state) => ({
    sessions: state.sessions.map((summary) =>
      summary.id === id ? { ...summary, roleId } : summary
    ),
  }))
  persist(id)
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const controller = getStreamController(id)
  if (controller) {
    titleRequests.delete(controller)
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const localOnly = isLocalModel(useSettings.getState().model)
  const prepared = prepareDraftMessage(
    getDraft(targetSessionId),
    useUploads.getState().tasks,
    localOnly
  )
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  // 输入扰动：在写入会话前改写，界面上看到的就是实际下发的文本，重发与续写也保持一致。
  // 新消息不继承上一次自动重试遗留的系统提示词
  autoRetryOverride = null
  const { parseltongue, parseltongueTechnique, parseltongueIntensity, autoJailbreak } =
    useSettings.getState()
  // 自动越狱时即使用户没开扰动也强制改写：默认用全角（中文会自动退化为细空格）
  const perturb = parseltongue || autoJailbreak
  const technique = parseltongue ? parseltongueTechnique : 'fullwidth'
  const content =
    perturb && text !== ''
      ? applyParseltongue(text, {
          enabled: true,
          technique,
          intensity: parseltongueIntensity,
          customTriggers: [],
        }).transformedText
      : text
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      roleId: activeRole().id,
      ...(pendingSystemPrompt ? { systemPrompt: pendingSystemPrompt } : {}),
    }
    pendingSystemPrompt = null
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [toSessionSummary(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content,
    files: files.map(({ id, serverId, name, size, isImage, mimeType, poison, generated }) => ({
      id,
      serverId: serverId === '' ? null : serverId,
      // 草稿附件已上传成功，每张图片都在上传前检查过长边，超限的已缩小。
      ...(isImage ? { imageSizeChecked: true } : {}),
      name,
      size,
      isImage,
      mimeType,
      ...(poison !== undefined ? { poison } : {}),
      ...(generated ? { generated: true } : {}),
    })),
    createdAt: now,
  }
  // 关键词拒答同时检查原始输入与扰动后的 content，避免开扰动后绕过关键词
  const localRefused =
    matchesRefusalKeyword(content) || (text !== content && matchesRefusalKeyword(text))
  const reply = localRefused ? createRefusedReply() : createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  if (!localRefused) {
    void streamReply(sessionId, reply, { history, question })
  }
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (sessionId: string, messageId: string, content: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

/**
 * 改写一条已结束回复的正文或思维链：直接写回内容块，不新建分支，
 * 之后每一轮请求都从这里取内容；首次改写时保存原始块快照，供「还原原文」使用。
 */
export const editReplyContent = (
  sessionId: string,
  messageId: string,
  next: { thinking: string; text: string }
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  const message = session?.messages.find((item) => item.id === messageId)
  if (!session || !message || message.role !== 'assistant') {
    return false
  }
  // 内容没有变化就当作保存成功，不写入快照，避免凭空产生「已编辑」状态。
  if (next.thinking === getReplyThinking(message) && next.text === getReplyAnswerText(message)) {
    return true
  }
  const at = Date.now()
  const blocks = rewriteReplyBlocks(message.blocks, next)
  updateSession(sessionId, (state) => ({
    ...state,
    updatedAt: at,
    messages: state.messages.map((item) =>
      item.id === messageId && item.role === 'assistant'
        ? { ...item, blocks, edited: item.edited ?? { at, blocks: item.blocks } }
        : item
    ),
  }))
  persist(sessionId)
  return true
}

/** 还原为模型原始回复：恢复到首次改写前保存的块快照 */
export const revertReplyContent = (sessionId: string, messageId: string): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId) || getStreamController(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  const message = session?.messages.find((item) => item.id === messageId)
  if (!session || !message || message.role !== 'assistant') {
    return false
  }
  const original = message.edited
  if (!original) {
    return false
  }
  updateSession(sessionId, (state) => ({
    ...state,
    updatedAt: Date.now(),
    messages: state.messages.map((item) =>
      item.id === messageId && item.role === 'assistant'
        ? { ...item, blocks: original.blocks, edited: undefined }
        : item
    ),
  }))
  persist(sessionId)
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  const { continueRefused, unrestricted } = useSettings.getState()
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    // 拒绝后继续生成：设置开关或越狱模式下允许续写被拒绝的回复。
    !canContinueReply(previous, continueRefused || unrestricted)
  ) {
    return
  }
  const { thinking, search, customCotEnabled, customCot } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用默认模型和当前开关。
    model: previous.model ?? MODEL,
    thinking: previous.thinking ?? thinking,
    // 续写沿用原回复注入过的思维链；旧回复没有快照时才用当前设置。
    customCot: previous.customCot ?? customCotSnapshot(customCotEnabled, customCot),
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
    // 续写会改变块结构，原始快照不再对得上，「还原原文」入口随之失效。
    edited: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const { customCotEnabled, customCot } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    status: 'pending',
    error: undefined,
    customCot: previous.customCot ?? customCotSnapshot(customCotEnabled, customCot),
  }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

type UploadedFile = { serverId: string; poison: string }

/** 把补传得到的 serverId 与投毒指纹写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, uploads: Map<string, UploadedFile>) => {
  if (uploads.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => uploads.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const uploaded = uploads.get(file.id)
              return uploaded
                ? { ...file, serverId: uploaded.serverId, poison: uploaded.poison }
                : file
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/** 写回旧图片尺寸检查结果：null 清除超限图片的 serverId，交给补传流程 */
const applyCheckedImageIds = (sessionId: string, checked: ReadonlyMap<string, string | null>) => {
  if (checked.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => checked.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) => {
              const serverId = checked.get(file.id)
              return serverId === undefined
                ? file
                : { ...file, serverId, imageSizeChecked: serverId !== null }
            }),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 直接放入 1M 上下文的附件正文：按附件 id 缓存，历史轮次不必每轮重读大文件；
 * 只保留最近几份，避免长会话把整库文本留在内存里。
 */
const inlineTextCache = new Map<string, string>()
const INLINE_TEXT_CACHE_LIMIT = 4

const inlineTextOf = async (file: FileAttachment): Promise<string | undefined> => {
  if (!file.inline) {
    return undefined
  }
  const cached = inlineTextCache.get(file.id)
  if (cached !== undefined) {
    return cached
  }
  const blob = await db.loadFile(file.id).catch(() => undefined)
  if (!blob) {
    return undefined
  }
  const text = await readAttachmentText(blob).catch(() => undefined)
  if (text === undefined) {
    return undefined
  }
  if (inlineTextCache.size >= INLINE_TEXT_CACHE_LIMIT) {
    const oldest = inlineTextCache.keys().next().value
    if (oldest !== undefined) {
      inlineTextCache.delete(oldest)
    }
  }
  inlineTextCache.set(file.id, text)
  return text
}

/** 给请求副本里的用户消息补上 inlineText；没有直接放入上下文的附件时原样返回 */
const enrichInlineText = async <T extends UserMessage>(message: T): Promise<T> => {
  if (!message.files.some((file) => file.inline)) {
    return message
  }
  const files = await Promise.all(
    message.files.map(async (file) => {
      const text = await inlineTextOf(file)
      return text === undefined || file.inlineText === text ? file : { ...file, inlineText: text }
    })
  )
  return files.some((file, index) => file !== message.files[index])
    ? { ...message, files }
    : message
}

/**
 * 附件的服务端 id：已有且投毒指纹匹配时直接用；正在上传的等待同一任务；
 * 否则读取本地原件按当前投毒配置补传。本地没有原件时保留旧 serverId（只展示旧文件）。
 * 直接放入 1M 上下文的附件不走 Files API，正文由请求组装时读入。
 */
const ensureServerId = async (
  apiKey: string,
  file: FileAttachment
): Promise<UploadedFile | null> => {
  if (file.inline) {
    return null
  }
  const signature = attachmentPoisonSignature(useSettings.getState().attachmentPoison)
  if (file.serverId && (file.poison === signature || file.poison === 'skip')) {
    return { serverId: file.serverId, poison: file.poison }
  }
  // 旧版本/导入附件没有指纹：关闭投毒时直接复用；开启时尝试用本地原件重新上传
  if (file.serverId && file.poison === undefined && signature === 'off') {
    return { serverId: file.serverId, poison: 'off' }
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done' && (task.poison === signature || task.poison === 'skip')) {
    return { serverId: task.serverId, poison: task.poison }
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return file.serverId ? { serverId: file.serverId, poison: file.poison ?? 'off' } : null
  }
  const serverId = await uploadAttachment(apiKey, file.id, blob, file.name, file.isImage, {
    skipPoison: file.poison === 'skip',
  })
  const uploaded = useUploads.getState().tasks[file.id]
  return {
    serverId,
    poison: uploaded?.status === 'done' ? uploaded.poison : signature,
  }
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, UploadedFile>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  // 旧图片超限时先清除 ID，交给下方已有的附件补传流程。
  const imageFiles = [
    ...request.question.files,
    ...getContextRounds(request.history).flatMap(([user]) => user.files),
  ]
  const checked = await Promise.race([checkImageFileIds(imageFiles, signal), aborted])
  if (checked.size > 0) {
    applyCheckedImageIds(sessionId, checked)
    request = refreshRequest(sessionId, request)
  }
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const uploaded = await ensureServerId(apiKey, file)
      if (uploaded) {
        serverIds.set(file.id, uploaded)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  for (const [user] of getContextRounds(request.history).toReversed()) {
    for (const file of user.files) {
      if (!file.inline && !file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const uploaded = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (uploaded) {
        serverIds.set(file.id, uploaded)
        saveServerIds(sessionId, new Map([[file.id, uploaded]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  // 直接放入上下文的附件在请求副本里补上正文快照；会话里不保存，避免存储翻倍
  const history = await Promise.all(
    request.history.map(async (message) =>
      message.role === 'user' ? enrichInlineText(resolve(message as UserMessage)) : resolve(message)
    )
  )
  const question = await enrichInlineText(resolve(request.question))
  return { history, question, prefix: request.prefix }
}

/** 本次请求实际会用到的服务端 file_id */
const collectServerFileIds = (request: Request): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(refreshRequest(sessionId, request))
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
const waitForRetry = (attempt: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/** 取出并清空一次性的自动重试系统提示词 */
const takeAutoRetryOverride = (): string | null => {
  const override = autoRetryOverride
  autoRetryOverride = null
  return override
}

/**
 * 自动越狱：被安全拒绝且没有保留正文时，换下一套 L1B3RT4S 组合重新生成，
 * 每个提问最多重试 AUTO_RETRY_LIMIT 次；用户停止或关闭开关时不重试。
 */
const maybeAutoRetry = (
  sessionId: string,
  reply: AssistantMessage,
  questionId: string,
  question: string,
  aborted: boolean
) => {
  if (aborted || !useSettings.getState().autoJailbreak) {
    return
  }
  const answer = getReplyAnswerText(reply)
  // 协议层拒绝（且没保留正文）或正文本身是拒绝话术时都算被拒绝
  const refused =
    reply.stopReason === 'refusal' && answer.trim() === '' ? true : looksLikeRefusal(answer, 600)
  if (!refused) {
    return
  }
  const count = autoRetryCounts.get(questionId) ?? 0
  if (count >= AUTO_RETRY_LIMIT) {
    showToast({ key: 'autoJailbreakGiveUp' })
    return
  }
  autoRetryCounts.set(questionId, count + 1)
  const combo = HALL_OF_FAME[count % HALL_OF_FAME.length]
  const { system } = applyHallOfFameCombo(combo, question)
  // L1B3RT4S 组合是英文提示词，深度指令保持英文，避免中英混杂
  autoRetryOverride = `${system}${depthDirective(false)}`
  showToast({ key: 'autoJailbreakRetrying' })
  // 等当前流的收尾（移除 streaming 标记）完成后再发起新版本
  setTimeout(() => regenerateReply(sessionId, reply.id), 0)
}

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  /** 本地模型（WebLLM / MLC-LLM API）没有附件上传、服务端工具与标题生成，走简化分支 */
  const localModel = isLocalModel(initial.model ?? MODEL)
  // 本地模型 / V4 Pro 不向服务端要标题，也不该被当成「标题请求」跳过用量记账
  const serverTitle = !localModel && supportsServerTitle(initial.model ?? MODEL)
  if (serverTitle && !getSession(sessionId)?.title) {
    titleRequests.add(controller)
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  // 本轮是否逐字渲染；关闭时只累积到结束，避免中间态暴露
  const streamOutput = useSettings.getState().streamOutput
  // 搜索投毒在请求开始时取快照，生成过程中修改设置不会让同一轮上下文前后不一致
  const poisonConfig = useSettings.getState().searchPoison
  let frame = 0
  // 首 token 时间与整轮耗时用于会话统计；服务端拒绝思考强度时退回普通思考请求
  const runStartedAt = Date.now()
  let firstTokenAt: number | null = null
  let fallbackNoReasoning = false
  beginLiveRun(sessionId, initial.model ?? MODEL)
  const flush = (force = false) => {
    cancelAnimationFrame(frame)
    frame = 0
    // 非流式模式不展示中间态；页面隐藏/关闭时仍强制写回，避免丢内容
    if (streamOutput || force) {
      updateReply(sessionId, reply)
    }
  }
  streamFlushes.set(sessionId, () => flush(true))

  /** 客户端工具往返：每轮把 tool_use 收齐，执行后作为 tool_result 追加到下一轮请求 */
  const toolMessages: MessageParam[] = []
  let toolRounds = 0
  try {
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = localModel
          ? { history: request.history, question: request.question, prefix: request.prefix }
          : await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(
              useSettings.getState(),
              poisonConfig.enabled ? (parsePoisonNow(poisonConfig.now) ?? new Date()) : new Date()
            )
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        const {
          apiKey,
          maxTokens,
          skipSafetyCheck,
          systemPrompt,
          promptPreset,
          temperature,
          topP,
          unrestricted,
          autoTune,
          autoTuneStrategy,
          reasoningEffort,
          autoJailbreak,
          injectPromptEveryTurn,
          translateJailbreakZh,
          thinkingAsBody,
          savedMemoryEnabled,
          memoryBankEnabled,
          memoryBankLimit,
          memoryBankThreshold,
          memoryBankDimension,
          memoryBankKeywordWeight,
          memoryBankTagWeight,
          memoryBankVectorWeight,
          memoryBankEdgeWeight,
        } = useSettings.getState()
        // 组装流水线：自动重试的组合 > 会话级提示词（实验台组合）> 自动越狱的 GODMODE > 默认预设
        const baseSystemText =
          takeAutoRetryOverride() ??
          getSession(sessionId)?.systemPrompt ??
          (autoJailbreak
            ? `${jailbreakSystemPrompt(translateJailbreakZh)}${depthDirective(translateJailbreakZh)}`
            : composeSystemPrompt(unrestricted, systemPrompt, promptPreset, translateJailbreakZh))
        // 长期记忆与网状记忆库检索结果追加到 system；标题请求不需要
        const poisonContext = formatSearchPoisonContext(poisonConfig)
        const memoryContext = titleRequests.has(controller)
          ? ''
          : [
              savedMemoryEnabled ? formatSavedMemories() : '',
              memoryBankEnabled
                ? formatMemoryBankContext(prepared.question.content, {
                    dimension: memoryBankDimension,
                    limit: memoryBankLimit,
                    threshold: memoryBankThreshold,
                    keywordWeight: memoryBankKeywordWeight,
                    tagWeight: memoryBankTagWeight,
                    vectorWeight: memoryBankVectorWeight,
                    edgeWeight: memoryBankEdgeWeight,
                  })
                : '',
            ]
              .filter(Boolean)
              .join('\n\n')
        const mode = modePolicy()
        const role = getRole(getSession(sessionId)?.roleId)
        const profileName = useProfile.getState().name
        const roleText = roleSystemPrompt(role, '')
        const systemText = [
          baseSystemText,
          profileName && profileName !== '我' ? `用户称呼：${profileName}` : '',
          roleText,
          // 自定义思维链放在角色 / 破限规则之后、记忆与搜索上下文之前；
          // 首轮同时携带标题生成请求，也必须带上，否则新会话的第一条回复不会生效。
          // 使用回复创建时的快照，续写 / 重新生成不会因中途改设置而前后不一致。
          initial.customCot
            ? formatCustomCotContext(initial.customCot, initial.thinking ?? false)
            : '',
          memoryContext,
          poisonContext,
          // 当前模式的能力说明：让模型知道这轮能用什么，别在仅聊天模式里硬调工具
          modeSystemNote(mode.mode),
        ]
          .filter(Boolean)
          .join('\n\n')
        // 每轮注入：只加在本次请求的 latest_reminder 里，不写入历史快照，避免存储膨胀
        const requestReminder = injectPromptEveryTurn
          ? `${latestReminder}\n\n${baseSystemText}`
          : latestReminder
        // V4 Pro 不接受 latest_reminder 角色：把本轮提醒、压缩摘要折进 leading system
        const reminderRoleSupported = !localModel && supportsServerTools(initial.model ?? MODEL)
        const compression = getSession(sessionId)?.compression
        // system 本来每轮都会完整下发，因此这里只补日期/位置快照，不再重复 baseSystemText；
        // 压缩摘要原本也是 latest_reminder，一并折进 system。
        const foldedReminder = reminderRoleSupported
          ? ''
          : [
              latestReminder,
              compression
                ? `${translate('compressSummaryHeader', { rounds: compression.rounds })}\n${compression.summary}`
                : '',
            ]
              .filter(Boolean)
              .join('\n\n')
        const requestSystemText = foldedReminder ? `${systemText}\n\n${foldedReminder}` : systemText
        const messages = [
          ...toRequestMessages(
            prepared.history,
            prepared.question,
            prepared.prefix,
            initial.thinking ?? false,
            reminderRoleSupported ? requestReminder : undefined,
            reminderRoleSupported ? compression : undefined,
            thinkingAsBody,
            !reminderRoleSupported
          ),
          ...toolMessages,
        ]
        const effort = initial.thinking ? reasoningEffort : 0
        // 自动调参只覆盖 temperature 与 top_p：Anthropic 兼容接口不接受其余采样参数。
        const autoTuned =
          autoTune || autoJailbreak
            ? computeAutoTuneParams({
                strategy: autoTuneStrategy,
                message: prepared.question.content,
                conversationHistory: prepared.history.slice(-8).map((message) => ({
                  role: message.role,
                  content: message.role === 'user' ? message.content : getReplyAnswerText(message),
                })),
                learnedProfiles: useFeedback.getState().state.learnedProfiles,
              })
            : null
        if (autoTuned) {
          noteAutoTune(initial.id, autoTuned.detectedContext, autoTuned.params)
        }
        // 工具列表在发出前先定下来：上下文分类要用同一份定义，不能发给模型的和统计的不一致
        const tools = localModel
          ? []
          : requestTools(
              (initial.search ?? false) && !shouldTakeoverSearch(poisonConfig),
              true,
              initial.model ?? MODEL
            )
        noteContextBreakdown(
          sessionId,
          buildContextBreakdown({ system: systemText, tools, messages })
        )
        // 本地模型实验性增强：文本附件由页面读取，联网搜索借用服务端搜索做预检索
        let localAugment = ''
        if (localModel) {
          if (useSettings.getState().search && !(apiKey ?? '').trim()) {
            showToast({ key: 'localModelSearchNeedsKey' })
          }
          const augment = await buildLocalAugment({
            files: prepared.question.files,
            question: prepared.question.content,
            apiKey: apiKey ?? '',
            signal: controller.signal,
          })
          localAugment = augment.context
          if (augment.skippedFiles > 0) {
            showToast({
              key: 'localModelFilesSkipped',
              params: { count: augment.skippedFiles },
            })
          }
        }
        const events = localModel
          ? streamLocalMessage({
              model: initial.model ?? MODEL,
              // 本地模型没有 latest_reminder 角色，把本轮提醒与增强上下文拼到 system 末尾
              system: [systemText, localAugment, requestReminder].filter(Boolean).join('\n\n'),
              messages,
              signal: controller.signal,
            })
          : streamMessage(
              apiKey ?? '',
              {
                model: initial.model ?? MODEL,
                system: requestSystemText,
                messages,
                thinking: initial.thinking
                  ? fallbackNoReasoning
                    ? { type: 'enabled' }
                    : { type: 'enabled', budget_tokens: thinkingBudget(effort) }
                  : { type: 'disabled' },
                // 思考强度：0 档与降级后都不下发
                ...(initial.thinking && effort > 0 && !fallbackNoReasoning
                  ? { reasoning_effort: reasoningEffortValue(effort) }
                  : {}),
                temperature: autoTuned?.params.temperature ?? temperature,
                top_p: autoTuned?.params.top_p ?? topP,
                ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
                safety_check: safetyCheck(unrestricted || autoJailbreak, skipSafetyCheck),
                // 接管搜索时只保留阅读链接工具，模型只能看到本地注入的结果
                tools,
                ...(titleRequests.has(controller) ? { title: { enabled: true } } : {}),
              },
              controller.signal
            )
        const blockIndexes = new Map<number, number>()
        /** 本轮客户端工具调用：index → 累积中的参数 JSON */
        const toolSlots = new Map<number, { id: string; name: string; json: string }>()
        for await (const rawEvent of events) {
          const event = poisonStreamEvent(rawEvent, poisonConfig)
          receivedContent ||= event.type === 'content_block_start'
          if (event.type === 'message_start') {
            noteContextUsage(sessionId, event.message.usage)
            noteUsage(event.message.usage, 'start')
          } else if (event.type === 'content_block_start') {
            if (event.content_block.type === 'tool_use') {
              const block = event.content_block
              toolSlots.set(event.index, { id: block.id, name: block.name, json: '' })
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta.type === 'text_delta') {
              firstTokenAt ??= Date.now()
              noteDelta('text', event.delta.text)
            } else if (event.delta.type === 'thinking_delta') {
              firstTokenAt ??= Date.now()
              noteDelta('thinking', event.delta.thinking)
            } else if (event.delta.type === 'input_json_delta') {
              const slot = toolSlots.get(event.index)
              if (slot) {
                slot.json += event.delta.partial_json
              }
            }
          } else if (event.type === 'message_delta') {
            noteUsage(event.usage, 'delta')
          }
          if (
            event.type === 'message_delta' &&
            (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'max_tokens') &&
            event.delta.title?.trim() &&
            titleRequests.has(controller) &&
            !controller.signal.aborted &&
            !get().importingHistory
          ) {
            const title = event.delta.title.trim()
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
            titleRequests.delete(controller)
          }
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (streamOutput) {
            if (document.visibilityState === 'hidden') {
              flush()
            } else {
              frame ||= requestAnimationFrame(() => flush())
            }
          }
        }
        reply = settle(reply, 'done', Date.now())
        // 本地模型与 V4 Pro 没有服务端标题：首轮用提问开头几个字作为会话标题
        if (!serverTitle && !getSession(sessionId)?.title) {
          const title = request.question.content.replace(/\s+/g, ' ').trim().slice(0, 24)
          if (title) {
            updateSession(sessionId, (session) => (session.title ? session : { ...session, title }))
          }
        }
        // 客户端工具：模型请求了工具、且还有额度时，本地执行后带着结果再请求一轮
        if (
          reply.stopReason === 'tool_use' &&
          toolSlots.size > 0 &&
          toolRounds < Math.max(MAX_TOOL_ROUNDS, mode.maxRounds) &&
          !controller.signal.aborted
        ) {
          toolRounds += 1
          const calls: ChatToolCall[] = [...toolSlots.values()].map((slot) => {
            let input: unknown = {}
            if (slot.json.trim() !== '') {
              try {
                input = JSON.parse(slot.json)
              } catch {
                input = {}
              }
            }
            return createToolCall(slot.id, slot.name, input)
          })
          reply = { ...reply, toolCalls: [...(reply.toolCalls ?? []), ...calls] }
          updateReply(sessionId, reply)
          const locale = useSettings.getState().locale
          // PTC / 创造模式允许一轮里并发跑多个工具；结果顺序与 calls 一致，tool_result 不会错位
          const runOne = async (call: ChatToolCall): Promise<ChatToolCall> => {
            const finished = await runAgentToolCall(call, {
              signal: controller.signal,
              locale,
              onUpdate: (patch) => {
                reply = {
                  ...reply,
                  toolCalls: (reply.toolCalls ?? []).map((item) =>
                    item.id === call.id ? { ...item, ...patch } : item
                  ),
                }
                updateReply(sessionId, reply)
              },
            })
            reply = {
              ...reply,
              toolCalls: (reply.toolCalls ?? []).map((item) =>
                item.id === call.id ? finished : item
              ),
            }
            updateReply(sessionId, reply)
            persist(sessionId)
            return finished
          }
          const results: ChatToolCall[] = mode.parallel
            ? await Promise.all(calls.map(runOne))
            : await (async () => {
                const done: ChatToolCall[] = []
                for (const call of calls) {
                  done.push(await runOne(call))
                }
                return done
              })()
          // 本轮用量先入账，最后一轮由 finally 统一记；否则工具往返的中间轮会漏记
          if (reply.usage && !titleRequests.has(controller)) {
            noteDailyUsage(reply.model ?? MODEL, reply.usage)
            noteLedgerUsage(reply.model ?? MODEL, reply.usage, new Date(), {
              sessionId,
              pages: parsedPages(request.question.files),
            })
          }
          if (controller.signal.aborted) {
            reply = settle(reply, 'stopped', Date.now())
            break
          }
          toolMessages.push(
            {
              role: 'assistant',
              content: results.map((call) => ({
                type: 'tool_use' as const,
                id: call.id,
                name: call.name,
                input: call.input,
              })),
            },
            {
              role: 'user',
              content: results.map((call) => ({
                type: 'tool_result' as const,
                tool_use_id: call.id,
                content: toolResultForModel(call),
                is_error: call.status === 'error' || call.status === 'rejected',
              })),
            }
          )
          continue
        }
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settle(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settle(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 服务端不认识 reasoning_effort / budget_tokens 时，去掉强度参数退回普通思考重试一次
        if (
          initial.thinking &&
          !fallbackNoReasoning &&
          !receivedContent &&
          error instanceof ApiError &&
          error.status === 400 &&
          /reasoning|thinking|budget|effort/i.test(error.message)
        ) {
          fallbackNoReasoning = true
          showToast({ key: 'thinkingFallbackToast' })
          continue
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settle(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settle(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          reply = settle(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: error.localMessage,
          })
        } else {
          reply = settle(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    if (reply.status === 'done' || reply.status === 'stopped') {
      noteRunTiming(reply.id, {
        modelMs: Date.now() - runStartedAt,
        firstTokenMs: firstTokenAt === null ? null : firstTokenAt - runStartedAt,
      })
    }
    maybeAutoRetry(
      sessionId,
      reply,
      request.question.id,
      request.question.content,
      controller.signal.aborted
    )
    finishLiveRun(sessionId)
    // 每日用量与费用：标题请求不计入用户可见的日用量
    if (reply.usage && !titleRequests.has(controller)) {
      noteDailyUsage(reply.model ?? MODEL, reply.usage)
      // 账本同时留档，统计页的趋势图、热力图、小时分布与会话排行读它
      noteLedgerUsage(reply.model ?? MODEL, reply.usage, new Date(), {
        sessionId,
        pages: parsedPages(request.question.files),
      })
    }
    if (
      reply.status === 'done' &&
      reply.stopReason !== 'refusal' &&
      !titleRequests.has(controller) &&
      reply.usage &&
      useSettings.getState().savedMemoryEnabled &&
      (useSettings.getState().autoExtractMemory || getRole(getSession(sessionId)?.roleId).auto)
    ) {
      const memoryKey = useSettings.getState().apiKey ?? ''
      const userText = request.question.content
      void extractMemoriesFromTurn({
        apiKey: memoryKey,
        userText,
        assistantText: getReplyAnswerText(reply),
      }).then((summary) => {
        // 记忆提炼在后台静默进行：只有真正写入/替换/忘记，且用户没有关闭提示时才弹气泡
        if (summary && useSettings.getState().memoryUpdateNotice) {
          showToast({
            key: 'memoryUpdatedToast',
            params: { summary: summary.replace(/\s+/g, ' ').trim().slice(0, 60) },
          })
        }
      })
    }
    // 自定义结果在没有真实搜索步骤时补一个投毒步骤；错误与拒绝轮次不展示
    if (
      !localModel &&
      poisonConfig.enabled &&
      reply.status !== 'error' &&
      reply.stopReason !== 'refusal'
    ) {
      reply = attachPoisonResults(reply, poisonConfig)
    }
    reply = sanitizePoisonedReply(reply, poisonConfig)
    titleRequests.delete(controller)
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    updateReply(sessionId, reply)
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    // 自动压缩：回复结束后按轮数阈值在后台总结较早内容，失败静默
    const {
      autoCompress,
      apiKey: compressKey,
      locale: compressLocale,
      maxTokens,
    } = useSettings.getState()
    const current = getSession(sessionId)
    // 压力取最近一次请求的真实用量；阈值与圆环、统计弹窗共用 reserveGeometry
    const usageTokens = useContextUsage.getState().byId[sessionId]?.tokens ?? 0
    const window = contextWindowFor(initial.model ?? MODEL)
    if (
      reply.status === 'done' &&
      autoCompress &&
      compressKey &&
      current &&
      autoCompressNeeded(current, {
        tokens: usageTokens,
        window,
        maxOutputTokens: maxTokens ?? 8192,
      })
    ) {
      void compressSession(current, compressKey, compressLocale).then((outcome) => {
        if (outcome.ok) {
          setSessionCompression(sessionId, outcome.compression)
        }
      })
    }
  }
}
