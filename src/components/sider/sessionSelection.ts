import { create } from 'zustand'

/**
 * 会话多选：进入多选后左侧列表变成勾选状态，底部出现「置顶 / 删除」操作条。
 * 桌面侧边栏与移动端抽屉是两个 Sider 实例，所以状态放在模块级的 store 里，
 * 两边看到同一份选择；退出设置、切换会话都不影响它，只有关闭多选或删除后清空。
 */
type SessionSelection = {
  active: boolean
  ids: string[]
}

export const useSessionSelection = create<SessionSelection>(() => ({ active: false, ids: [] }))

const clear = () => useSessionSelection.setState({ active: false, ids: [] })

/** 进入多选；带 id 时把这个会话一起选中（从行的「多选」菜单进来） */
export const startSelecting = (id?: string) =>
  useSessionSelection.setState({ active: true, ids: id ? [id] : [] })

export const exitSelecting = clear

export const toggleSelected = (id: string) =>
  useSessionSelection.setState((state) => {
    if (!state.active) {
      return { active: true, ids: [id] }
    }
    const ids = state.ids.includes(id)
      ? state.ids.filter((item) => item !== id)
      : [...state.ids, id]
    return { active: true, ids }
  })

/** 全选 / 取消全选：ids 为当前列表里的会话 */
export const setSelected = (ids: string[]) =>
  useSessionSelection.setState({ active: true, ids: [...new Set(ids)] })

/** 删除或列表变化后，丢掉已经不存在的选择；全空时自动退出多选 */
export const pruneSelected = (available: string[]) => {
  const set = new Set(available)
  useSessionSelection.setState((state) => {
    if (!state.active) {
      return state
    }
    const ids = state.ids.filter((id) => set.has(id))
    if (ids.length === state.ids.length) {
      return state
    }
    return ids.length ? { active: true, ids } : { active: false, ids: [] }
  })
}
