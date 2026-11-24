import { create } from 'zustand'

/** 主界面「文档」页：与实验台一样占满聊天区，关闭后回到原会话 */
export const useDocs = create<{ open: boolean }>(() => ({ open: false }))

export const openDocs = () => useDocs.setState({ open: true })

export const closeDocs = () => useDocs.setState({ open: false })

export const toggleDocs = () => useDocs.setState((state) => ({ open: !state.open }))
