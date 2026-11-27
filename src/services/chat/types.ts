import type { ChatToolCall } from '../agent/types.js'
import type { TranslationMessage } from '../../i18n/index.js'
import type { ApiErrorKind } from '../api/client.js'
import type {
  ChatModel,
  MessageUsage,
  ServerToolBlock,
  StopDetails,
  StopReason,
  TextCitation,
} from '../api/types.js'

/**
 * 消息附件。id 是本地标识（IndexedDB files 表的主键，原件按它存储，所有引用同一 id 的消息共用一份），
 * 导入的附件沿用导出产物里的文件 ID；本地没有原件的附件只展示文件名，不进入请求。
 * serverId 是 Files API 返回的 file_id，导入的数据或尚未上传成功的文件为 null，发送前补传。
 */
export type FileAttachment = {
  id: string
  serverId: string | null
  /** 当前 serverId 对应的上传图片已确认符合长边限制。旧记录缺少此字段。 */
  imageSizeChecked?: boolean
  name: string
  size: number
  /** 附件类别；导入时沿用归档的 is_image，不由 MIME 识别结果决定。 */
  isImage: boolean
  /** 具体 MIME；导入时没有原件或无法识别的为空字符串，不影响图片身份。 */
  mimeType: string
  /** 上传时使用的附件投毒指纹；off 为干净文件，skip 为伴随文本附件 */
  poison?: string
  /** 自动生成的伴随文本附件 */
  generated?: boolean
  /** 实验性 1M 上下文：不走 Files API，正文在发送时直接拼进提问 */
  inline?: boolean
  /** 组装请求时读出的正文快照，只存在于请求副本里，不写入会话 */
  inlineText?: string
}

/** 本地消息的分支关系；字段缺省时按线性消息列表处理。 */
type MessageBranch = {
  parentId?: string | null
  /** 当前选中的下一条消息；切换版本时保留每条分支原有的选择。 */
  selectedChildId?: string
}

export type UserMessage = MessageBranch & {
  id: string
  role: 'user'
  content: string
  files: FileAttachment[]
  createdAt: number
}

/** 思考块：thinking_delta 累积，签名随 signature_delta 到达；历史轮次的思考服务端会丢弃，不回传 */
export type ThinkingPart = {
  type: 'thinking'
  thinking: string
  signature?: string
  /** content_block_start 的时间；没有事件时间的历史块缺省 */
  startedAt?: number
  /** content_block_stop（或回复结束）的时间 */
  endedAt?: number
  /** 仅有耗时、没有事件时间时保存秒数。 */
  elapsedSeconds?: number
}

/** 文本块：text_delta 累积，citations_delta 追加引用 */
export type TextPart = {
  type: 'text'
  text: string
  citations?: TextCitation[]
  /** 服务端提示文案，仅用于展示，不作为模型回答参与上下文或续写。 */
  isTemplate?: boolean
}

/** 服务端工具调用与结果块按协议原样保存；历史请求只回传 read_link 调用与结果 */
export type ReplyBlock = ThinkingPart | TextPart | ServerToolBlock

/**
 * pending：已发出请求，还没收到事件；streaming：正在接收；
 * done：收到 message_stop；stopped：用户停止或页面关闭；error：请求或流出错
 */
export type ReplyStatus = 'pending' | 'streaming' | 'done' | 'stopped' | 'error'

export type AssistantMessage = MessageBranch & {
  id: string
  role: 'assistant'
  createdAt: number
  /** 未记录模型时为 null，续写使用当前默认模型。 */
  model: ChatModel | null
  /** 请求时是否开启深度思考 */
  thinking?: boolean
  /** 本轮请求注入的自定义思维链快照；关闭深度思考时在回复上方展示 */
  customCot?: string
  /** 本轮调用的浏览器工具记录；导出的历史包不含该字段，重新导入后不显示 */
  toolCalls?: ChatToolCall[]
  /**
   * 本轮正文是通过「提示词注入工具」返回的：记录当时的工具名与参数名，
   * 历史请求据此把这条回答还原成 tool_use（设置改了也不会错乱）。
   */
  customTool?: { name: string; param: string }
  /** 请求时是否声明 deepseek_web_search；关闭时仍声明 deepseek_read_url */
  search?: boolean
  /** 本轮请求的系统信息快照；各回答版本独立保存，续写沿用。历史消息中缺省的快照保持为空。 */
  latestReminder?: string
  /** 是否允许作为续写前缀；仍需满足回复状态与内容限制。 */
  prefix: boolean
  status: ReplyStatus
  /** 可识别的内容块按接收顺序排列；续写产生的块追加在已有块之后 */
  blocks: ReplyBlock[]
  stopReason?: StopReason
  stopDetails?: StopDetails
  /** 最近一次请求的用量，续写后更新 */
  usage?: MessageUsage
  /**
   * 本地改写记录：改后的正文与思维链直接写回 blocks，这里只保存首次改写前的原始块快照，
   * 用于「还原原文」。续写会让快照与当前块对不上，因此续写时丢弃该记录。
   */
  edited?: {
    at: number
    blocks: ReplyBlock[]
  }
  error?: {
    /** upload：发送前补传附件失败，请求没有发出 */
    kind: ApiErrorKind | 'upload'
    message: string
    status?: number
    localMessage?: TranslationMessage
    /** 仅 upload：重新上传是否可能成功（网络、限流、服务端繁忙）；过大、格式不支持为 false */
    retryable?: boolean
  }
}

export type Message = UserMessage | AssistantMessage

/** 会话压缩摘要：摘要覆盖到 upToMessageId 为止的较早消息 */
export type SessionCompression = {
  summary: string
  upToMessageId: string
  /** 被压缩的对话轮数 */
  rounds: number
  /** 摘要替代的历史估算节省的 token */
  savedTokens?: number
  at: number
}

export type Session = {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  /** 包含所有分支的消息，按创建顺序存储。 */
  messages: Message[]
  /** 本会话专用的系统提示词（如实验台组合）；为空时按全局设置组装 */
  systemPrompt?: string
  /** 长对话压缩：较早内容的摘要与截止消息 */
  compression?: SessionCompression
  /** 会话绑定的角色 id；缺省或 deepseek 表示默认风格 */
  roleId?: string
  /** 置顶：排在列表最前的「置顶」分组里，按最近更新排序 */
  pinned?: boolean
  /** undefined 表示线性消息列表；null 表示空会话。 */
  rootMessageId?: string | null
}

/** 会话列表元数据；消息只在打开会话时加载。 */
export type SessionSummary = Pick<
  Session,
  'id' | 'title' | 'createdAt' | 'updatedAt' | 'roleId' | 'pinned'
>

/** 显式提取字段，避免将完整会话的消息带进列表。 */
export const toSessionSummary = (session: SessionSummary): SessionSummary => ({
  ...(session.roleId ? { roleId: session.roleId } : {}),
  ...(session.pinned ? { pinned: true } : {}),
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
})
