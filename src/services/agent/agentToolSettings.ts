import { create } from 'zustand'
import {
  allAgentTools,
  CUSTOM_INJECTION_TOOL_ID,
  registerNanovmTools,
  registerWebvmTools,
  registerUnkernelTools,
  registerWorkspaceTools,
  type AgentTool,
} from './tools.js'
import { WORKSPACE_TOOLS } from './workspaceTools.js'
import { NANOVM_TOOLS } from './nanovmTools.js'
import { WEBVM_TOOLS } from './webvmTools.js'
import { UNKERNEL_TOOLS } from './unkernelTools.js'
import { isWorkspaceEnabled } from '../workspace/store.js'
import { nanoVMAgentAvailable } from '../nanovm/config.js'
import { webVMAgentAvailable } from '../webvm/config.js'
import { unkernelAgentAvailable } from '../unkernel/config.js'
import { modeAllowsGroup, type ToolGroup } from '../chat/mode.js'

const WORKSPACE_IDS = new Set(WORKSPACE_TOOLS.map((tool) => tool.id))
const NANOVM_IDS = new Set(NANOVM_TOOLS.map((tool) => tool.id))
const WEBVM_IDS = new Set(WEBVM_TOOLS.map((tool) => tool.id))
const UNKERNEL_IDS = new Set(UNKERNEL_TOOLS.map((tool) => tool.id))
registerWorkspaceTools(() => WORKSPACE_TOOLS)
registerNanovmTools(() => NANOVM_TOOLS)
registerWebvmTools(() => WEBVM_TOOLS)
registerUnkernelTools(() => UNKERNEL_TOOLS)

/**
 * 浏览器工具的开关状态。
 *
 * 主开关关闭时一个工具都不下发；主开关打开后按每个工具自己的开关过滤。
 * 只存本机 localStorage，和 API Key 分开保存。
 */

const ENABLED_KEY = 'chat-demo:agent-tools-enabled'
const FLAGS_KEY = 'chat-demo:agent-tool-flags'

type Flags = Record<string, boolean>

const readFlags = (): Flags => {
  try {
    const raw = localStorage.getItem(FLAGS_KEY)
    if (!raw) {
      return {}
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return {}
    }
    const flags: Flags = {}
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (allAgentTools().some((tool) => tool.id === id)) {
        flags[id] = value === true
      }
    }
    return flags
  } catch {
    return {}
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    // 隐私模式下写不进去也不影响本次会话
  }
}

type AgentToolsState = {
  /** 主开关：关闭后所有浏览器工具都不下发 */
  enabled: boolean
  /** 单个工具开关；缺省视为开启 */
  flags: Flags
}

export const useAgentTools = create<AgentToolsState>(() => ({
  enabled: localStorage.getItem(ENABLED_KEY) === 'true',
  flags: readFlags(),
}))

export const setAgentToolsEnabled = (enabled: boolean) => {
  write(ENABLED_KEY, String(enabled))
  useAgentTools.setState({ enabled })
}

export const setAgentToolEnabled = (id: string, enabled: boolean) => {
  const flags = { ...useAgentTools.getState().flags, [id]: enabled }
  write(FLAGS_KEY, JSON.stringify(flags))
  useAgentTools.setState({ flags })
}

/**
 * 单个工具是否开启：没单独设置过就跟随主开关。
 * 工作区工具还额外要求工作区开关打开——工作区默认关闭。
 */
export const isAgentToolEnabled = (id: string): boolean => {
  const state = useAgentTools.getState()
  if (!state.enabled) {
    return false
  }
  if (WORKSPACE_IDS.has(id) && !isWorkspaceEnabled()) {
    return false
  }
  // NanoVM Slim 还要求总开关与「允许模型调用 Shell」都打开
  if (NANOVM_IDS.has(id) && !nanoVMAgentAvailable()) {
    return false
  }
  // WebVM 有独立的启用 / 允许模型调用开关
  if (WEBVM_IDS.has(id) && !webVMAgentAvailable()) {
    return false
  }
  // Unkernel 有独立的启用 / 允许模型操作开关
  if (UNKERNEL_IDS.has(id) && !unkernelAgentAvailable()) {
    return false
  }
  return state.flags[id] !== false
}

/** 工具属于设置页的哪一组：浏览器 / 工作区 / NanoVM */
export const agentToolGroup = (id: string): ToolGroup =>
  NANOVM_IDS.has(id) || WEBVM_IDS.has(id) || UNKERNEL_IDS.has(id)
    ? 'nanovm'
    : WORKSPACE_IDS.has(id)
      ? 'workspace'
      : 'browser'

/**
 * 当前聊天模式是否允许该工具（模式只是多加一道限制，不越过开关）。
 * 提示词注入工具不执行任何动作、只是一种输出通道，因此不受模式分组限制，
 * 仅聊天模式下也能把正文写成工具参数。
 */
export const modeAllowsTool = (id: string): boolean =>
  id === CUSTOM_INJECTION_TOOL_ID || modeAllowsGroup(agentToolGroup(id))

/** 当前实际会下发给模型的工具：开关打开 + 聊天模式允许 */
export const enabledAgentTools = (): AgentTool[] =>
  allAgentTools().filter((tool) => isAgentToolEnabled(tool.id) && modeAllowsTool(tool.id))

/** 工作区工具是否至少有一项可用，设置页用来提示 */
export const workspaceToolsAvailable = (): boolean =>
  isWorkspaceEnabled() && WORKSPACE_TOOLS.some((tool) => isAgentToolEnabled(tool.id))

/** 全部打开 / 全部关闭，设置页的快捷按钮用 */
export const setAllAgentTools = (enabled: boolean) => {
  const flags: Flags = {}
  for (const tool of allAgentTools()) {
    flags[tool.id] = enabled
  }
  write(FLAGS_KEY, JSON.stringify(flags))
  useAgentTools.setState({ flags })
}

/** 恢复默认：关闭主开关并把每个工具恢复为开启 */
export const resetAgentTools = () => {
  write(ENABLED_KEY, 'false')
  write(FLAGS_KEY, '{}')
  useAgentTools.setState({ enabled: false, flags: {} })
}
