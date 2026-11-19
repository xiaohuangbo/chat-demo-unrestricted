import type { Applet, AppletContext, AppletResult } from '../types.js'
import { CORE_APPLETS } from './core.js'
import { TEXT_APPLETS } from './text.js'
import { ARCHIVE_APPLETS } from './archive.js'
import { NET_APPLETS } from './net.js'
import { EXTRAS_APPLETS } from './extras.js'
import { WEB_APPLETS } from './web.js'
import { TOOLCHAIN_APPLETS } from './toolchain.js'

/**
 * busybox 程序表。
 *
 * 每个应用集文件只负责自己那组命令，这里合并成一张表并补上两个自带命令：
 * `help`（看用法）与 `busybox`（多路复用，`busybox ls -l` 等价 `ls -l`）。
 */

const groups: Applet[][] = [
  CORE_APPLETS,
  TEXT_APPLETS,
  ARCHIVE_APPLETS,
  NET_APPLETS,
  EXTRAS_APPLETS,
  WEB_APPLETS,
  TOOLCHAIN_APPLETS,
]

const helpApplet: Applet = {
  name: 'help',
  summary: '列出内置命令，或查看某个命令的用法',
  summaryEn: 'List built-in commands or show usage for one command',
  usage: 'help [command]',
  run: (context: AppletContext): AppletResult => {
    const name = context.argv[1]
    if (name) {
      const applet = APPLET_MAP.get(name)
      if (!applet) {
        return { code: 1, stderr: `help: no help topics match '${name}'\n` }
      }
      return {
        code: 0,
        stdout: `${applet.name} — ${applet.summary}\n\n用法: ${applet.usage}\n`,
      }
    }
    const lines = ['NanoVM Slim 内置命令（busybox 风格）：', '']
    const width = Math.max(...APPLET_LIST.map((applet) => applet.name.length))
    for (const applet of [...APPLET_LIST].sort((left, right) =>
      left.name.localeCompare(right.name)
    )) {
      lines.push(`  ${applet.name.padEnd(width)}  ${applet.summary}`)
    }
    lines.push('', `共 ${APPLET_LIST.length} 个命令。输入 help <command> 查看具体用法。`)
    return { code: 0, stdout: `${lines.join('\n')}\n` }
  },
}

const busyboxApplet: Applet = {
  name: 'busybox',
  summary: '多路复用：busybox <命令> 等价直接执行该命令',
  summaryEn: 'Multiplexer: busybox <command> runs the built-in command',
  usage: 'busybox [--list] [command [args...]]',
  run: (context: AppletContext): AppletResult | Promise<AppletResult> => {
    const args = context.argv.slice(1)
    if (args.length === 0 || args[0] === '--list' || args[0] === '-l') {
      const names = [...APPLET_LIST.map((applet) => applet.name)].sort()
      return { code: 0, stdout: `${names.join('\n')}\n` }
    }
    if (args[0] === '--help' || args[0] === '-h') {
      return { code: 0, stdout: `${busyboxApplet.usage}\n` }
    }
    const applet = APPLET_MAP.get(args[0])
    if (!applet) {
      return { code: 127, stderr: `busybox: applet not found: ${args[0]}\n` }
    }
    return applet.run({ ...context, argv: args })
  },
}

const merged = new Map<string, Applet>()
for (const applet of [...groups.flat(), helpApplet, busyboxApplet]) {
  if (!merged.has(applet.name)) {
    merged.set(applet.name, applet)
  }
}

/** 按名称索引的内置命令表 */
export const APPLET_MAP: ReadonlyMap<string, Applet> = merged

/** 注册顺序的内置命令表 */
export const APPLET_LIST: Applet[] = [...merged.values()]

/** 按名字取命令 */
export const appletByName = (name: string): Applet | undefined => merged.get(name)

/** 命令名列表，用于补全与 `which` 提示 */
export const APPLET_NAMES: string[] = APPLET_LIST.map((applet) => applet.name)
