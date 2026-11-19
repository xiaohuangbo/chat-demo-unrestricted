import type { Applet } from '../types.js'
import { EXTRAS_DATA_APPLETS } from './extras-data.js'
import { EXTRAS_DEV_APPLETS } from './extras-dev.js'
import { EXTRAS_JQ_APPLETS } from './extras-jq.js'
import { EXTRAS_TEXT_APPLETS } from './extras-text.js'

/**
 * 补充命令集的汇总入口。
 *
 * 拆成四个文件是为了让「字节 / 文本处理」「数据 / 路径工具」「jq 子集」
 * 「开发者工具」各管一块，注册只在这里做一次：index.ts 只认 EXTRAS_APPLETS。
 */
export const EXTRAS_APPLETS: Applet[] = [
  ...EXTRAS_TEXT_APPLETS,
  ...EXTRAS_DATA_APPLETS,
  ...EXTRAS_JQ_APPLETS,
  ...EXTRAS_DEV_APPLETS,
]
