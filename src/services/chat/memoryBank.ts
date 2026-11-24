import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { translate } from '../../i18n/index.js'

/**
 * 网状记忆库（参考 Operit 的 Memory / MemoryLink / 向量检索）：
 * - 每个节点有标题、正文、标签、重要度、可信度；
 * - 节点之间用带权重的边连接，新增节点时按向量相似度自动连边；
 * - 检索同时考虑关键词、标签、向量与边扩散，并输出调试明细。
 * 向量在本地用确定性哈希生成，维度可配置，不依赖远端 embedding 服务。
 */

const STORAGE_KEY = 'chat-demo:memory-bank'
const MAX_NODES = 500
const MAX_EDGES = 2000

export type MemoryNode = {
  id: string
  title: string
  content: string
  tags: string[]
  importance: number
  credibility: number
  source: 'manual' | 'saved'
  savedMemoryId?: string
  createdAt: number
  updatedAt: number
  lastAccessedAt: number
}

export type MemoryEdge = {
  id: string
  sourceId: string
  targetId: string
  type: string
  weight: number
  description: string
}

export type MemorySearchConfig = {
  dimension: number
  limit: number
  threshold: number
  keywordWeight: number
  tagWeight: number
  vectorWeight: number
  edgeWeight: number
  /** 共享标签自动连边 + 检索时按标签做图扩展（设置里的开关） */
  tagExpansion?: boolean
}

export type MemorySearchCandidate = {
  nodeId: string
  title: string
  keyword: number
  tag: number
  vector: number
  edge: number
  total: number
  passed: boolean
}

export type MemorySearchDebug = {
  query: string
  tokens: string[]
  config: MemorySearchConfig
  nodes: number
  edges: number
  keywordMatches: number
  tagMatches: number
  vectorMatches: number
  edgesTraversed: number
  /** 按共享标签动态扩展到的邻居数（仅开关开启时统计） */
  tagExpanded: number
  candidates: MemorySearchCandidate[]
  results: MemoryNode[]
}

type MemoryBankState = { nodes: MemoryNode[]; edges: MemoryEdge[] }

export type MemorySearchSnapshot = {
  at: number
  query: string
  dimension: number
  nodes: number
  edges: number
  passed: number
  topScore: number
}

/** 聊天栏统计用：最近一次实际注入前的记忆检索结果（不持久化） */
export const useMemorySearchStats = create<{ last: MemorySearchSnapshot | null }>(() => ({
  last: null,
}))

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'what',
  'when',
  'where',
  'which',
  'have',
  'has',
  'are',
  'was',
  'were',
  'you',
  'your',
  'about',
  'into',
  'can',
  'how',
  'why',
  '什么',
  '怎么',
  '为什么',
  '可以',
  '请问',
  '一下',
  '我们',
  '你们',
  '他们',
  '这个',
  '那个',
  '这些',
  '那些',
  '刚才',
  '之前',
  '以前',
  '今天',
  '现在',
  '的',
  '了',
  '吗',
  '呢',
  '吧',
  '啊',
  '我',
  '你',
  '他',
  '她',
  '它',
  '是',
  '在',
  '有',
  '和',
  '就',
  '都',
  '还',
  '要',
  '会',
  '能',
])

/** 汉字区段：基本区、扩展 A、兼容区；日文假名等其它文字走通用词切分 */
const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g

/**
 * 通用词切分：拉丁、西里尔、希腊、阿拉伯、天城文等所有 Unicode 文字都按词保留。
 * 用 \p{L} / \p{N} 而不是 [a-z0-9]，否则俄语、希腊语等非拉丁文字会被整段丢掉
 * （2.7.10 的检索对这些语言一直命中 0 个查询词）。
 */
const WORD_RUN = /[\p{L}\p{N}]+(?:[_.'’-][\p{L}\p{N}]+)*/gu

/**
 * 多语言分词：
 * - 汉字按单字 + 二元词组，保持中文检索的召回；
 * - 其它文字（含俄语、希腊语、阿拉伯语、天城文等）按 Unicode 词切分；
 * - 统一 NFKC 归一化并转小写，全角与半角、连字等写法不因输入法差异而失配。
 */
export const tokenizeMemory = (text: string): string[] => {
  const tokens = new Set<string>()
  const lower = text.normalize('NFKC').toLowerCase()
  const runs = lower.match(CJK_RUN)
  if (runs) {
    for (const run of runs) {
      for (let i = 0; i < run.length; i++) {
        const ch = run[i]
        if (!STOP_WORDS.has(ch)) {
          tokens.add(ch)
        }
        if (i + 1 < run.length) {
          const bigram = run.slice(i, i + 2)
          if (!STOP_WORDS.has(bigram)) {
            tokens.add(bigram)
          }
        }
      }
    }
  }
  // 去掉汉字区段后再按词切分，避免同一个字被两种规则重复计入
  const words = lower.replace(CJK_RUN, ' ').match(WORD_RUN)
  if (words) {
    for (const raw of words) {
      const word = raw.replace(/^[_.'’-]+|[_.'’-]+$/g, '')
      if (word.length >= 2 && !STOP_WORDS.has(word)) {
        tokens.add(word)
      }
    }
  }
  return [...tokens]
}

const hashToken = (token: string): number => {
  let hash = 2166136261
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

/** 确定性哈希向量，L2 归一化；维度变化时重新计算即可 */
export const embedText = (text: string, dimension: number): number[] => {
  const size = Math.max(8, Math.floor(dimension))
  const vector = new Array<number>(size).fill(0)
  for (const token of tokenizeMemory(text)) {
    const hash = hashToken(token)
    const index = hash % size
    const sign = hash & 1 ? 1 : -1
    vector[index] += sign * (token.length >= 2 ? 1.6 : 0.8)
  }
  let norm = 0
  for (const value of vector) {
    norm += value * value
  }
  if (norm > 0) {
    const scale = 1 / Math.sqrt(norm)
    for (let i = 0; i < vector.length; i++) {
      vector[i] *= scale
    }
  }
  return vector
}

const cosine = (a: number[], b: number[]): number => {
  const size = Math.min(a.length, b.length)
  let dot = 0
  for (let i = 0; i < size; i++) {
    dot += a[i] * b[i]
  }
  return dot
}

const read = (): MemoryBankState => {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) {
      return { nodes: [], edges: [] }
    }
    const parsed = JSON.parse(raw) as Partial<MemoryBankState>
    const nodes = Array.isArray(parsed.nodes)
      ? parsed.nodes.filter(
          (node): node is MemoryNode =>
            typeof node === 'object' &&
            node !== null &&
            typeof (node as MemoryNode).id === 'string' &&
            typeof (node as MemoryNode).title === 'string' &&
            typeof (node as MemoryNode).content === 'string'
        )
      : []
    const edges = Array.isArray(parsed.edges)
      ? parsed.edges.filter(
          (edge): edge is MemoryEdge =>
            typeof edge === 'object' &&
            edge !== null &&
            typeof (edge as MemoryEdge).sourceId === 'string' &&
            typeof (edge as MemoryEdge).targetId === 'string'
        )
      : []
    return { nodes, edges }
  } catch {
    return { nodes: [], edges: [] }
  }
}

const write = (state: MemoryBankState) => {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  } catch {
    // 存储不可用时只保留内存状态
  }
}

export const useMemoryBank = create<MemoryBankState>(() => read())

const commit = (state: MemoryBankState) => {
  const nodes = state.nodes.slice(0, MAX_NODES)
  const ids = new Set(nodes.map((node) => node.id))
  const edges = state.edges
    .filter((edge) => ids.has(edge.sourceId) && ids.has(edge.targetId))
    .slice(0, MAX_EDGES)
  const next = { nodes, edges }
  write(next)
  useMemoryBank.setState(next)
}

const makeNode = (
  input: {
    title?: string
    content: string
    tags?: string[]
    importance?: number
    credibility?: number
  },
  source: MemoryNode['source'],
  savedMemoryId?: string
): MemoryNode => {
  const content = input.content.trim()
  const title = (input.title ?? content.slice(0, 40)).trim() || content.slice(0, 40)
  const now = Date.now()
  return {
    id: createId(),
    title,
    content,
    tags: (input.tags ?? [])
      .map((tag) => tag.trim())
      .filter(Boolean)
      .slice(0, 8),
    importance: Math.min(1, Math.max(0, input.importance ?? 0.5)),
    credibility: Math.min(1, Math.max(0, input.credibility ?? 0.7)),
    source,
    ...(savedMemoryId ? { savedMemoryId } : {}),
    createdAt: now,
    updatedAt: now,
    lastAccessedAt: now,
  }
}

/** 新节点按向量相似度自动连边，形成网状记忆 */
const autoLink = (
  node: MemoryNode,
  nodes: MemoryNode[],
  edges: MemoryEdge[],
  dimension: number
) => {
  const sourceVector = embedText(`${node.title}\n${node.content}`, dimension)
  const scored = nodes
    .filter((item) => item.id !== node.id)
    .map((item) => ({
      item,
      score: cosine(sourceVector, embedText(`${item.title}\n${item.content}`, dimension)),
    }))
    .filter((entry) => entry.score > 0.2)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
  const added: MemoryEdge[] = []
  for (const { item, score } of scored) {
    const duplicate = edges.some(
      (edge) =>
        (edge.sourceId === node.id && edge.targetId === item.id) ||
        (edge.sourceId === item.id && edge.targetId === node.id)
    )
    if (duplicate) {
      continue
    }
    added.push({
      id: createId(),
      sourceId: node.id,
      targetId: item.id,
      type: 'related',
      weight: Math.min(1, Math.max(0.05, score)),
      description: '向量相似自动关联',
    })
  }
  return [...edges, ...added]
}

/** 标签归一化：去空白、NFKC、小写；「Moscow」「москва」各自按原样比较 */
const normalizeTag = (tag: string): string => tag.normalize('NFKC').trim().toLowerCase()

/** 两个节点的标签相似度：共享标签越多权重越高，最多 0.9 */
const sharedTagWeight = (left: MemoryNode, right: MemoryNode): number => {
  const leftTags = new Set(left.tags.map(normalizeTag).filter(Boolean))
  const rightTags = new Set(right.tags.map(normalizeTag).filter(Boolean))
  if (leftTags.size === 0 || rightTags.size === 0) {
    return 0
  }
  let shared = 0
  for (const tag of leftTags) {
    if (rightTags.has(tag)) {
      shared += 1
    }
  }
  if (shared === 0) {
    return 0
  }
  return Math.min(0.9, 0.2 + (shared / Math.max(leftTags.size, rightTags.size)) * 0.6)
}

/**
 * 共享标签自动连边：每个节点最多连 3 条，避免同一个标签簇把边数撑爆。
 * 只在设置里开启「标签关联与图扩展」时调用。
 */
const autoLinkByTags = (
  node: MemoryNode,
  nodes: MemoryNode[],
  edges: MemoryEdge[]
): MemoryEdge[] => {
  const scored = nodes
    .filter((item) => item.id !== node.id)
    .map((item) => ({ item, weight: sharedTagWeight(node, item) }))
    .filter((entry) => entry.weight > 0)
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
  const added: MemoryEdge[] = []
  for (const { item, weight } of scored) {
    const duplicate = edges.some(
      (edge) =>
        (edge.sourceId === node.id && edge.targetId === item.id) ||
        (edge.sourceId === item.id && edge.targetId === node.id)
    )
    if (duplicate) {
      continue
    }
    added.push({
      id: createId(),
      sourceId: node.id,
      targetId: item.id,
      type: 'tag',
      weight,
      description: '共享标签自动关联',
    })
  }
  return [...edges, ...added]
}

/** 开关打开时回填：为已有节点按共享标签补边（每个节点最多 3 条，受 MAX_EDGES 限制） */
export const linkMemoryBankByTags = (): void => {
  const { nodes, edges } = useMemoryBank.getState()
  let next = edges
  for (const node of nodes) {
    next = autoLinkByTags(node, nodes, next)
  }
  if (next.length !== edges.length) {
    commit({ nodes, edges: next })
  }
}

/** 开关关闭时清掉标签边：关系图与检索行为保持一致，重新打开会重新补边 */
export const unlinkMemoryBankByTags = (): void => {
  const { nodes, edges } = useMemoryBank.getState()
  const next = edges.filter((edge) => edge.type !== 'tag')
  if (next.length !== edges.length) {
    commit({ nodes, edges: next })
  }
}

export const addMemoryNode = (
  input: {
    title?: string
    content: string
    tags?: string[]
    importance?: number
    credibility?: number
  },
  dimension = 256,
  tagExpansion = false
): MemoryNode | null => {
  const content = input.content.trim()
  if (!content) {
    return null
  }
  const current = useMemoryBank.getState()
  const duplicate = current.nodes.find((node) => node.content.trim() === content)
  if (duplicate) {
    return duplicate
  }
  const node = makeNode({ ...input, content }, 'manual')
  const linked = autoLink(node, current.nodes, current.edges, dimension)
  const edges = tagExpansion ? autoLinkByTags(node, current.nodes, linked) : linked
  commit({ nodes: [node, ...current.nodes], edges })
  return node
}

/** 长期记忆变更后同步到记忆库；同一条 savedMemoryId 只保留一个节点 */
export const upsertSavedMemoryNode = (
  savedMemoryId: string,
  content: string,
  dimension = 256,
  tagExpansion = false
): void => {
  const text = content.trim()
  if (!text) {
    return
  }
  const current = useMemoryBank.getState()
  const existing = current.nodes.find((node) => node.savedMemoryId === savedMemoryId)
  if (existing) {
    const updated: MemoryNode = {
      ...existing,
      title: text.slice(0, 40),
      content: text,
      updatedAt: Date.now(),
    }
    commit({
      nodes: current.nodes.map((node) => (node.id === existing.id ? updated : node)),
      edges: current.edges,
    })
    return
  }
  const node = makeNode({ content: text }, 'saved', savedMemoryId)
  const linked = autoLink(node, current.nodes, current.edges, dimension)
  const edges = tagExpansion ? autoLinkByTags(node, current.nodes, linked) : linked
  commit({ nodes: [node, ...current.nodes], edges })
}

export const removeSavedMemoryNode = (savedMemoryId: string) => {
  const current = useMemoryBank.getState()
  const target = current.nodes.find((node) => node.savedMemoryId === savedMemoryId)
  if (!target) {
    return
  }
  commit({
    nodes: current.nodes.filter((node) => node.id !== target.id),
    edges: current.edges.filter(
      (edge) => edge.sourceId !== target.id && edge.targetId !== target.id
    ),
  })
}

export const updateMemoryNode = (
  id: string,
  patch: Partial<Pick<MemoryNode, 'title' | 'content' | 'tags' | 'importance' | 'credibility'>>,
  tagExpansion = false
) => {
  const current = useMemoryBank.getState()
  const node = current.nodes.find((item) => item.id === id)
  if (!node) {
    return
  }
  const nodes = current.nodes.map((item) =>
    item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
  )
  if (!tagExpansion) {
    commit({ nodes, edges: current.edges })
    return
  }
  // 标签可能被改过：先摘掉这个节点旧的标签边，再按新标签重新连
  const updated = nodes.find((item) => item.id === id)
  if (!updated) {
    commit({ nodes, edges: current.edges })
    return
  }
  const edges = autoLinkByTags(
    updated,
    nodes,
    current.edges.filter(
      (edge) => edge.type !== 'tag' || (edge.sourceId !== id && edge.targetId !== id)
    )
  )
  commit({ nodes, edges })
}

export const deleteMemoryNode = (id: string) => {
  const current = useMemoryBank.getState()
  commit({
    nodes: current.nodes.filter((node) => node.id !== id),
    edges: current.edges.filter((edge) => edge.sourceId !== id && edge.targetId !== id),
  })
}

export const clearMemoryBank = () => {
  commit({ nodes: [], edges: [] })
}

/** 导入记忆归档时整体替换节点与边 */
export const replaceMemoryBank = (nodes: MemoryNode[], edges: MemoryEdge[]) => {
  commit({ nodes, edges })
}

export type MemoryBankStats = {
  nodes: number
  edges: number
  dimension: number
  avgDegree: number
  vectorBytes: number
}

/** 向量维度使用情况：当前维度、节点数、平均度、Float32 估算占用 */
export const memoryBankStats = (dimension: number): MemoryBankStats => {
  const { nodes, edges } = useMemoryBank.getState()
  const size = Math.max(8, Math.floor(dimension))
  return {
    nodes: nodes.length,
    edges: edges.length,
    dimension: size,
    avgDegree: nodes.length === 0 ? 0 : (edges.length * 2) / nodes.length,
    vectorBytes: nodes.length * size * 4,
  }
}

const tokenOverlapScore = (queryTokens: string[], targetTokens: Set<string>): number => {
  if (queryTokens.length === 0) {
    return 0
  }
  let hit = 0
  let total = 0
  for (const token of queryTokens) {
    const weight = token.length >= 2 ? 1.5 : 0.7
    total += weight
    if (targetTokens.has(token)) {
      hit += weight
    }
  }
  return total > 0 ? hit / total : 0
}

/** 检索记忆库并返回每个候选的分数明细，供设置页「搜索调试」展示 */
export const searchMemoryBank = (query: string, config: MemorySearchConfig): MemorySearchDebug => {
  const state = useMemoryBank.getState()
  const tokens = tokenizeMemory(query)
  const queryVector = embedText(query, config.dimension)
  const base = new Map<string, MemorySearchCandidate>()

  for (const node of state.nodes) {
    const nodeTokens = new Set(tokenizeMemory(`${node.title}\n${node.content}`))
    const tagTokens = new Set(tokenizeMemory(node.tags.join(' ')))
    const keyword = tokenOverlapScore(tokens, nodeTokens)
    const tag = tokenOverlapScore(tokens, tagTokens)
    const vector = Math.max(
      0,
      cosine(queryVector, embedText(`${node.title}\n${node.content}`, config.dimension))
    )
    const total =
      keyword * config.keywordWeight + tag * config.tagWeight + vector * config.vectorWeight
    base.set(node.id, {
      nodeId: node.id,
      title: node.title,
      keyword,
      tag,
      vector,
      edge: 0,
      total,
      passed: false,
    })
  }

  const nodeMap = new Map(state.nodes.map((node) => [node.id, node]))
  const tagExpansion = config.tagExpansion === true
  // 边扩散：高分节点把一部分分数传给相邻节点，最多遍历 8 个种子
  let edgesTraversed = 0
  let tagExpanded = 0
  const seeds = [...base.values()].sort((a, b) => b.total - a.total).slice(0, 8)
  for (const seed of seeds) {
    for (const edge of state.edges) {
      if (edge.sourceId !== seed.nodeId && edge.targetId !== seed.nodeId) {
        continue
      }
      // 标签边只在开关开启时参与；关闭时图扩展只看向量自动连的边
      if (edge.type === 'tag' && !tagExpansion) {
        continue
      }
      const neighborId = edge.sourceId === seed.nodeId ? edge.targetId : edge.sourceId
      const neighbor = base.get(neighborId)
      if (!neighbor) {
        continue
      }
      edgesTraversed += 1
      neighbor.edge = Math.max(neighbor.edge, seed.total * edge.weight)
    }
    // 动态标签扩展：不依赖已存的边，命中节点把分数传给共享标签的节点，
    // 标签是后来补上或从归档导入的节点也能被拉进来。
    if (!tagExpansion || seed.total <= 0) {
      continue
    }
    const seedNode = nodeMap.get(seed.nodeId)
    if (!seedNode) {
      continue
    }
    for (const node of state.nodes) {
      if (node.id === seed.nodeId) {
        continue
      }
      const weight = sharedTagWeight(seedNode, node)
      if (weight === 0) {
        continue
      }
      const neighbor = base.get(node.id)
      if (!neighbor) {
        continue
      }
      const score = seed.total * weight
      if (score > neighbor.edge) {
        neighbor.edge = score
        tagExpanded += 1
      }
    }
  }

  const candidates: MemorySearchCandidate[] = []
  for (const candidate of base.values()) {
    candidate.total =
      candidate.keyword * config.keywordWeight +
      candidate.tag * config.tagWeight +
      candidate.vector * config.vectorWeight +
      candidate.edge * config.edgeWeight
    candidate.passed = candidate.total >= config.threshold
    candidates.push(candidate)
  }
  candidates.sort((a, b) => b.total - a.total)
  const passed = candidates.filter((candidate) => candidate.passed).slice(0, config.limit)
  return {
    query,
    tokens,
    config,
    nodes: state.nodes.length,
    edges: state.edges.length,
    keywordMatches: candidates.filter((candidate) => candidate.keyword > 0).length,
    tagMatches: candidates.filter((candidate) => candidate.tag > 0).length,
    vectorMatches: candidates.filter((candidate) => candidate.vector > 0.05).length,
    edgesTraversed,
    tagExpanded,
    candidates,
    results: passed
      .map((candidate) => nodeMap.get(candidate.nodeId))
      .filter((node): node is MemoryNode => node !== undefined),
  }
}

/** 把检索结果拼成可注入 system 的文本 */
export const formatMemoryBankContext = (query: string, config: MemorySearchConfig): string => {
  if (query.trim() === '') {
    return ''
  }
  const debug = searchMemoryBank(query, config)
  useMemorySearchStats.setState({
    last: {
      at: Date.now(),
      query,
      dimension: config.dimension,
      nodes: debug.nodes,
      edges: debug.edges,
      passed: debug.results.length,
      topScore: debug.candidates[0]?.total ?? 0,
    },
  })
  if (debug.results.length === 0) {
    return ''
  }
  const lines = [translate('memoryBankHeader')]
  let total = lines[0].length
  for (const node of debug.results) {
    const content = node.content.replace(/\s+/g, ' ').trim()
    const line = `- [${node.title}] ${content.length > 500 ? `${content.slice(0, 500)}…` : content}`
    if (total + line.length > 1800) {
      break
    }
    lines.push(line)
    total += line.length + 1
  }
  return lines.length > 1 ? lines.join('\n') : ''
}
