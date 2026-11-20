import { create } from 'zustand'

/** 「我的资料」：昵称与头像，只存在本机；昵称会作为用户称呼注入 system。 */

const NAME_KEY = 'chat-demo:profile-name'
const AVATAR_KEY = 'chat-demo:profile-avatar'
const MAX_NAME = 32

const read = (key: string): string => {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

export const useProfile = create<{ name: string; avatar: string }>(() => ({
  name: read(NAME_KEY) || '我',
  avatar: read(AVATAR_KEY),
}))

export const setProfileName = (name: string) => {
  const value = name.trim().slice(0, MAX_NAME) || '我'
  try {
    localStorage.setItem(NAME_KEY, value)
  } catch {
    // 忽略
  }
  useProfile.setState({ name: value })
}

export const setProfileAvatar = (avatar: string) => {
  try {
    if (avatar) {
      localStorage.setItem(AVATAR_KEY, avatar)
    } else {
      localStorage.removeItem(AVATAR_KEY)
    }
  } catch {
    // 忽略
  }
  useProfile.setState({ avatar })
}

/** 把图片裁成 384×384 的 JPEG data URL；非图片或超过 5MB 时抛错 */
export const readAvatar = async (file: File): Promise<string> => {
  if (
    !['image/png', 'image/jpeg', 'image/webp'].includes(file.type) ||
    file.size > 5 * 1024 * 1024
  ) {
    throw new Error('IMAGE_REQUIRED')
  }
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 384
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('IMAGE_REQUIRED')
    }
    const side = Math.min(bitmap.width, bitmap.height)
    context.drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      384,
      384
    )
    return canvas.toDataURL('image/jpeg', 0.85)
  } finally {
    bitmap.close()
  }
}
