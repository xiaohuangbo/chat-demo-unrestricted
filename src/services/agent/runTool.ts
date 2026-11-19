import { agentToolGroup, isAgentToolEnabled, modeAllowsTool } from './agentToolSettings.js'
import { modePolicy } from '../chat/mode.js'
import { requestToolApproval } from './approval.js'
import { agentToolById, type ToolContext } from './tools.js'
import type { ChatToolCall } from './types.js'

/**
 * 执行一次客户端工具调用，返回可以直接写进回复的展示记录。
 *
 * 职责边界：这里只负责「找到工具 → 确认 → 带超时执行 → 归一化结果」，
 * 不关心流式回复和请求重发；那些在 chat store 里。
 */

/** 单个工具的执行上限；定位、抓网页可能慢，给足时间但不能无限挂住回复 */
const TOOL_TIMEOUT_MS = 60_000

export const createToolCall = (id: string, name: string, input: unknown): ChatToolCall => ({
  id,
  name,
  label: agentToolById(name)?.label ?? name,
  input,
  status: 'running',
  startedAt: Date.now(),
})

export const runAgentToolCall = async (
  call: ChatToolCall,
  {
    signal,
    locale,
    onUpdate,
  }: {
    signal: AbortSignal
    locale: string
    onUpdate?: (patch: Partial<ChatToolCall>) => void
  }
): Promise<ChatToolCall> => {
  const tool = agentToolById(call.name)
  if (!tool) {
    return { ...call, status: 'error', content: `未知工具：${call.name}`, endedAt: Date.now() }
  }
  // 开关关闭的工具不下发，但模型可能凭历史记忆调用它：这里再拦一次
  if (!isAgentToolEnabled(tool.id)) {
    return {
      ...call,
      status: 'error',
      content: `工具「${tool.label}」已在设置中关闭，未执行`,
      endedAt: Date.now(),
    }
  }

  // 聊天模式也会拦一次：模型可能凭历史记忆调用上一轮还能用的工具
  if (!modeAllowsTool(tool.id)) {
    return {
      ...call,
      status: 'error',
      content: `当前聊天模式不允许使用工具「${tool.label}」，请在输入栏切换模式后再试`,
      endedAt: Date.now(),
    }
  }

  const input =
    typeof call.input === 'object' && call.input !== null
      ? (call.input as Record<string, unknown>)
      : {}

  // 创造模式里虚拟机工具的确认交给模型自己把握，不再逐次弹窗
  const autoApproved = modePolicy().autoApproveVm && agentToolGroup(tool.id) === 'nanovm'

  if (tool.requiresApproval && !autoApproved) {
    onUpdate?.({ detail: '等待确认…' })
    const allowed = await requestToolApproval({
      id: call.id,
      toolId: tool.id,
      label: tool.label,
      input: call.input,
    })
    if (!allowed) {
      return { ...call, status: 'rejected', content: '用户拒绝执行该工具', endedAt: Date.now() }
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), tool.timeoutMs ?? TOOL_TIMEOUT_MS)
  const abort = () => controller.abort()
  signal.addEventListener('abort', abort, { once: true })

  const context: ToolContext = {
    signal: controller.signal,
    locale,
    progress: (text) => onUpdate?.({ detail: text }),
    requestApproval: async () =>
      requestToolApproval({
        id: `${call.id}-inner`,
        toolId: tool.id,
        label: tool.label,
        input: call.input,
      }),
  }

  try {
    const result = await tool.run(input, context)
    return {
      ...call,
      status: result.isError ? 'error' : 'done',
      content: result.content,
      artifacts: result.artifacts,
      detail: undefined,
      endedAt: Date.now(),
    }
  } catch (error) {
    const aborted = controller.signal.aborted
    return {
      ...call,
      status: 'error',
      content: aborted
        ? '工具执行超时或已取消'
        : `执行失败：${error instanceof Error ? error.message : String(error)}`,
      detail: undefined,
      endedAt: Date.now(),
    }
  } finally {
    clearTimeout(timer)
    signal.removeEventListener('abort', abort)
  }
}

/** 工具结果回传给模型时的文本；产物只给摘要，避免把整份文件再塞进上下文 */
export const toolResultForModel = (call: ChatToolCall): string => {
  const base = call.content ?? ''
  if (!call.artifacts?.length) {
    return base
  }
  const artifacts = call.artifacts
    .map((artifact) => `- ${artifact.name}（${artifact.kind}，${artifact.size} 字节）`)
    .join('\n')
  return `${base}\n产物：\n${artifacts}`
}
