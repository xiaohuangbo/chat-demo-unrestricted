import { create } from 'zustand'
import { ApiError } from '../api/client.js'
import { fetchBalance } from '../api/balance.js'
import type { TranslationMessage } from '../../i18n/index.js'
import { setApiKey, useSettings } from '../settings.js'
import { setProfileName, useProfile } from '../profile.js'

/**
 * 「从 DeepSeek 账号登录」：用账号的 API Key 换一个登录态。
 *
 * 为什么是 API Key：DeepSeek 平台的账号 OAuth（`platform.deepseek.com/auth-api/v0/dsh/auth_init`
 * → 浏览器授权 → `auth_exchange`）要求宿主服务接收回调、再由服务端换 token，而且这两个接口都不带
 * CORS 头；纯静态站点既收不到回调也读不到响应（deepseek-harness 正是把它放在 Node 宿主里做的）。
 * 所以这里用同一个账号的 API Key 登录：Key 只发往 `api.deepseek.com` 校验一次余额，
 * 拿到的就是账号级的可用状态与余额，登录态与「我的资料」「账户与用量」联动。
 *
 * 登录态只存派生信息（Key 尾号、余额快照、登录时间），不重复保存 Key 本身。
 */

const KEY = 'chat-demo:account-session'

export type AccountProfile = {
  /** API Key 尾号，用于区分账号，不泄露完整 Key */
  tail: string
  available: boolean
  currency: string
  total: string
  granted: string
  toppedUp: string
}

export type AccountState = {
  status: 'signed-out' | 'signing-in' | 'signed-in'
  profile: AccountProfile | null
  signedInAt: number | null
  /** 登录失败的原因；UI 按 key 翻译 */
  error: TranslationMessage | null
}

const defaults: AccountState = {
  status: 'signed-out',
  profile: null,
  signedInAt: null,
  error: null,
}

const read = (): AccountState => {
  try {
    const raw = localStorage.getItem(KEY)
    if (!raw) {
      return { ...defaults }
    }
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) {
      return { ...defaults }
    }
    const source = parsed as Partial<AccountProfile> & { signedInAt?: unknown }
    if (typeof source.tail !== 'string' || !source.tail) {
      return { ...defaults }
    }
    return {
      status: 'signed-in',
      profile: {
        tail: source.tail,
        available: source.available === true,
        currency: typeof source.currency === 'string' ? source.currency : '',
        total: typeof source.total === 'string' ? source.total : '',
        granted: typeof source.granted === 'string' ? source.granted : '',
        toppedUp: typeof source.toppedUp === 'string' ? source.toppedUp : '',
      },
      signedInAt: typeof source.signedInAt === 'number' ? source.signedInAt : null,
      error: null,
    }
  } catch {
    return { ...defaults }
  }
}

const write = (profile: AccountProfile | null, signedInAt: number | null) => {
  try {
    if (!profile || !signedInAt) {
      localStorage.removeItem(KEY)
      return
    }
    localStorage.setItem(KEY, JSON.stringify({ ...profile, signedInAt }))
  } catch {
    // 隐私模式写不进去也不影响本次会话
  }
}

export const useAccount = create<AccountState>(() => read())

export const accountProfile = () => useAccount.getState().profile

/** Key 尾号：只保留最后 4 位，短 Key 就整段显示 */
export const keyTail = (apiKey: string): string => {
  const trimmed = apiKey.trim()
  return trimmed.length <= 4 ? trimmed : trimmed.slice(-4)
}

const toProfile = (apiKey: string, balance: Awaited<ReturnType<typeof fetchBalance>>): AccountProfile => {
  const info = balance.balance_infos[0]
  return {
    tail: keyTail(apiKey),
    available: balance.is_available,
    currency: info?.currency ?? '',
    total: info?.total_balance ?? '',
    granted: info?.granted_balance ?? '',
    toppedUp: info?.topped_up_balance ?? '',
  }
}

const describe = (reason: unknown): TranslationMessage => {
  if (reason instanceof ApiError) {
    if (reason.status === 401 || reason.status === 403) {
      return { key: 'accountSignInInvalidKey' }
    }
    if (reason.kind === 'network') {
      return { key: 'accountSignInNetwork' }
    }
    if (reason.status === 429) {
      return { key: 'accountSignInRateLimited' }
    }
  }
  return { key: 'accountSignInFailed' }
}

/**
 * 登录：校验 Key 并保存登录态。
 * 成功后如果应用还没有 API Key，顺手把它设为应用 Key（否则沿用原来的）。
 */
export const signInAccount = async (apiKey: string): Promise<boolean> => {
  const key = apiKey.trim()
  if (!key) {
    useAccount.setState({ status: 'signed-out', error: { key: 'accountSignInEmptyKey' } })
    return false
  }
  useAccount.setState({ status: 'signing-in', error: null })
  try {
    const balance = await fetchBalance(key, AbortSignal.timeout(20_000))
    const profile = toProfile(key, balance)
    const signedInAt = Date.now()
    write(profile, signedInAt)
    useAccount.setState({ status: 'signed-in', profile, signedInAt, error: null })
    if (!useSettings.getState().apiKey) {
      setApiKey(key)
    }
    return true
  } catch (reason) {
    useAccount.setState({ status: 'signed-out', profile: null, signedInAt: null, error: describe(reason) })
    return false
  }
}

/** 刷新余额快照：已登录时用当前应用 Key 重新查一次 */
export const refreshAccount = async (): Promise<boolean> => {
  const apiKey = useSettings.getState().apiKey
  if (!apiKey) {
    return false
  }
  try {
    const balance = await fetchBalance(apiKey, AbortSignal.timeout(20_000))
    const profile = toProfile(apiKey, balance)
    const signedInAt = useAccount.getState().signedInAt ?? Date.now()
    write(profile, signedInAt)
    useAccount.setState({ status: 'signed-in', profile, signedInAt, error: null })
    return true
  } catch (reason) {
    useAccount.setState({ error: describe(reason) })
    return false
  }
}

/** 退出登录：只清登录态，API Key 与「我的资料」都保留 */
export const signOutAccount = () => {
  write(null, null)
  useAccount.setState({ ...defaults })
}

/** 账号默认昵称：`DeepSeek · 尾号`，写进「我的资料」用 */
export const accountNickname = (profile: AccountProfile | null = accountProfile()): string =>
  profile ? `DeepSeek · ${profile.tail}` : ''

/** 把账号昵称同步到「我的资料」；已有自定义昵称时也允许覆盖（由用户点按钮触发） */
export const applyAccountNickname = (): boolean => {
  const nickname = accountNickname()
  if (!nickname) {
    return false
  }
  setProfileName(nickname)
  return true
}

/** 资料里显示的名字：优先用「我的资料」的昵称，未登录时为空 */
export const accountHolderName = (): string =>
  useProfile.getState().name.trim() || ''
