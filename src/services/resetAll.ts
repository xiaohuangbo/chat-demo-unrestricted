import { resetSettings } from './settings.js'
import { resetPromptPresets } from './promptPresets.js'
import { resetLocalModelSettings } from './local/store.js'
import { disposeEngine } from './local/engine.js'
import { resetNanoVMConfig } from './nanovm/config.js'
import { resetWebVMConfig } from './webvm/config.js'
import { resetUnkernelConfig } from './unkernel/config.js'
import { signOutAccount } from './account/session.js'

/**
 * 「恢复默认设置」的联动入口：一处调用，所有带默认值的 store 一起回默认。
 *
 * 之前只在设置弹窗里调了 `resetSettings()` 与提示词预设、本地模型偏好，
 * NanoVM / WebVM / Unkernel 的参数与账号登录态会留在原样，看起来像「没恢复干净」。
 *
 * 只重置**设置**：
 * - 保留：API Key（凭据）、所有对话与附件、工作区文件、记忆库节点、统计数据；
 * - 重置：设置项本身、提示词预设、本地模型偏好与显存里的模型、
 *   NanoVM / WebVM / Unkernel 启动参数、账号登录态（退出登录，Key 保留）。
 *
 * Unkernel 的数据盘大小是有意保留的（磁盘只增不减，回到 8 GiB 会让页面拒绝已扩容的盘），
 * 这一点 `resetUnkernelConfig()` 自己处理。
 */
export const resetAllSettings = () => {
  resetSettings()
  resetPromptPresets()
  resetLocalModelSettings()
  resetNanoVMConfig()
  resetWebVMConfig()
  resetUnkernelConfig()
  signOutAccount()
  // 本地模型回默认后把显存里的引擎也卸载，避免旧配置的模型继续驻留
  void disposeEngine()
}
