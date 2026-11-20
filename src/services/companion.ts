import { create } from 'zustand'
import { createId } from '../utils/id.js'

/**
 * 角色：一套可复用的助手人设（昵称、性别、人设提示词、头像、自动记忆）。
 *
 * 灵感来自 Remember 的角色卡：每个会话可以绑定一个角色，角色提示词作为
 * system 的一部分注入；头像与资料只存在本机。默认角色 `deepseek` 不加人设。
 */

export type Role = {
  id: string
  name: string
  gender: string
  prompt: string
  /** data URL；空字符串时显示名字首字 */
  avatar: string
  /** 该角色是否自动把重要信息写入长期记忆 */
  auto: boolean
}

export const BASIC_ROLE_ID = 'deepseek'

export const basicRole: Role = {
  id: BASIC_ROLE_ID,
  name: 'DeepSeek',
  gender: '',
  prompt: '',
  avatar: '',
  auto: false,
}

const ROLES_KEY = 'chat-demo:roles'
const ACTIVE_KEY = 'chat-demo:active-role'

const readJson = <T>(key: string): T | null => {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

const writeJson = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    // 隐私模式下写入失败不影响本次会话
  }
}

const normalizeRole = (value: unknown, index: number): Role | null => {
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const item = value as Partial<Role>
  const name = typeof item.name === 'string' ? item.name.trim().slice(0, 40) : ''
  if (!name) {
    return null
  }
  return {
    id: typeof item.id === 'string' && item.id ? item.id : `role-${index}-${Date.now()}`,
    name,
    gender: typeof item.gender === 'string' ? item.gender.slice(0, 30) : '',
    prompt: typeof item.prompt === 'string' ? item.prompt.slice(0, 3000) : '',
    avatar: typeof item.avatar === 'string' ? item.avatar : '',
    auto: item.auto === true,
  }
}

const initialRoles = (): Role[] => {
  const saved = readJson<unknown>(ROLES_KEY)
  const list = Array.isArray(saved)
    ? saved.flatMap((item, index) => {
        const role = normalizeRole(item, index)
        return role ? [role] : []
      })
    : []
  // 默认角色始终存在，且固定在第一位
  return [basicRole, ...list.filter((role) => role.id !== BASIC_ROLE_ID)]
}

const initialActive = (): string => {
  try {
    const saved = localStorage.getItem(ACTIVE_KEY)
    return saved && saved !== '' ? saved : BASIC_ROLE_ID
  } catch {
    return BASIC_ROLE_ID
  }
}

export const useRoles = create<{ roles: Role[]; activeId: string }>(() => ({
  roles: initialRoles(),
  activeId: initialActive(),
}))

const persistRoles = (roles: Role[]) => writeJson(ROLES_KEY, roles)

export const getRole = (id?: string): Role => {
  const roles = useRoles.getState().roles
  return roles.find((role) => role.id === id) ?? basicRole
}

export const activeRole = (): Role => getRole(useRoles.getState().activeId)

export const setActiveRole = (id: string) => {
  if (!useRoles.getState().roles.some((role) => role.id === id)) {
    return
  }
  try {
    localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    // 忽略
  }
  useRoles.setState({ activeId: id })
}

/** 新建角色：昵称必填，其余可稍后补 */
export const addRole = (patch: Partial<Omit<Role, 'id'>> = {}): Role => {
  const role: Role = {
    id: createId(),
    name: (patch.name ?? '').trim().slice(0, 40) || '新的聊天伙伴',
    gender: (patch.gender ?? '').slice(0, 30),
    prompt: (patch.prompt ?? '').slice(0, 3000),
    avatar: patch.avatar ?? '',
    auto: patch.auto === true,
  }
  const roles = [...useRoles.getState().roles, role]
  persistRoles(roles)
  useRoles.setState({ roles })
  return role
}

export const updateRole = (id: string, patch: Partial<Omit<Role, 'id'>>) => {
  if (id === BASIC_ROLE_ID) {
    // 默认角色只允许切换自动记忆
    const roles = useRoles
      .getState()
      .roles.map((role) => (role.id === id ? { ...role, auto: patch.auto ?? role.auto } : role))
    persistRoles(roles)
    useRoles.setState({ roles })
    return
  }
  const roles = useRoles.getState().roles.map((role) =>
    role.id === id
      ? {
          ...role,
          ...(patch.name !== undefined
            ? { name: patch.name.trim().slice(0, 40) || role.name }
            : {}),
          ...(patch.gender !== undefined ? { gender: patch.gender.slice(0, 30) } : {}),
          ...(patch.prompt !== undefined ? { prompt: patch.prompt.slice(0, 3000) } : {}),
          ...(patch.avatar !== undefined ? { avatar: patch.avatar } : {}),
          ...(patch.auto !== undefined ? { auto: patch.auto } : {}),
        }
      : role
  )
  persistRoles(roles)
  useRoles.setState({ roles })
}

export const removeRole = (id: string) => {
  if (id === BASIC_ROLE_ID) {
    return
  }
  const roles = useRoles.getState().roles.filter((role) => role.id !== id)
  persistRoles(roles)
  useRoles.setState({ roles })
  if (useRoles.getState().activeId === id) {
    setActiveRole(BASIC_ROLE_ID)
  }
}

/**
 * 角色注入 system 的片段：只描述助手本身，明确不把用户资料当角色经历。
 * 默认角色返回空串，保持纯 DeepSeek 风格。
 */
export const roleSystemPrompt = (role: Role, userName: string): string => {
  if (role.id === BASIC_ROLE_ID) {
    return ''
  }
  return [
    `助手身份：${role.name}。以下人设只描述助手，不描述用户；不要把用户经历当作自己的经历。`,
    role.gender ? `角色设定的性别：${role.gender}` : '',
    role.prompt,
    userName ? `用户称呼：${userName}` : '',
    '依据近期对话自然适应用户的语言与称呼，不要机械模仿或编造人设未提供的现实经历。',
  ]
    .filter(Boolean)
    .join('\n')
}
