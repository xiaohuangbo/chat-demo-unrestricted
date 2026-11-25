import type {
  ClientToolDefinition,
  ClientToolUseBlockParam,
  ToolResultBlockParam,
} from '../api/types.js'
import type { AssistantMessage, UserMessage } from '../chat/types.js'

/**
 * 自定义提示词注入工具：把「回答正文」改成一次客户端工具调用的参数。
 *
 * 流程（全部在客户端这一层）：
 * 1. 请求里声明一个用户自定义的工具，描述写明「把输出正文写成这个工具的参数」；
 * 2. 打开「强制工具调用」时把 tool_choice 指向它，模型只能把正文写进参数；
 * 3. 收到回应后把参数还原成普通正文，界面与历史里看到的都是正常回答；
 * 4. 历史消息按规则反向还原成 tool_use / tool_result，让多轮上下文形状前后一致。
 *
 * 为什么需要第 4 步：tool_choice 指向具体工具后，模型的每一轮回答都是工具调用，
 * 如果历史里上一轮是纯文本、本轮却必须工具调用，模型会一边输出正文一边补工具调用；
 * 把历史也还原成同样的形状，模型只需要沿用它。
 *
 * 本模块不依赖 zustand，方便单测；配置只写 localStorage。
 */

/** 历史助手消息怎么转换 */
export type CustomAssistantRule = 'off' | 'generated' | 'all'
/** 历史用户消息怎么转换 */
export type CustomUserRule = 'off' | 'paired' | 'marked'

export type CustomInjectionConfig = {
  name: string
  description: string
  paramName: string
  paramDescription: string
  /** 把 tool_choice 指向这个工具；Anthropic 兼容接口在思考模式下不支持，请求里会自动降级 */
  forceToolChoice: boolean
  /** 历史助手消息 → tool_use */
  assistantRule: CustomAssistantRule
  /** 历史用户消息 → tool_result */
  userRule: CustomUserRule
  /** userRule 为 marked 时的前缀标记 */
  marker: string
}

export const CUSTOM_INJECTION_LIMITS = {
  name: 64,
  description: 4000,
  paramName: 64,
  paramDescription: 1000,
  marker: 40,
} as const

/** 工具名与参数名都要符合接口约束：字母数字下划线，且不能以数字开头 */
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/

export const DEFAULT_CUSTOM_INJECTION: CustomInjectionConfig = {
  name: 'emit_answer',
  description:
    '把你要给用户的全部回答正文写进参数 content，按 Markdown 正常排版。' +
    '正文之外不要写任何说明、前言或结尾语；需要展示的代码、列表、表格都放进 content。',
  paramName: 'content',
  paramDescription: '回答正文，支持 Markdown',
  forceToolChoice: true,
  assistantRule: 'generated',
  userRule: 'paired',
  marker: '§',
}

const text = (value: unknown, max: number): string =>
  typeof value === 'string' ? value.slice(0, max) : ''

const bool = (value: unknown, fallback: boolean): boolean =>
  typeof value === 'boolean' ? value : fallback

const oneOf = <T extends string>(value: unknown, list: readonly T[], fallback: T): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback

const NAME_FALLBACK = 'emit_answer'
const PARAM_FALLBACK = 'content'

/** 清理工具名 / 参数名：非法字符换成下划线，数字开头补前缀，空串回落到默认值 */
export const sanitizeToolName = (value: string, fallback = NAME_FALLBACK): string => {
  const cleaned = value
    .trim()
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, CUSTOM_INJECTION_LIMITS.name)
  if (!cleaned) {
    return fallback
  }
  return /^[0-9]/.test(cleaned) ? `tool_${cleaned}`.slice(0, CUSTOM_INJECTION_LIMITS.name) : cleaned
}

/** 合并式配置校验：字段缺失回落默认值，名称非法就地修正 */
export const normalizeCustomInjection = (
  value: Partial<CustomInjectionConfig> | null | undefined
): CustomInjectionConfig => {
  const raw = value ?? {}
  // 空名字允许存着（界面里正在重填），只是配置不成立、不会下发；有内容时统一清理非法字符
  const rawName = text(raw.name, CUSTOM_INJECTION_LIMITS.name + 8).trim()
  const rawParam = text(raw.paramName, CUSTOM_INJECTION_LIMITS.paramName + 8).trim()
  const name = rawName === '' ? '' : sanitizeToolName(rawName, '')
  const paramName = rawParam === '' ? '' : sanitizeToolName(rawParam, '')
  return {
    // 同名参数会让 schema 变成两个键，这里直接避免
    name,
    // 空描述留空存储：界面里可以整段清空重填，下发时再回落到默认文案
    description: text(raw.description, CUSTOM_INJECTION_LIMITS.description),
    paramName: paramName !== '' && paramName === name ? PARAM_FALLBACK : paramName,
    paramDescription: text(raw.paramDescription, CUSTOM_INJECTION_LIMITS.paramDescription),
    forceToolChoice: bool(raw.forceToolChoice, DEFAULT_CUSTOM_INJECTION.forceToolChoice),
    assistantRule: oneOf<CustomAssistantRule>(
      raw.assistantRule,
      ['off', 'generated', 'all'],
      DEFAULT_CUSTOM_INJECTION.assistantRule
    ),
    userRule: oneOf<CustomUserRule>(
      raw.userRule,
      ['off', 'paired', 'marked'],
      DEFAULT_CUSTOM_INJECTION.userRule
    ),
    marker: text(raw.marker, CUSTOM_INJECTION_LIMITS.marker).trim(),
  }
}

/** 配置是否足够成立：名称与参数名都必须合法 */
export const customInjectionReady = (config: CustomInjectionConfig): boolean =>
  NAME_RE.test(config.name) && NAME_RE.test(config.paramName) && config.name !== config.paramName

/** 下发给接口的工具定义 */
export const customInjectionDefinition = (
  config: CustomInjectionConfig
): ClientToolDefinition => ({
  name: config.name,
  description: config.description.trim() || DEFAULT_CUSTOM_INJECTION.description,
  input_schema: {
    type: 'object',
    properties: {
      [config.paramName]: {
        type: 'string',
        description: config.paramDescription.trim() || DEFAULT_CUSTOM_INJECTION.paramDescription,
      },
    },
    required: [config.paramName],
    additionalProperties: false,
  },
})

/** 强制模式下的 tool_choice；接口只接受 {type:'tool', name} */
export const customInjectionToolChoice = (
  config: CustomInjectionConfig
): { type: 'tool'; name: string } => ({ type: 'tool', name: config.name })

/** 这次调用是不是注入工具（名字必须完全一致） */
export const isCustomInjectionCall = (name: string, config: CustomInjectionConfig): boolean =>
  name === config.name

const firstString = (input: Record<string, unknown>): string => {
  for (const value of Object.values(input)) {
    if (typeof value === 'string') {
      return value
    }
  }
  return ''
}

/**
 * 从工具参数里取出正文：优先取配置的参数名，模型用了别的键时退而取第一个字符串，
 * 这样参数名改了、模型仍按历史里的旧键返回时也不会丢正文。
 */
export const extractCustomBody = (
  input: unknown,
  config: CustomInjectionConfig
): string => {
  if (typeof input === 'string') {
    return input
  }
  if (typeof input !== 'object' || input === null) {
    return ''
  }
  const record = input as Record<string, unknown>
  const value = record[config.paramName]
  if (typeof value === 'string') {
    return value
  }
  return firstString(record)
}

/** 回复里记录的一次注入调用：历史转换时按当时的名字与参数还原 */
export type CustomToolMark = {
  name: string
  param: string
}

/** 历史转换计划：由设置里的规则与当前配置算出来 */
export type CustomHistoryPlan = {
  config: CustomInjectionConfig
  /** 这条助手消息是否要被转成 tool_use */
  convertAssistant: (reply: AssistantMessage) => boolean
  /** 这条用户消息是否要被转成 tool_result */
  convertUser: (user: UserMessage) => boolean
}

/** 历史转换是否可能生效：助手规则与用户规则都关闭时不做任何转换 */
export const customHistoryEnabled = (config: CustomInjectionConfig): boolean =>
  config.assistantRule !== 'off' && config.userRule !== 'off'

const markedUser = (user: UserMessage, marker: string): boolean =>
  marker !== '' && user.content.trimStart().startsWith(marker)

/** 用户消息命中 marked 规则时，去掉标记后的正文才进入 tool_result */
const stripMarker = (content: string, marker: string): string => {
  if (!marker) {
    return content
  }
  const trimmed = content.trimStart()
  return trimmed.startsWith(marker) ? trimmed.slice(marker.length).trimStart() : content
}

export const customHistoryPlan = (config: CustomInjectionConfig): CustomHistoryPlan => ({
  config,
  convertAssistant: (reply) => {
    if (config.assistantRule === 'off' || !hasAnswerBody(reply)) {
      return false
    }
    // generated 只还原本工具生成的回复，all 连普通回答一起还原
    return config.assistantRule === 'all' || reply.customTool?.name === config.name
  },
  convertUser: (user) => {
    if (config.userRule === 'off') {
      return false
    }
    return config.userRule === 'paired' || markedUser(user, config.marker)
  },
})

/** 历史里要还原的正文：只用正文段，思考与服务端工具块不回传 */
const hasAnswerBody = (reply: AssistantMessage): boolean =>
  reply.blocks.some((block) => block.type === 'text' && !block.isTemplate && block.text.trim() !== '')

/** 还原后的正文（去掉模板提示） */
export const customReplyBody = (reply: AssistantMessage): string =>
  reply.blocks
    .flatMap((block) => (block.type === 'text' && !block.isTemplate ? [block.text] : []))
    .join('')

/** 用回复 id 派生一个稳定的 tool_use id，`id` 不超过 64 字符 */
export const customToolUseId = (replyId: string): string =>
  `toolu_${replyId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 56)}`

/** 助手消息还原成 tool_use 的内容块 */
export const toCustomToolUse = (
  reply: AssistantMessage,
  config: CustomInjectionConfig
): ClientToolUseBlockParam | null => {
  const body = customReplyBody(reply)
  if (body.trim() === '') {
    return null
  }
  const mark = reply.customTool
  return {
    type: 'tool_use',
    id: customToolUseId(reply.id),
    name: mark?.name ?? config.name,
    input: { [mark?.param ?? config.paramName]: body },
  }
}

/** 用户消息还原成 tool_result 的内容块 */
export const toCustomToolResult = (
  user: UserMessage,
  toolUseId: string,
  config: CustomInjectionConfig
): ToolResultBlockParam => ({
  type: 'tool_result',
  tool_use_id: toolUseId,
  content: stripMarker(user.content, config.marker) || '（本轮没有文字，只有附件）',
})
