import { ApiError, API_ORIGIN, request } from './client.js'

/** DeepSeek 账户余额；与聊天接口共用 API Key，查询不产生 token 费用。 */

export type BalanceEntry = {
  currency: string
  total_balance: string
  granted_balance: string
  topped_up_balance: string
}

export type AccountBalance = { is_available: boolean; balance_infos: BalanceEntry[] }

const isBalanceEntry = (value: unknown): value is BalanceEntry => {
  const fields = ['currency', 'total_balance', 'granted_balance', 'topped_up_balance']
  return (
    typeof value === 'object' &&
    value !== null &&
    fields.every((field) => typeof (value as Record<string, unknown>)[field] === 'string')
  )
}

export const fetchBalance = async (
  apiKey: string,
  signal: AbortSignal
): Promise<AccountBalance> => {
  const response = await request(`${API_ORIGIN}/user/balance`, {
    headers: { Authorization: `Bearer ${apiKey}` },
    cache: 'no-store',
    signal,
  })
  const data: unknown = await response.json()
  if (
    typeof data !== 'object' ||
    data === null ||
    !('is_available' in data) ||
    typeof data.is_available !== 'boolean' ||
    !('balance_infos' in data) ||
    !Array.isArray(data.balance_infos) ||
    !data.balance_infos.every(isBalanceEntry)
  ) {
    throw new ApiError('protocol', 'Invalid account balance response')
  }
  return { is_available: data.is_available, balance_infos: data.balance_infos }
}
