import { useEffect } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { loadEngine, useEngine } from '../../services/nanovm/boot.js'
import { useNanoVMConfig } from '../../services/nanovm/config.js'
import { setActiveVm, setActiveVmOnly, useNanoVM } from '../../services/nanovm/session.js'
import { useWebVMConfig } from '../../services/webvm/config.js'
import { consumePendingWebVmBoot } from '../../services/webvm/coi.js'
import { ShellDock } from './ShellDock.js'
import { ShellSheet } from './ShellSheet.js'

/**
 * 虚拟机面板的挂载点：桌面端右侧停靠、手机端底部面板。
 *
 * 同一块面板里放 NanoVM 与 WebVM 两个终端：切换只改 useNanoVM.activeVm，
 * 两个实例都保留。面板开合由侧栏按钮 toggleNanoVM / toggleWebVM 驱动；
 * 总开关都关掉后整块不渲染。
 */
export const NanoVMHost = () => {
  const open = useNanoVM((state) => state.open)
  const activeVm = useNanoVM((state) => state.activeVm)
  const enabled = useNanoVMConfig((state) => state.enabled)
  const autoLoad = useNanoVMConfig((state) => state.autoLoad)
  const webvmEnabled = useWebVMConfig((state) => state.enabled)
  const isMobile = useIsMobile()
  const engineStatus = useEngine((state) => state.status)

  // 启用跨源隔离后页面会刷新一次：把「自动打开 WebVM」的意图接上
  useEffect(() => {
    if (consumePendingWebVmBoot() && webvmEnabled) {
      setActiveVm('webvm')
    }
  }, [webvmEnabled])

  // 当前虚拟机被关掉时退回另一个；两个都关掉则整块隐藏
  useEffect(() => {
    if (activeVm === 'webvm' && !webvmEnabled && enabled) {
      setActiveVmOnly('nanovm')
    } else if (activeVm === 'nanovm' && !enabled && webvmEnabled) {
      setActiveVmOnly('webvm')
    }
  }, [activeVm, enabled, webvmEnabled])

  // 只有 NanoVM 需要预热 WASM 引擎；WebVM 由终端组件按配置懒启动
  useEffect(() => {
    if (!enabled || !open || activeVm !== 'nanovm' || !autoLoad || engineStatus !== 'idle') {
      return
    }
    // 失败时 boot.ts 会把错误放进 useEngine，面板里显示状态与重试按钮
    void loadEngine()
  }, [activeVm, autoLoad, enabled, engineStatus, open])

  if (!open || (!enabled && !webvmEnabled)) {
    return null
  }
  return isMobile ? <ShellSheet /> : <ShellDock />
}
