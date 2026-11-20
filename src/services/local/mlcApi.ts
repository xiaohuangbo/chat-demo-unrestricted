import { translate } from '../../i18n/index.js'
import type { MlcModelInfo } from './store.js'

/**
 * MLC-LLM REST 服务客户端（移植自 mlc-ai/web-llm-chat 的 client/mlcllm.ts）。
 *
 * 服务端接口与 OpenAI 兼容：
 * - GET  {endpoint}/v1/models
 * - POST {endpoint}/v1/chat/completions（stream=true 时逐行 SSE）
 * 相比原实现改用规范的事件流解析，不再用正则只取第一段 data。
 */

export type MlcChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export type MlcGenerateParams = {
  endpoint: string
  model: string
  messages: MlcChatMessage[]
  temperature?: number
  topP?: number
  maxTokens?: number
  signal?: AbortSignal
  onDelta?: (chunk: string) => void
}

export type MlcGenerateResult = {
  content: string
  finishReason?: string
  usage?: { promptTokens: number; completionTokens: number }
}

export class MlcApiError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MlcApiError'
  }
}

/** 归一化地址：去掉末尾斜杠，用户已写 /v1 时不重复拼接 */
const baseOf = (endpoint: string): string => {
  const trimmed = endpoint.trim().replace(/\/+$/, '')
  return trimmed.replace(/\/v1$/, '')
}

export const listMlcModels = async (
  endpoint: string,
  signal?: AbortSignal
): Promise<MlcModelInfo[]> => {
  const base = baseOf(endpoint)
  if (!/^https?:\/\//i.test(base)) {
    throw new MlcApiError(translate('localModelMlcBadEndpoint'))
  }
  let response: Response
  try {
    response = await fetch(`${base}/v1/models`, { signal })
  } catch (error) {
    throw new MlcApiError(
      translate('localModelMlcUnreachable', {
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }
  if (!response.ok) {
    throw new MlcApiError(translate('localModelMlcBadStatus', { status: response.status }))
  }
  const payload: unknown = await response.json().catch(() => null)
  const list =
    typeof payload === 'object' &&
    payload !== null &&
    Array.isArray((payload as { data?: unknown }).data)
      ? ((payload as { data: unknown[] }).data ?? [])
      : Array.isArray(payload)
        ? payload
        : []
  return list.flatMap((item): MlcModelInfo[] => {
    if (typeof item === 'string') {
      return [{ id: item, label: shortModelName(item) }]
    }
    if (typeof item !== 'object' || item === null) {
      return []
    }
    const record = item as Record<string, unknown>
    const id =
      typeof record.id === 'string' ? record.id : typeof record.name === 'string' ? record.name : ''
    if (!id) {
      return []
    }
    const label =
      (typeof record.display_name === 'string' && record.display_name) ||
      (typeof record.displayName === 'string' && record.displayName) ||
      shortModelName(id)
    return [{ id, label }]
  })
}

/** MLC 服务返回的 id 常带路径（mlc-ai/Qwen2.5-…），列表里只显示最后一段 */
export const shortModelName = (id: string): string => id.split('/').filter(Boolean).pop() ?? id

type StreamChunk = {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null }
    finish_reason?: string | null
  }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string }
}

/** 逐事件解析 SSE：返回 data 行拼接后的负载 */
const readSseData = async function* (body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  while (true) {
    const { value, done } = await reader.read()
    if (done) {
      break
    }
    buffer += decoder.decode(value, { stream: true })
    // 兼容 CRLF：有的服务端按 SSE 规范发送 \r\n\r\n
    buffer = buffer.replace(/\r\n/g, '\n')
    let index = buffer.indexOf('\n\n')
    while (index !== -1) {
      const raw = buffer.slice(0, index)
      buffer = buffer.slice(index + 2)
      const data = raw
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n')
      if (data) {
        yield data
      }
      index = buffer.indexOf('\n\n')
    }
  }
  const tail = buffer
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n')
  if (tail) {
    yield tail
  }
}

/** 流式对话：把服务端分片拼成完整回复，并逐块回调 */
export const generateMlc = async (params: MlcGenerateParams): Promise<MlcGenerateResult> => {
  const base = baseOf(params.endpoint)
  if (!/^https?:\/\//i.test(base)) {
    throw new MlcApiError(translate('localModelMlcBadEndpoint'))
  }
  const body = {
    model: params.model,
    messages: params.messages,
    stream: true,
    temperature: params.temperature,
    top_p: params.topP,
    max_tokens: params.maxTokens,
    ...(params.onDelta ? { stream_options: { include_usage: true } } : {}),
  }
  let response: Response
  try {
    response = await fetch(`${base}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: params.signal,
    })
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw error
    }
    throw new MlcApiError(
      translate('localModelMlcUnreachable', {
        error: error instanceof Error ? error.message : String(error),
      })
    )
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new MlcApiError(
      translate('localModelMlcBadStatus', { status: response.status }) +
        (text ? `\n${text.slice(0, 500)}` : '')
    )
  }
  if (!response.body) {
    throw new MlcApiError(translate('localModelMlcNoBody'))
  }
  let content = ''
  let finishReason: string | undefined
  let usage: { promptTokens: number; completionTokens: number } | undefined
  for await (const data of readSseData(response.body)) {
    if (params.signal?.aborted) {
      break
    }
    if (data === '[DONE]') {
      break
    }
    let chunk: StreamChunk
    try {
      chunk = JSON.parse(data) as StreamChunk
    } catch {
      continue
    }
    if (chunk.error?.message) {
      throw new MlcApiError(chunk.error.message)
    }
    const choice = chunk.choices?.[0]
    const delta = choice?.delta?.content
    if (delta) {
      content += delta
      params.onDelta?.(delta)
    }
    if (choice?.finish_reason) {
      finishReason = choice.finish_reason
    }
    if (chunk.usage) {
      usage = {
        promptTokens: chunk.usage.prompt_tokens ?? 0,
        completionTokens: chunk.usage.completion_tokens ?? 0,
      }
    }
  }
  return { content, finishReason, usage }
}
