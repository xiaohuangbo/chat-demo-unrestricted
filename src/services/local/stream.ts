import type { MessageParam, MessageStreamEvent, MessageUsage } from '../api/types.js'
import { generate, LocalModelError, type LocalChatMessage } from './engine.js'
import { generateMlc } from './mlcApi.js'
import { isMlcModel, isWebllmModel, mlcModelId } from './catalog.js'
import { useLocalModels } from './store.js'
import { useSettings } from '../settings.js'

/**
 * 把本地模型（WebLLM / MLC-LLM API）的生成过程包装成和云端一致的 `MessageStreamEvent` 流。
 *
 * 这样聊天 store 里已有的落盘、动画帧刷新、停止、统计、Markdown 渲染全部复用，
 * 不需要为本地模型另写一套消息管线。生成函数通过 onDelta 回调推送分片，
 * 这里用一个极小的无锁队列把它转成 AsyncGenerator，保证逐字输出。
 */

const textOf = (value: unknown): string => {
  if (typeof value === 'string') {
    return value
  }
  if (!Array.isArray(value)) {
    return ''
  }
  return value
    .flatMap((block) =>
      block &&
      typeof block === 'object' &&
      (block as { type?: unknown }).type === 'text' &&
      typeof (block as { text?: unknown }).text === 'string'
        ? [(block as { text: string }).text]
        : []
    )
    .join('')
}

/** 简化版的请求消息转换：只保留文本，附件、图片与工具块会被丢掉 */
export const flattenMessages = (messages: MessageParam[]): LocalChatMessage[] => {
  const flattened: LocalChatMessage[] = []
  const push = (role: LocalChatMessage['role'], content: string) => {
    if (!content.trim()) {
      return
    }
    const last = flattened[flattened.length - 1]
    if (last && last.role === role) {
      last.content = `${last.content}\n\n${content}`
      return
    }
    flattened.push({ role, content })
  }
  for (const message of messages) {
    if (message.role === 'user') {
      push('user', textOf(message.content))
    } else if (message.role === 'assistant') {
      push('assistant', textOf(message.content))
    }
  }
  return flattened
}

export type LocalStreamOptions = {
  model: string
  system: string
  messages: MessageParam[]
  signal: AbortSignal
}

const toUsage = (usage?: {
  promptTokens: number
  completionTokens: number
}): MessageUsage | undefined =>
  usage
    ? {
        input_tokens: usage.promptTokens,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: usage.completionTokens,
      }
    : undefined

const stopReasonOf = (finishReason?: string): 'end_turn' | 'max_tokens' | 'refusal' => {
  if (finishReason === 'length' || finishReason === 'max_tokens') {
    return 'max_tokens'
  }
  if (finishReason === 'content_filter') {
    return 'refusal'
  }
  return 'end_turn'
}

/** 回调 → 异步迭代器的最小桥：生成在后台跑，消费者逐个取分片 */
const createChunkQueue = () => {
  const queue: string[] = []
  let wake: (() => void) | null = null
  let closed = false
  const push = (chunk: string) => {
    if (chunk) {
      queue.push(chunk)
      wake?.()
      wake = null
    }
  }
  const close = () => {
    closed = true
    wake?.()
    wake = null
  }
  const next = async (): Promise<string | null> => {
    while (queue.length === 0 && !closed) {
      await new Promise<void>((resolve) => {
        wake = resolve
      })
    }
    return queue.shift() ?? null
  }
  return { push, close, next }
}

/**
 * 只需要一段完整文本的本地调用（长期记忆提炼、压缩摘要等）：
 * 复用同一个引擎，温度固定为 0，避免额外分支。
 */
export const generateLocalText = async ({
  system,
  user,
  maxTokens,
  signal,
}: {
  system: string
  user: string
  maxTokens: number
  signal?: AbortSignal
}): Promise<string> => {
  const selection = useSettings.getState().model
  const state = useLocalModels.getState()
  const messages: LocalChatMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
  if (isWebllmModel(selection)) {
    const result = await generate({
      messages,
      temperature: 0,
      topP: 1,
      maxTokens,
      presencePenalty: 0,
      frequencyPenalty: 0,
      signal,
      enableThinking: useSettings.getState().thinking,
    })
    return result.content
  }
  if (isMlcModel(selection)) {
    const result = await generateMlc({
      endpoint: state.mlcEndpoint,
      model: mlcModelId(selection),
      messages,
      temperature: 0,
      topP: 1,
      maxTokens,
      signal,
    })
    return result.content
  }
  return ''
}

/** 本地模型的统一入口：按前缀分发到 WebLLM 或 MLC-LLM API */
export async function* streamLocalMessage(
  options: LocalStreamOptions
): AsyncGenerator<MessageStreamEvent> {
  const selection = options.model
  const state = useLocalModels.getState()
  const messages: LocalChatMessage[] = [
    ...(options.system.trim() ? [{ role: 'system' as const, content: options.system }] : []),
    ...flattenMessages(options.messages),
  ]
  const messageId =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`

  yield { type: 'message_start', message: { id: messageId, model: selection } }
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }

  const queue = createChunkQueue()
  const task = (async () => {
    if (isWebllmModel(selection)) {
      return generate({
        messages,
        temperature: state.temperature,
        topP: state.topP,
        maxTokens: state.maxTokens || undefined,
        presencePenalty: state.presencePenalty,
        frequencyPenalty: state.frequencyPenalty,
        // 与输入栏「深度思考」联动：0 档关闭，1–4 档交给 Qwen3 的 thinking 开关
        enableThinking: useSettings.getState().thinking,
        signal: options.signal,
        onDelta: queue.push,
      })
    }
    if (isMlcModel(selection)) {
      return generateMlc({
        endpoint: state.mlcEndpoint,
        model: mlcModelId(selection),
        messages,
        temperature: state.temperature,
        topP: state.topP,
        maxTokens: state.maxTokens || undefined,
        signal: options.signal,
        onDelta: queue.push,
      })
    }
    throw new LocalModelError(`Unknown local model: ${selection}`)
  })()
  task.finally(queue.close).catch(() => {
    // 真正的错误在下面 await task 时抛出
  })

  while (true) {
    const chunk = await queue.next()
    if (chunk === null) {
      break
    }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: chunk } }
  }
  const result = await task
  if (options.signal.aborted) {
    return
  }
  yield { type: 'content_block_stop', index: 0 }
  yield {
    type: 'message_delta',
    delta: { stop_reason: stopReasonOf(result.finishReason), stop_sequence: null },
    usage: toUsage(result.usage),
  }
  yield { type: 'message_stop' }
}
