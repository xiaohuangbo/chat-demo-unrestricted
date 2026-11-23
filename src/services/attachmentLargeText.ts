/**
 * 大文本附件：超过 32768 token 的纯文本文件，服务端按文档解析时容易让整轮请求超过上下文上限
 * （`maximum context length is 1048576 tokens`）。两种处理都在浏览器本地完成：
 *
 * - 拆分（默认）：按行切成多个不超过 32768 token 的小文件，各自上传、一起发送；
 * - 实验性 1M 上下文：不拆分也不上传，发送时把正文直接拼进本轮提问，占用模型的 1M 上下文。
 *
 * 所有判断都基于粗估 token（中文 1 字 1 token、其余 4 字符 1 token），与会话统计同一口径；
 * 全角标点也按 1 token 计，宁可早一点分片，也不要让整片贴近上限。
 */

/** 触发处理的单文件 token 阈值 */
export const LARGE_TEXT_TOKEN_LIMIT = 32_768

/** 实验性模式的硬上限：V4.1 Flash / V4 Pro 的上下文窗口都是 1M */
export const INLINE_CONTEXT_TOKEN_LIMIT = 1_048_576

/** 每个分片留出的头部余量（分片说明文字与换行） */
const CHUNK_HEADROOM_TOKENS = 1_024

/** 纯文本类附件；二进制格式（PDF、Word、PPT、图片等）不参与拆分 */
const TEXT_ATTACHMENT_EXTS = new Set([
  'txt',
  'text',
  'md',
  'markdown',
  'rst',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'ndjson',
  'yaml',
  'yml',
  'toml',
  'ini',
  'conf',
  'cfg',
  'env',
  'log',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'less',
  'js',
  'mjs',
  'cjs',
  'ts',
  'tsx',
  'jsx',
  'vue',
  'svelte',
  'py',
  'rb',
  'php',
  'go',
  'rs',
  'java',
  'kt',
  'kts',
  'swift',
  'c',
  'h',
  'cc',
  'cpp',
  'hpp',
  'cs',
  'm',
  'mm',
  'sh',
  'bash',
  'zsh',
  'fish',
  'ps1',
  'bat',
  'cmd',
  'sql',
  'tex',
  'srt',
  'vtt',
  'ass',
  'diff',
  'patch',
  'rtf',
  'lua',
  'pl',
  'r',
  'dart',
  'scala',
  'gradle',
  'properties',
  'gitignore',
  'dockerfile',
  'makefile',
])

const extOf = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** 是否是纯文本类附件 */
export const isTextAttachmentName = (name: string): boolean => {
  const base = name.slice(name.lastIndexOf('/') + 1).toLowerCase()
  if (base === 'dockerfile' || base === 'makefile') {
    return true
  }
  return TEXT_ATTACHMENT_EXTS.has(extOf(name))
}

/** 粗估 token（不取整）：中文 1 字 1 token，其余 4 字符 1 token */
export const textTokenWeight = (text: string): number => {
  let tokens = 0
  for (const char of text) {
    tokens += /[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/.test(char) ? 1 : 0.25
  }
  return tokens
}

/** 读取文本附件：去掉 NUL、统一换行，避免把控制字符塞进分片或 prompt */
export const readAttachmentText = async (blob: Blob): Promise<string> =>
  (await blob.text()).split('\u0000').join('').replace(/\r\n?/g, '\n')

/** 分片文件名：big.txt → big.part1.txt、big.part2.txt */
export const splitPartName = (name: string, index: number): string => {
  const dot = name.lastIndexOf('.')
  const base = dot > 0 ? name.slice(0, dot) : name
  const ext = dot > 0 ? name.slice(dot) : '.txt'
  return `${base}.part${index}${ext}`
}

/** 超长单行没有可用的换行边界，按字符硬切 */
const hardSplitLine = (line: string, limit: number): string[] => {
  const chars = [...line]
  const parts: string[] = []
  let start = 0
  while (start < chars.length) {
    let low = start + 1
    let high = chars.length
    let end = Math.min(chars.length, start + 1)
    while (low <= high) {
      const mid = (low + high) >> 1
      if (textTokenWeight(chars.slice(start, mid).join('')) <= limit) {
        end = mid
        low = mid + 1
      } else {
        high = mid - 1
      }
    }
    parts.push(chars.slice(start, end).join(''))
    start = end
  }
  return parts
}

/**
 * 把文本按行切成分片：尽量在换行处断开，单个分片不超过 limit - 余量；
 * 每个分片带一行说明，便于模型把多个附件认成同一份文件。
 */
export const splitTextAttachment = (
  name: string,
  text: string,
  limit = LARGE_TEXT_TOKEN_LIMIT
): File[] => {
  const target = Math.max(1_024, limit - CHUNK_HEADROOM_TOKENS)
  const lines = text.split(/(?<=\n)/)
  const chunks: string[] = []
  let current: string[] = []
  let tokens = 0
  const flush = () => {
    if (current.length > 0) {
      chunks.push(current.join(''))
      current = []
      tokens = 0
    }
  }
  for (const line of lines) {
    if (line === '') {
      continue
    }
    const lineTokens = textTokenWeight(line)
    if (lineTokens > target) {
      flush()
      for (const piece of hardSplitLine(line, target)) {
        chunks.push(piece)
      }
      continue
    }
    if (tokens + lineTokens > target) {
      flush()
    }
    current.push(line)
    tokens += lineTokens
  }
  flush()
  if (chunks.length === 0) {
    return []
  }
  return chunks.map((chunk, index) => {
    const header = `【附件分片 ${index + 1}/${chunks.length}：${name}】\n`
    return new File([header, chunk], splitPartName(name, index + 1), { type: 'text/plain' })
  })
}

/** 实验性模式里拼进提问的正文；附件名用于让模型知道这段文字是哪份文件 */
export const inlineAttachmentText = (name: string, text: string): string =>
  `【附件：${name}（已直接放入上下文）】\n${text}`
