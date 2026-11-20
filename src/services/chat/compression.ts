import { streamMessage } from '../api/client.js'
import type { Locale } from '../settings.js'
import { getVisibleMessages } from './branches.js'
import { getReplyAnswerText } from './reply.js'
import type { Session, SessionCompression } from './types.js'
import { estimateTokens } from './sessionStats.js'
import { reserveGeometry } from './contextPressure.js'
import { useSettings } from '../settings.js'

/**
 * 长对话压缩：把较早的轮次交给模型总结成摘要，摘要进入后续请求的上下文，
 * 本地完整历史仍然保留（只在请求里跳过被摘要覆盖的部分）。
 *
 * 手动压缩由统计弹窗触发；自动压缩在回复结束后按轮数阈值触发。
 */

/** 至少要有 3 轮可压缩内容 */
const MIN_ROUNDS = 3
/** 压缩时始终保留最近 2 轮原文 */
const KEEP_ROUNDS = 2
/** 上次压缩后新增多少轮再触发一次自动压缩 */
const AUTO_MIN_NEW_ROUNDS = 2
/** 摘要请求的输入上限，避免一次塞入过长文本 */
const MAX_TRANSCRIPT_CHARS = 48_000

const running = new Set<string>()

export const isCompressing = (sessionId: string) => running.has(sessionId)

export type CompressOutcome =
  | { ok: true; compression: SessionCompression }
  | { ok: false; reason: 'tooShort' | 'busy' | 'noKey' | 'error' }

const roundCount = (session: Session): number =>
  getVisibleMessages(session).filter((message) => message.role === 'user').length

/** 自动压缩判断的输入：最近一次请求的实际用量与窗口 */
export type AutoCompressInput = {
  tokens: number
  window: number
  maxOutputTokens: number
}

/**
 * 自动压缩判断（对齐 DSH：压力达到窗口 80%，且不吃掉输出预留与 64k 余量）：
 * 先按阈值判断压力，再要求至少有一组可压缩轮次、且距上次压缩有新增内容。
 */
export const autoCompressNeeded = (session: Session, pressure: AutoCompressInput): boolean => {
  const geometry = reserveGeometry(pressure.window, pressure.maxOutputTokens)
  const custom = useSettings.getState().compressThreshold
  // 自定义阈值优先：达到阈值且仍有可压缩轮次就触发；0 表示沿用上下文压力规则
  const threshold = custom > 0 ? custom : (geometry?.threshold ?? 0)
  if (threshold <= 0 || pressure.tokens < threshold) {
    return false
  }
  if (roundCount(session) < MIN_ROUNDS + KEEP_ROUNDS) {
    return false
  }
  const compression = session.compression
  if (!compression) {
    return true
  }
  const visible = getVisibleMessages(session)
  const cutoff = visible.findIndex((message) => message.id === compression.upToMessageId)
  if (cutoff < 0) {
    return true
  }
  const newRounds = visible.slice(cutoff + 1).filter((message) => message.role === 'user').length
  return newRounds >= AUTO_MIN_NEW_ROUNDS
}

const messageText = (message: ReturnType<typeof getVisibleMessages>[number]): string =>
  message.role === 'user' ? message.content : getReplyAnswerText(message)

/** 把要压缩的消息拼成带角色的纯文本，单条过长时截断 */
const buildTranscript = (
  messages: ReturnType<typeof getVisibleMessages>,
  locale: Locale
): string => {
  const userLabel = locale === 'zh-CN' ? '用户' : 'User'
  const assistantLabel = locale === 'zh-CN' ? '助手' : 'Assistant'
  const lines: string[] = []
  let total = 0
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') {
      continue
    }
    const text = messageText(message).trim()
    if (text === '') {
      continue
    }
    const clipped = text.length > 4000 ? `${text.slice(0, 4000)}…` : text
    const line = `${message.role === 'user' ? userLabel : assistantLabel}: ${clipped}`
    if (total + line.length > MAX_TRANSCRIPT_CHARS) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.join('\n\n')
}

const summarize = async (
  apiKey: string,
  transcript: string,
  locale: Locale,
  signal: AbortSignal
): Promise<string> => {
  const system =
    locale === 'zh-CN'
      ? '你是对话压缩器。把用户给出的对话记录压缩成结构化摘要，固定包含：1) 目标与约束；2) 已确认的事实、决定与结论；3) 代码/文件/产物的当前状态；4) 未完成事项与下一步；5) 重要错误与规避方式。用第三人称中文分条列出，保留关键标识符与数字；不要编造，不要评论，只输出摘要正文。'
      : 'You compress conversations. Summarise the supplied transcript into a structured summary with: 1) goals and constraints; 2) confirmed facts, decisions and conclusions; 3) current state of code/files/artifacts; 4) open items and next steps; 5) important errors and workarounds. Use third person bullets, keep identifiers and numbers; do not invent, do not comment; output only the summary body.'
  const body = {
    model: 'deepseek-flash' as const,
    system,
    messages: [{ role: 'user' as const, content: transcript }],
    thinking: { type: 'disabled' as const },
    temperature: 0.3,
    max_tokens: 1200,
    tools: [],
  }
  let text = ''
  for await (const event of streamMessage(apiKey, body, signal)) {
    if (event.type === 'content_block_start' && event.content_block.type === 'text') {
      text += event.content_block.text
    } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}

/**
 * 压缩一个会话的较早轮次。返回新的压缩记录，调用方负责写回会话并提示。
 * 已压缩过的会话再次压缩时，会把上一次的摘要一并作为输入，避免丢信息。
 */
export const compressSession = async (
  session: Session,
  apiKey: string,
  locale: Locale
): Promise<CompressOutcome> => {
  if (!apiKey) {
    return { ok: false, reason: 'noKey' }
  }
  if (running.has(session.id)) {
    return { ok: false, reason: 'busy' }
  }
  const visible = getVisibleMessages(session)
  const userIndexes = visible
    .map((message, index) => (message.role === 'user' ? index : -1))
    .filter((index) => index >= 0)
  if (userIndexes.length < MIN_ROUNDS + KEEP_ROUNDS) {
    return { ok: false, reason: 'tooShort' }
  }
  const cutoffRound = userIndexes.length - KEEP_ROUNDS
  const cutoffIndex = userIndexes[cutoffRound] - 1
  if (cutoffIndex < 0) {
    return { ok: false, reason: 'tooShort' }
  }
  const target = visible.slice(0, cutoffIndex + 1)
  const transcript = buildTranscript(target, locale)
  if (transcript === '') {
    return { ok: false, reason: 'tooShort' }
  }
  running.add(session.id)
  const controller = new AbortController()
  try {
    const previous = session.compression
    const header =
      previous && locale === 'zh-CN'
        ? `上一次的摘要：\n${previous.summary}\n\n新增对话：\n`
        : previous
          ? `Previous summary:\n${previous.summary}\n\nNew transcript:\n`
          : ''
    const summary = await summarize(apiKey, `${header}${transcript}`, locale, controller.signal)
    if (summary === '') {
      return { ok: false, reason: 'error' }
    }
    return {
      ok: true,
      compression: {
        summary,
        upToMessageId: visible[cutoffIndex].id,
        rounds: cutoffRound,
        // 摘要替换掉的那段历史与摘要本身的 token 差，用于圆环折算与统计展示
        savedTokens: Math.max(0, estimateTokens(transcript) - estimateTokens(summary)),
        at: Date.now(),
      },
    }
  } catch {
    return { ok: false, reason: 'error' }
  } finally {
    running.delete(session.id)
  }
}
