import { WebWorkerMLCEngineHandler } from '@mlc-ai/web-llm'

/**
 * WebLLM 引擎 Worker：推理与权重下载都跑在这里，主线程只负责 UI。
 * 与 mlc-ai/web-llm-chat 的 worker/web-worker.ts 相同的最小实现。
 */
let handler: WebWorkerMLCEngineHandler | undefined

self.onmessage = (event: MessageEvent) => {
  if (!handler) {
    handler = new WebWorkerMLCEngineHandler()
  }
  handler.onmessage(event)
}
