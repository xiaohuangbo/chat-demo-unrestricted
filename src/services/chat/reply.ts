import type {
  AssistantBlockParam,
  FileBlockParam,
  MessageParam,
  MessageStreamEvent,
  OutputBlockStart,
  TextBlockParam,
  ToolResultBlockParam,
} from '../api/types.js'
import { translate } from '../../i18n/index.js'
import { inlineAttachmentText } from '../attachmentLargeText.js'
import { isPoisonToolId } from '../searchPoison.js'
import {
  toCustomToolResult,
  toCustomToolUse,
  type CustomHistoryPlan,
} from '../agent/customInjection.js'
import type {
  AssistantMessage,
  FileAttachment,
  Message,
  ReplyBlock,
  ReplyStatus,
  SessionCompression,
  UserMessage,
} from './types.js'

/**
 * 文件按 Files API 的 file_id（附件的 serverId）引用：图片用 image 块，其余用 document 块。
 * 发送前 streamReply 会先补齐 serverId；仍为 null 的是本地没有原件的附件，不进入请求。
 */
const toFileBlocks = (files: FileAttachment[]): FileBlockParam[] =>
  files.flatMap(({ serverId, isImage }) =>
    serverId
      ? [
          {
            type: isImage ? 'image' : 'document',
            source: { type: 'file', file_id: serverId },
          },
        ]
      : []
  )

const toReplyBlock = (block: OutputBlockStart, now: number): ReplyBlock | null => {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text, citations: block.citations ?? [] }
    case 'thinking':
      return {
        type: 'thinking',
        thinking: block.thinking,
        signature: block.signature,
        startedAt: now,
      }
    case 'server_tool_use':
    case 'web_search_tool_result':
    case 'web_fetch_tool_result':
      return block
    default:
      return null
  }
}

const updateBlock = (
  reply: AssistantMessage,
  index: number,
  update: (block: ReplyBlock) => ReplyBlock
): AssistantMessage => {
  const block = reply.blocks[index]
  if (!block) {
    return reply
  }
  const blocks = [...reply.blocks]
  blocks[index] = update(block)
  return { ...reply, blocks }
}

/**
 * 把一个流式事件合并进回复：只追加可识别的内容块，用本次请求的临时索引映射处理增量。
 * 跳过的块不占位；续写直接追加到已有内容之后，message_delta 更新结束原因与累计用量。
 */
export const applyEvent = (
  reply: AssistantMessage,
  event: MessageStreamEvent,
  now: number,
  blockIndexes: Map<number, number>
): AssistantMessage => {
  const next: AssistantMessage =
    reply.status === 'streaming' ? reply : { ...reply, status: 'streaming' }
  switch (event.type) {
    case 'message_start':
      return { ...next, usage: event.message.usage ?? next.usage }
    case 'content_block_start': {
      blockIndexes.delete(event.index)
      const block = toReplyBlock(event.content_block, now)
      if (!block) {
        // 客户端工具内容不保存；未完成的工具往返也不能作为续写前缀。
        return event.content_block.type === 'tool_use' ? { ...next, prefix: false } : next
      }
      blockIndexes.set(event.index, next.blocks.length)
      return { ...next, blocks: [...next.blocks, block] }
    }
    case 'content_block_delta': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      const { delta } = event
      return updateBlock(next, index, (block) => {
        if (block.type === 'text' && delta.type === 'text_delta') {
          return { ...block, text: block.text + delta.text }
        }
        if (block.type === 'thinking' && delta.type === 'thinking_delta') {
          return { ...block, thinking: block.thinking + delta.thinking }
        }
        if (block.type === 'thinking' && delta.type === 'signature_delta') {
          return { ...block, signature: (block.signature ?? '') + delta.signature }
        }
        if (block.type === 'text' && delta.type === 'citations_delta') {
          return { ...block, citations: [...(block.citations ?? []), delta.citation] }
        }
        return block
      })
    }
    case 'content_block_stop': {
      const index = blockIndexes.get(event.index)
      if (index === undefined) {
        return next
      }
      blockIndexes.delete(event.index)
      return updateBlock(next, index, (block) =>
        block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
          ? { ...block, endedAt: now }
          : block
      )
    }
    case 'message_delta':
      return {
        ...next,
        stopReason: event.delta.stop_reason,
        stopDetails: event.delta.stop_details,
        usage: event.usage ?? next.usage,
      }
    default:
      return next
  }
}

/**
 * 回复结束：未结束的思考块以当前时间收尾。
 * 安全拒绝（stop_reason: refusal）时已下发的思考与正文按协议要求由客户端丢弃，只保留工具块；
 * 开启防撤回（keepRefused）时反而保留这些内容，供界面展示并继续进入上下文。
 */
export const settleReply = (
  reply: AssistantMessage,
  status: Extract<ReplyStatus, 'done' | 'stopped' | 'error'>,
  now: number,
  error?: AssistantMessage['error'],
  keepRefused = false
): AssistantMessage => ({
  ...reply,
  status,
  error,
  blocks: reply.blocks.flatMap((block): ReplyBlock[] => {
    if (
      reply.stopReason === 'refusal' &&
      !keepRefused &&
      (block.type === 'thinking' || block.type === 'text')
    ) {
      return []
    }
    return block.type === 'thinking' && block.startedAt !== undefined && block.endedAt === undefined
      ? [{ ...block, endedAt: now }]
      : [block]
  }),
})

/**
 * 注入工具的正文还原：把工具参数里的正文接回回答末尾，并记下当时的工具名与参数名
 * （历史请求据此还原成 tool_use）。这一轮本来以 tool_use 结束，还原后按正常回答处理。
 */
export const applyCustomBody = (
  reply: AssistantMessage,
  body: string,
  mark: NonNullable<AssistantMessage['customTool']>
): AssistantMessage => {
  let blocks = reply.blocks
  if (body !== '') {
    const last = blocks.at(-1)
    blocks =
      last?.type === 'text' && !last.isTemplate
        ? [...blocks.slice(0, -1), { ...last, text: last.text + body }]
        : [...blocks, { type: 'text', text: body }]
  }
  return {
    ...reply,
    blocks,
    customTool: mark,
    // 正文已经还原成普通回答：结束原因与续写资格都按正常回答恢复
    stopReason: reply.stopReason === 'tool_use' ? 'end_turn' : reply.stopReason,
    prefix: true,
  }
}

/**
 * 回复是否保留了服务端已下发的正文或思维链。
 * 拒绝回复默认被清空，只有开启防撤回时才有内容，界面据此决定是否按正常回复展示。
 */
export const hasReplyContent = (reply: Pick<AssistantMessage, 'blocks'>): boolean =>
  reply.blocks.some(
    (block) =>
      (block.type === 'text' && !block.isTemplate && block.text.trim() !== '') ||
      (block.type === 'thinking' && block.thinking.trim() !== '')
  )

/** 回复里所有文本块拼起来，用于复制与判断是否有回答 */
export const getReplyText = (reply: AssistantMessage) =>
  reply.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')

/**
 * 末尾连续的正文块：界面上展示为「回答」的文本段。
 * 模板提示不是模型正文，出现在末尾时终止这一段。
 */
const getAnswerIndexes = (blocks: ReplyBlock[]): number[] => {
  const indexes: number[] = []
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index]
    if (block.type !== 'text' || block.isTemplate) {
      break
    }
    indexes.unshift(index)
  }
  return indexes
}

/** 思维链：所有思考块的文本，按块顺序用空行连接 */
const joinThinking = (blocks: ReplyBlock[]): string =>
  blocks.flatMap((block) => (block.type === 'thinking' ? [block.thinking] : [])).join('\n\n')

/** 正文：末尾正文段的拼接结果，与界面上展示的回答一致 */
const joinAnswer = (blocks: ReplyBlock[]): string =>
  getAnswerIndexes(blocks)
    .map((index) => (blocks[index] as Extract<ReplyBlock, { type: 'text' }>).text)
    .join('')

export const getReplyThinking = (reply: AssistantMessage): string => joinThinking(reply.blocks)

export const getReplyAnswerText = (reply: AssistantMessage): string => joinAnswer(reply.blocks)

/**
 * 把用户改写的思维链与正文写回内容块，之后每一轮请求都从这里取内容：
 * - 思维链写入第一个思考块，其余思考块清空；原本没有思考块且有内容时在最前面新建一个；
 * - 正文写入末尾正文段的第一个文本块，其余文本块清空；原本没有正文段且有内容时追加一个文本块；
 * - 正文改动会丢弃引用标记（位置已失效），模板提示、工具块与思考签名保持原样；
 * - 只有内容确实变化的字段才会重写，避免只改思维链时误清引用。
 */
export const rewriteReplyBlocks = (
  blocks: ReplyBlock[],
  next: { thinking: string; text: string }
): ReplyBlock[] => {
  let result = blocks
  if (next.thinking !== joinThinking(blocks)) {
    const indexes = result.flatMap((block, index) => (block.type === 'thinking' ? [index] : []))
    if (indexes.length === 0) {
      if (next.thinking.trim()) {
        result = [{ type: 'thinking', thinking: next.thinking }, ...result]
      }
    } else {
      result = [...result]
      const [first, ...rest] = indexes
      const head = result[first]
      if (head.type === 'thinking') {
        result[first] = { ...head, thinking: next.thinking }
      }
      for (const index of rest) {
        const block = result[index]
        if (block.type === 'thinking') {
          result[index] = { ...block, thinking: '', signature: undefined }
        }
      }
    }
  }
  if (next.text !== joinAnswer(blocks)) {
    const indexes = getAnswerIndexes(result)
    if (indexes.length > 0) {
      result = [...result]
      const [first, ...rest] = indexes
      const head = result[first]
      if (head.type === 'text') {
        result[first] = { ...head, text: next.text, citations: [] }
      }
      for (const index of rest) {
        const block = result[index]
        if (block.type === 'text') {
          result[index] = { ...block, text: '', citations: [] }
        }
      }
    } else if (next.text !== '') {
      result = [...result, { type: 'text', text: next.text }]
    }
  }
  return result
}

/**
 * 只有正常达到输出上限或被停止的回复可续写，报错回复不能续写。
 * 末条限制由调用方判断，客户端工具调用不能续写。
 * 被安全审核拒绝的回复默认不能续写；allowRefused 为 true（设置开关或越狱模式）时放开。
 * 本轮含服务端工具调用或结果（含 READ_LINK 和孤立结果块）的回复不能续写。
 * 服务端模板提示不能作为续写前缀。
 */
export const canContinueReply = (reply: AssistantMessage, allowRefused = false): boolean => {
  if (
    !reply.prefix ||
    (reply.stopReason === 'refusal' && !allowRefused) ||
    reply.stopReason === 'tool_use' ||
    reply.blocks.some(
      (block) =>
        (block.type === 'server_tool_use' && !isPoisonToolId(block.id)) ||
        (block.type === 'web_search_tool_result' && !isPoisonToolId(block.tool_use_id)) ||
        block.type === 'web_fetch_tool_result' ||
        (block.type === 'text' && block.isTemplate)
    )
  ) {
    return false
  }
  // 被拒绝的回复按「正常结束」参与续写判断，其余维持原有规则。
  const done =
    reply.status === 'done' &&
    (reply.stopReason === 'max_tokens' || (allowRefused && reply.stopReason === 'refusal'))
  return reply.status === 'stopped' || done
}

/**
 * 已结束或停止且有回答文本的回复才放进上下文。
 * 被安全拒绝的轮次默认没有正文，自然不进上下文；开启防撤回保留了正文时按正常轮次回传。
 * 服务端模板提示不进入上下文。
 */
const isUsableReply = (message: Message): message is AssistantMessage =>
  message.role === 'assistant' &&
  (message.status === 'done' || message.status === 'stopped') &&
  !message.blocks.some((block) => block.type === 'text' && block.isTemplate) &&
  getReplyText(message) !== ''

/** 直接放入上下文的附件：正文以文本块跟在文件块之后，服务端不再解析文档 */
const toInlineBlocks = (files: FileAttachment[]): TextBlockParam[] =>
  files.flatMap(({ inline, inlineText, name }) =>
    inline && inlineText
      ? [{ type: 'text' as const, text: inlineAttachmentText(name, inlineText) }]
      : []
  )

const hasInlineText = (files: FileAttachment[]): boolean =>
  files.some(({ inline, inlineText }) => inline && inlineText)

/** 提问是否会进入请求：没有文字、没有可用附件、也没有直接放入上下文正文时整轮省略 */
const userHasBody = ({ content, files }: UserMessage): boolean =>
  content !== '' || toFileBlocks(files).length > 0 || hasInlineText(files)

/**
 * 有文件时用内容块数组：先文件块、再直接放入上下文的正文，最后是本轮文字。
 * 传入 toolResult 时这条提问按「注入工具的历史还原」处理：正文整体放进 tool_result，
 * 且 tool_result 必须排在文件块之前（同一消息里 tool_result 只能出现在最前面）。
 */
const toUserParam = (
  { content, files }: UserMessage,
  toolResult?: ToolResultBlockParam
): MessageParam => {
  const blocks: (FileBlockParam | TextBlockParam)[] = [
    ...toFileBlocks(files),
    ...toInlineBlocks(files),
  ]
  if (toolResult) {
    return { role: 'user', content: [toolResult, ...blocks] }
  }
  return blocks.length === 0
    ? { role: 'user', content }
    : {
        role: 'user',
        content: [...blocks, ...(content ? [{ type: 'text' as const, text: content }] : [])],
      }
}

/**
 * assistant 的内容块按历史与续写场景转换：
 * - 历史思考及其签名不回传；开启思考时续写只保留本轮非空白思考及其签名；
 * - 文本块去掉 citations（服务端忽略）。相邻文本直接拼接，被思考或工具隔开的文本用空行连接；
 *   省略历史思考后仍保留其前后正文的空行；
 * - 工具调用和结果只保留 kind 为 read_link 的块，其他历史工具块不回传；
 * - 阅读链接结果原样回传，保留 signature：服务端解密后将页面拼回该轮提问末尾；
 */
const toAssistantParam = (
  { blocks }: AssistantMessage,
  prefix = false,
  thinking = false,
  disguiseThinking = false
): Extract<MessageParam, { role: 'assistant' }> => {
  const content: AssistantBlockParam[] = []
  // 成功阅读的网页靠签名恢复正文；缺少有效签名时，调用与结果都不回传。
  const unsignedReadLinks = new Set(
    blocks.flatMap((block) =>
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      block.content.type === 'web_fetch_result' &&
      !block.signature?.trim()
        ? [block.tool_use_id]
        : []
    )
  )
  /** 正在拼接的文本块；遇到任何非文本块（含不回传的思考块）就结束 */
  let text: TextBlockParam | null = null
  for (const block of blocks) {
    // 空思考不改变续写位置，也不应把两段正文隔开，导致后端额外插入空行。
    if (prefix && block.type === 'thinking' && !block.thinking.trim()) {
      continue
    }
    // 历史 thinking 默认被服务端丢弃；开启开关后把它并入助手正文，随历史一起下发。
    // 只在最后一条历史回复上传入 disguiseThinking，避免整段历史重复放大 token。
    if (!prefix && disguiseThinking && block.type === 'thinking' && block.thinking.trim()) {
      const converted: TextBlockParam = {
        type: 'text',
        text: `${translate('thinkingDisguiseHeader')}\n${block.thinking}\n\n`,
      }
      content.push(converted)
      text = converted
      continue
    }
    if (block.type === 'text') {
      if (text) {
        text.text += block.text
      } else {
        const previous = content.at(-1)
        text = {
          type: 'text',
          text: `${previous?.type === 'text' ? '\n\n' : ''}${block.text}`,
        }
        content.push(text)
      }
      continue
    }
    text = null
    if (prefix && thinking && block.type === 'thinking') {
      // 续写保留本轮思考，历史轮次的思考省略。
      const { type, thinking, signature } = block
      content.push({ type, thinking, signature: signature ?? '' })
    } else if (
      block.type === 'server_tool_use' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.id)
    ) {
      const { type, id, name, input, kind } = block
      content.push({ type, id, name, input, kind })
    } else if (
      block.type === 'web_fetch_tool_result' &&
      block.kind === 'read_link' &&
      !unsignedReadLinks.has(block.tool_use_id)
    ) {
      content.push(block)
    }
  }
  return {
    role: 'assistant',
    content: content.filter((block) => block.type !== 'text' || block.text !== ''),
  }
}

/** 历史中会进入请求上下文的轮次：提问后紧跟可用回答的才保留 */
export const getContextRounds = (history: Message[]): [UserMessage, AssistantMessage][] => {
  const rounds: [UserMessage, AssistantMessage][] = []
  for (let i = 0; i + 1 < history.length; i++) {
    const [user, reply] = [history[i], history[i + 1]]
    if (user.role === 'user' && isUsableReply(reply)) {
      rounds.push([user, reply])
      i++
    }
  }
  return rounds
}

/**
 * 把会话转成请求的 messages：只保留「提问 + 有回答的回复」成对的轮次，最后接上本轮提问。
 * 失败或没有回答的轮次不进上下文。续写时末尾再带上本轮 assistant。
 */
export const toRequestMessages = (
  history: Message[],
  question: UserMessage,
  prefix?: AssistantMessage,
  thinking = prefix?.thinking ?? false,
  latestReminder?: string,
  compression?: SessionCompression,
  disguiseThinking = false,
  omitReminders = false,
  /** 注入工具的历史还原规则；null 表示按普通文本回传历史 */
  customPlan?: CustomHistoryPlan | null
): MessageParam[] => {
  const messages: MessageParam[] = []
  let previousReminder: string | undefined
  const appendReminder = (reminder: string | undefined) => {
    // V4 Pro 不接受 latest_reminder 角色，提醒由调用方折进 system
    if (omitReminders) {
      return
    }
    // 仅在当前分支首次出现或内容变化时插入快照；缺少快照的消息保持原有内容。
    if (reminder && reminder !== previousReminder) {
      messages.push({ role: 'latest_reminder', content: reminder })
      previousReminder = reminder
    }
  }
  let rounds = getContextRounds(history)
  if (compression && !omitReminders) {
    const cutoff = history.findIndex((message) => message.id === compression.upToMessageId)
    if (cutoff >= 0) {
      const kept = new Set(history.slice(cutoff + 1).map((message) => message.id))
      rounds = rounds.filter(([user]) => kept.has(user.id))
      // 摘要放在最前面，后面只跟压缩点之后的轮次
      messages.push({
        role: 'latest_reminder',
        content: `${translate('compressSummaryHeader', { rounds: compression.rounds })}\n${compression.summary}`,
      })
    }
  }
  const lastRound = rounds.length - 1
  /** 上一条被还原成 tool_use 的回复：下一次提问要作为它的 tool_result 回传 */
  let pendingToolUseId: string | null = null
  rounds.forEach(([user, reply], index) => {
    // 历史提问没有文字、附件也都没有 serverId 且没有直接放入上下文的正文时，提问为空，连同回答一起省略。
    if (!userHasBody(user)) {
      return
    }
    // 助手回复能否还原，取决于紧随其后的那条提问是否也按 tool_result 回传（协议要求成对出现）
    const nextUser = rounds[index + 1]?.[0] ?? question
    const toolUse =
      customPlan &&
      customPlan.convertAssistant(reply) &&
      customPlan.convertUser(nextUser) &&
      // 用户消息整条被省略时不能还原：tool_use 后面必须跟得上 tool_result
      userHasBody(nextUser)
        ? toCustomToolUse(reply, customPlan.config)
        : null
    // 服务端要求 latest_reminder 必须紧跟一条 user：所以提醒只能插在提问之前。
    // 上一条回复是 tool_use 时，这次提问就是它的 tool_result，中间不能夹其它角色，本轮提醒快照跳过。
    if (pendingToolUseId === null) {
      appendReminder(reply.latestReminder)
    }
    messages.push(
      toUserParam(
        user,
        pendingToolUseId !== null && customPlan
          ? toCustomToolResult(user, pendingToolUseId, customPlan.config)
          : undefined
      )
    )
    pendingToolUseId = null
    if (toolUse) {
      messages.push({ role: 'assistant', content: [toolUse] })
      pendingToolUseId = toolUse.id
    } else {
      messages.push(
        toAssistantParam(reply, false, thinking, disguiseThinking && index === lastRound)
      )
    }
  })
  appendReminder(latestReminder)
  messages.push(
    toUserParam(
      question,
      pendingToolUseId !== null && customPlan
        ? toCustomToolResult(question, pendingToolUseId, customPlan.config)
        : undefined
    )
  )
  if (prefix?.prefix) {
    const assistant = toAssistantParam(prefix, true, thinking)
    // 没有非空白正文或有效思考时直接重发原问题，避免服务端拒绝空 Prefill。
    if (
      assistant.content.some(
        (block) =>
          (block.type === 'text' && block.text.trim()) ||
          (block.type === 'thinking' && block.thinking.trim())
      )
    ) {
      messages.push(assistant)
    }
  }
  return messages
}

/** 思考用时（秒），至少 1 秒 */
export const getThinkingSeconds = (startedAt: number, endedAt: number) =>
  Math.max(1, Math.round((endedAt - startedAt) / 1000))
