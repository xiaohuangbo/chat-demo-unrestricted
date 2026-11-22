/**
 * unkernel 数据盘的浏览器侧清理。
 *
 * 页面把 ext4 数据盘（/data）存在 IndexedDB 的 `kwdisk:kwdata-v1`，把
 * 挂起会话的快照存在 `kwsnap:session-v2`。重置数据盘必须把两者一起删掉：
 * 快照记录了旧磁盘的内容和写入代次，留着它，下一次启动会尝试恢复一台
 * 和磁盘对不上的机器。
 *
 * 删除前要先卸载 iframe，让页面释放 IndexedDB 连接和 Web Lock；否则
 * deleteDatabase 会一直 blocked。
 */

const DATA_DISK_PREFIX = 'kwdisk:kwdata-'
const SESSION_PREFIX = 'kwsnap:session-'

const deleteDatabase = (name: string) =>
  new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(name)
    let timer: ReturnType<typeof setTimeout> | null = null
    const done = (error?: Error) => {
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }
    request.onsuccess = () => done()
    request.onerror = () => done(request.error ?? new Error(`删除 ${name} 失败`))
    request.onblocked = () => {
      // 另一个标签页还开着时会一直 blocked；先等一会儿（iframe 卸载可能慢），
      // 仍然删不掉再提示用户关闭其他标签页。
      timer = setTimeout(
        () => done(new Error(`${name} 仍被另一个页面占用；请关闭其他打开本应用的标签页后重试`)),
        5000
      )
    }
  })

/** 要清理的数据库：当前和旧格式版本的数据盘，以及所有会话快照。 */
const resetTargets = async (): Promise<string[]> => {
  const names = new Set<string>()
  if (typeof indexedDB.databases === 'function') {
    try {
      for (const database of await indexedDB.databases()) {
        const name = database.name
        if (name && (name.startsWith(DATA_DISK_PREFIX) || name.startsWith(SESSION_PREFIX))) {
          names.add(name)
        }
      }
    } catch {
      // 隐私模式或旧浏览器：退回已知的当前版本名
    }
  }
  if (names.size === 0) {
    names.add('kwdisk:kwdata-v1')
    names.add('kwsnap:session-v2')
  }
  return [...names]
}

/**
 * 删除数据盘和会话快照，返回删掉的数据库名。
 * 调用前先卸载 iframe；下一次启动会从内核里的模板重新创建一个空磁盘。
 */
export const resetUnkernelDataDisk = async (): Promise<string[]> => {
  if (typeof indexedDB === 'undefined') {
    return []
  }
  const names = await resetTargets()
  for (const name of names) {
    await deleteDatabase(name)
  }
  return names
}
