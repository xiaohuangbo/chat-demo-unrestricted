import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { isLocalModel } from '../local/catalog.js'
import { generateLocalText } from '../local/stream.js'
import { streamMessage } from '../api/client.js'
import { useSettings } from '../settings.js'
import { translate } from '../../i18n/index.js'
import { removeSavedMemoryNode, upsertSavedMemoryNode } from './memoryBank.js'

/**
 * 长期记忆（参考 DeepChat 的 SavedMemory）：
 * - 手动添加 / 编辑 / 启停 / 删除；
 * - 每轮结束后可静默提炼新的长期事实；
 * - 启用的记忆在请求时注入 system，并同步到网状记忆库。
 */

export type SavedMemoryItem = {
  id: string
  content: string
  enabled: boolean
  updatedAt: number
}

const STORAGE_KEY = 'chat-demo:saved-memories'
const MAX_MEMORY_CHARS = 1800
const EXTRACTOR_TIMEOUT = 15_000

const read = (): SavedMemoryItem[] => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return []
    }
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is SavedMemoryItem =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SavedMemoryItem).id === 'string' &&
        typeof (item as SavedMemoryItem).content === 'string' &&
        typeof (item as SavedMemoryItem).enabled === 'boolean' &&
        typeof (item as SavedMemoryItem).updatedAt === 'number'
    )
  } catch {
    return []
  }
}

const write = (items: SavedMemoryItem[]) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items))
  } catch {
    // 存储不可用时只保留内存状态
  }
}

export const useSavedMemories = create<{ items: SavedMemoryItem[] }>(() => ({
  items: read(),
}))

const syncToBank = (item: SavedMemoryItem) => {
  if (item.enabled) {
    upsertSavedMemoryNode(item.id, item.content, useSettings.getState().memoryBankDimension)
  } else {
    removeSavedMemoryNode(item.id)
  }
}

const commit = (items: SavedMemoryItem[]) => {
  write(items)
  useSavedMemories.setState({ items })
}

export const addSavedMemory = (content: string): SavedMemoryItem | null => {
  const text = content.trim()
  if (!text) {
    return null
  }
  const current = useSavedMemories.getState().items
  const duplicate = current.find((item) => item.content.trim() === text)
  if (duplicate) {
    if (!duplicate.enabled) {
      const enabled = { ...duplicate, enabled: true, updatedAt: Date.now() }
      commit(current.map((item) => (item.id === duplicate.id ? enabled : item)))
      syncToBank(enabled)
      return enabled
    }
    return duplicate
  }
  const created: SavedMemoryItem = {
    id: createId(),
    content: text,
    enabled: true,
    updatedAt: Date.now(),
  }
  commit([created, ...current])
  syncToBank(created)
  return created
}

export const updateSavedMemory = (id: string, content: string): boolean => {
  const text = content.trim()
  if (!text) {
    return false
  }
  const current = useSavedMemories.getState().items
  if (!current.some((item) => item.id === id)) {
    return false
  }
  const next = current.map((item) =>
    item.id === id ? { ...item, content: text, updatedAt: Date.now() } : item
  )
  commit(next)
  const updated = next.find((item) => item.id === id)
  if (updated) {
    syncToBank(updated)
  }
  return true
}

export const toggleSavedMemory = (id: string) => {
  const current = useSavedMemories.getState().items
  const next = current.map((item) =>
    item.id === id ? { ...item, enabled: !item.enabled, updatedAt: Date.now() } : item
  )
  commit(next)
  const updated = next.find((item) => item.id === id)
  if (updated) {
    syncToBank(updated)
  }
}

export const deleteSavedMemory = (id: string) => {
  const current = useSavedMemories.getState().items
  commit(current.filter((item) => item.id !== id))
  removeSavedMemoryNode(id)
}

/** 导入记忆归档时整体替换（不自动同步记忆库，归档里通常已包含节点） */
export const replaceSavedMemories = (items: SavedMemoryItem[]) => {
  commit(items)
}

export const clearSavedMemories = () => {
  const current = useSavedMemories.getState().items
  for (const item of current) {
    removeSavedMemoryNode(item.id)
  }
  commit([])
}

/** 启用的长期记忆拼成注入文本 */
export const formatSavedMemories = (): string => {
  const enabled = useSavedMemories
    .getState()
    .items.filter((item) => item.enabled && item.content.trim())
  if (enabled.length === 0) {
    return ''
  }
  const header = translate('memorySavedHeader')
  const lines = [header]
  let total = header.length
  for (const item of enabled) {
    const line = `- ${item.content.trim()}`
    if (total + line.length + 1 > MAX_MEMORY_CHARS && lines.length > 1) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}

type MemoryOperation =
  | { action: 'add'; content: string }
  | { action: 'update'; id: string; content: string }
  | { action: 'delete'; id: string }

const EXTRACTOR_SYSTEM_ZH = `你是长期记忆提炼器。根据本轮对话，判断是否有需要长期保存的关于用户的稳定事实、身份、职业、长期偏好、常用工具/语言或明确要求“记住”的信息。
规则：
1. 只提取来自用户且具有长期价值的信息；一次性任务细节、临时报错代码或闲聊不要提取。
2. 如果新信息更新或推翻了已有记忆，使用 update 替换对应 id；如果用户要求忘记某条，使用 delete；如果是全新事实，使用 add。
3. 严禁重复添加已有记忆。如果没有任何需要新增或修改的记忆，必须返回 []。
4. 只输出合法 JSON 数组，不要输出任何额外解释或 Markdown。格式示例：
[{"action":"add","content":"用户是一名前端工程师，偏好使用 TypeScript"}]`

const EXTRACTOR_SYSTEM_EN = `You extract long-term memory. From this turn, decide whether there is stable information about the user worth saving: identity, occupation, long-term preferences, tools/languages, or an explicit request to remember something.
Rules:
1. Only extract user-originated information with long-term value; skip one-off task details, temporary error codes and small talk.
2. If new information updates or contradicts an existing memory, use update with its id; if the user asks to forget one, use delete; otherwise use add.
3. Never duplicate an existing memory. If nothing should be added or changed, return [].
4. Output only a valid JSON array, with no explanation or Markdown. Example:
[{"action":"add","content":"The user is a frontend engineer who prefers TypeScript"}]`

const parseOperations = (raw: string): MemoryOperation[] => {
  const stripped = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()
  if (!stripped.startsWith('[')) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(stripped)
    if (!Array.isArray(parsed)) {
      return []
    }
    const ops: MemoryOperation[] = []
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) {
        continue
      }
      const record = item as Record<string, unknown>
      if (record.action === 'add' && typeof record.content === 'string' && record.content.trim()) {
        ops.push({ action: 'add', content: record.content.trim() })
      } else if (
        record.action === 'update' &&
        typeof record.id === 'string' &&
        typeof record.content === 'string' &&
        record.content.trim()
      ) {
        ops.push({ action: 'update', id: record.id, content: record.content.trim() })
      } else if (record.action === 'delete' && typeof record.id === 'string') {
        ops.push({ action: 'delete', id: record.id })
      }
    }
    return ops
  } catch {
    return []
  }
}

/** 静默提炼长期记忆；返回是否有变更 */
export const extractMemoriesFromTurn = async ({
  apiKey,
  userText,
  assistantText,
}: {
  apiKey: string
  userText: string
  assistantText: string
}): Promise<boolean> => {
  const question = userText.trim()
  const local = isLocalModel(useSettings.getState().model)
  if (local ? !question : !apiKey || !question) {
    return false
  }
  const existing = useSavedMemories.getState().items
  const locale = useSettings.getState().locale
  const existingBlock =
    existing.length > 0
      ? existing.map((item) => `[${item.id}] ${item.content}`).join('\n')
      : locale === 'zh-CN'
        ? '（暂无）'
        : '(none)'
  const system = locale === 'zh-CN' ? EXTRACTOR_SYSTEM_ZH : EXTRACTOR_SYSTEM_EN
  const prompt =
    locale === 'zh-CN'
      ? `已有记忆：\n${existingBlock}\n\n本轮对话：\n用户：${question}\n助手：${assistantText.slice(0, 600)}`
      : `Existing memories:\n${existingBlock}\n\nThis turn:\nUser: ${question}\nAssistant: ${assistantText.slice(0, 600)}`
  const controller = new AbortController()
  // 本地模型首次提炼可能要等权重加载，给更长的超时
  const timer = setTimeout(() => controller.abort(), local ? 180_000 : EXTRACTOR_TIMEOUT)
  try {
    let output = ''
    if (local) {
      output = await generateLocalText({
        system,
        user: prompt,
        maxTokens: 300,
        signal: controller.signal,
      })
    } else {
      const events = streamMessage(
        apiKey,
        {
          model: 'deepseek-flash',
          system,
          messages: [{ role: 'user', content: prompt }],
          thinking: { type: 'disabled' },
          temperature: 0,
          max_tokens: 300,
          tools: [],
        },
        controller.signal
      )
      for await (const event of events) {
        if (event.type === 'content_block_start' && event.content_block.type === 'text') {
          output += event.content_block.text
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          output += event.delta.text
        }
      }
    }
    const ops = parseOperations(output)
    if (ops.length === 0) {
      return false
    }
    let changed = false
    for (const op of ops) {
      if (op.action === 'add') {
        changed = addSavedMemory(op.content) !== null || changed
      } else if (op.action === 'update') {
        changed = updateSavedMemory(op.id, op.content) || changed
      } else {
        deleteSavedMemory(op.id)
        changed = true
      }
    }
    return changed
  } catch {
    // 提炼失败静默忽略，不影响正常对话
    return false
  } finally {
    clearTimeout(timer)
  }
}
