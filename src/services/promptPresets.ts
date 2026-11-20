import { create } from 'zustand'
import { createId } from '../utils/id.js'
import { useSettings } from './settings.js'

/**
 * 多套系统提示词 / 多套思维链预设。
 *
 * 设置里实际下发的内容仍是 `settings.systemPrompt` 与 `settings.customCot`；
 * 预设库只负责保存多份文本与当前选中的 id，切换时把内容写回设置，
 * 这样请求管线、会话级提示词与导入导出都不需要感知预设的存在。
 */

export type PromptPresetKind = 'system' | 'cot'

export type PromptPresetItem = {
  id: string
  name: string
  content: string
  updatedAt: number
}

type PresetState = {
  system: PromptPresetItem[]
  cot: PromptPresetItem[]
  systemActiveId: string | null
  cotActiveId: string | null
}

const KEYS = {
  system: 'chat-demo:system-prompt-presets',
  cot: 'chat-demo:cot-presets',
  systemActive: 'chat-demo:system-prompt-active',
  cotActive: 'chat-demo:cot-active',
  migrated: 'chat-demo:prompt-presets-migrated',
} as const

const MAX_PRESETS = 30
const MAX_NAME = 40

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 隐私模式下写入失败不影响本次会话
  }
}

const normalizeItem = (value: unknown): PromptPresetItem | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const item = value as Partial<PromptPresetItem>
  if (typeof item.name !== 'string' || typeof item.content !== 'string') {
    return null
  }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : createId(),
    name: item.name.trim().slice(0, MAX_NAME) || '预设',
    content: item.content,
    updatedAt: typeof item.updatedAt === 'number' ? item.updatedAt : Date.now(),
  }
}

const readList = (key: string): PromptPresetItem[] => {
  const raw = read(key)
  if (!raw) {
    return []
  }
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed
      .flatMap((item) => {
        const preset = normalizeItem(item)
        return preset ? [preset] : []
      })
      .slice(0, MAX_PRESETS)
  } catch {
    return []
  }
}

const readActive = (key: string, list: PromptPresetItem[]): string | null => {
  const saved = read(key)
  return saved && list.some((item) => item.id === saved) ? saved : null
}

const initial = (): PresetState => {
  const system = readList(KEYS.system)
  const cot = readList(KEYS.cot)
  return {
    system,
    cot,
    systemActiveId: readActive(KEYS.systemActive, system),
    cotActiveId: readActive(KEYS.cotActive, cot),
  }
}

export const usePromptPresets = create<PresetState>(() => initial())

const persist = (kind: PromptPresetKind, list: PromptPresetItem[]) => {
  write(KEYS[kind], JSON.stringify(list))
}

const setActive = (kind: PromptPresetKind, id: string | null) => {
  write(kind === 'system' ? KEYS.systemActive : KEYS.cotActive, id)
  usePromptPresets.setState(kind === 'system' ? { systemActiveId: id } : { cotActiveId: id })
}

export const presetsOf = (kind: PromptPresetKind): PromptPresetItem[] =>
  usePromptPresets.getState()[kind]

export const activePreset = (kind: PromptPresetKind): PromptPresetItem | null => {
  const state = usePromptPresets.getState()
  const id = kind === 'system' ? state.systemActiveId : state.cotActiveId
  return state[kind].find((item) => item.id === id) ?? null
}

/** 新建预设：内容取当前编辑器里的文本，避免「新建」把正在写的内容丢掉 */
export const createPreset = (
  kind: PromptPresetKind,
  name: string,
  content: string
): PromptPresetItem | null => {
  const list = presetsOf(kind)
  if (list.length >= MAX_PRESETS) {
    return null
  }
  const item: PromptPresetItem = {
    id: createId(),
    name: name.trim().slice(0, MAX_NAME) || '预设',
    content,
    updatedAt: Date.now(),
  }
  const next = [...list, item]
  persist(kind, next)
  usePromptPresets.setState(kind === 'system' ? { system: next } : { cot: next })
  setActive(kind, item.id)
  return item
}

/** 克隆当前预设（没有选中时克隆编辑器内容） */
export const clonePreset = (
  kind: PromptPresetKind,
  content: string,
  name: string
): PromptPresetItem | null => createPreset(kind, name, content)

export const renamePreset = (kind: PromptPresetKind, id: string, name: string) => {
  const trimmed = name.trim().slice(0, MAX_NAME)
  if (!trimmed) {
    return
  }
  const next = presetsOf(kind).map((item) =>
    item.id === id ? { ...item, name: trimmed, updatedAt: Date.now() } : item
  )
  persist(kind, next)
  usePromptPresets.setState(kind === 'system' ? { system: next } : { cot: next })
}

export const updatePresetContent = (kind: PromptPresetKind, id: string, content: string) => {
  const list = presetsOf(kind)
  if (!list.some((item) => item.id === id)) {
    return
  }
  const next = list.map((item) =>
    item.id === id ? { ...item, content, updatedAt: Date.now() } : item
  )
  persist(kind, next)
  usePromptPresets.setState(kind === 'system' ? { system: next } : { cot: next })
}

export const deletePreset = (kind: PromptPresetKind, id: string) => {
  const next = presetsOf(kind).filter((item) => item.id !== id)
  persist(kind, next)
  usePromptPresets.setState(kind === 'system' ? { system: next } : { cot: next })
  const active =
    kind === 'system'
      ? usePromptPresets.getState().systemActiveId
      : usePromptPresets.getState().cotActiveId
  if (active === id) {
    setActive(kind, null)
  }
}

/** 选中预设：把内容写回设置，由调用方负责（需要 setSystemPrompt / setCustomCot） */
export const selectPreset = (kind: PromptPresetKind, id: string | null) => setActive(kind, id)

/**
 * 旧数据迁移：第一次打开设置时，把现有的自定义系统提示词与思维链各收进一个预设，
 * 之后用户就能直接克隆。只执行一次，空内容不生成系统提示词预设。
 */
export const ensurePromptPresetsMigrated = () => {
  if (read(KEYS.migrated) === 'true') {
    return
  }
  const state = usePromptPresets.getState()
  const settings = useSettings.getState()
  const zh = settings.locale === 'zh-CN'
  if (
    state.system.length === 0 &&
    settings.systemPrompt !== null &&
    settings.systemPrompt.trim() !== ''
  ) {
    createPreset('system', zh ? '我的系统提示词' : 'My system prompt', settings.systemPrompt)
  }
  if (state.cot.length === 0) {
    createPreset('cot', zh ? '默认思维链' : 'Default chain of thought', settings.customCot)
  }
  write(KEYS.migrated, 'true')
}

/** 恢复默认设置时清空预设库 */
export const resetPromptPresets = () => {
  write(KEYS.system, null)
  write(KEYS.cot, null)
  write(KEYS.systemActive, null)
  write(KEYS.cotActive, null)
  write(KEYS.migrated, null)
  usePromptPresets.setState({ system: [], cot: [], systemActiveId: null, cotActiveId: null })
}
