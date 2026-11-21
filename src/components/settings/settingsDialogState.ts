import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'

/** 设置弹窗的分组：通用 / 模型 / 角色 / 本地模型 / 破甲 / 思维链 / 搜索投毒 / 记忆 / 附件（含附件投毒）/ 浏览器工具 / 工作区 / NanoVM Slim / 统计 / 账户与用量 / 数据管理 / 关于 / 更新日志 */
export type SettingsSection =
  | 'general'
  | 'model'
  | 'roles'
  | 'local'
  | 'prompt'
  | 'cot'
  | 'poison'
  | 'memory'
  | 'attachments'
  | 'agentTools'
  | 'workspace'
  | 'nanovm'
  | 'stats'
  | 'account'
  | 'data'
  | 'about'
  | 'changelog'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为当前分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => useSettingsDialog.setState({ open: false })

/** 弹窗内跳转分组（账户卡片跳统计、角色选择跳角色页） */
export const setSettingsSection = (section: SettingsSection) =>
  useSettingsDialog.setState({ section })

/** 没有 API Key 时打开设置并选中 API Key 所在的「数据管理」，返回是否已有 Key */
export const ensureApiKey = () => {
  if (useSettings.getState().apiKey) {
    return true
  }
  openSettings('data')
  return false
}
