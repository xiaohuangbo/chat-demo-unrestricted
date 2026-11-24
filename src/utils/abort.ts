/** 老浏览器没有 AbortSignal.reason / throwIfAborted，统一在这里兜底 */

export const getAbortReason = (signal: AbortSignal): unknown =>
  'reason' in signal ? signal.reason : new DOMException('The operation was aborted.', 'AbortError')

export const throwIfAborted = (signal?: AbortSignal): void => {
  if (signal?.aborted) {
    throw getAbortReason(signal)
  }
}
