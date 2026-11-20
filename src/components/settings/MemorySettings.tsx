import clsx from 'clsx'
import { useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  addSavedMemory,
  clearSavedMemories,
  deleteSavedMemory,
  toggleSavedMemory,
  updateSavedMemory,
  useSavedMemories,
} from '../../services/chat/savedMemory.js'
import {
  addMemoryNode,
  clearMemoryBank,
  deleteMemoryNode,
  searchMemoryBank,
  memoryBankStats,
  useMemoryBank,
  type MemoryEdge,
  type MemoryNode,
  type MemorySearchDebug,
} from '../../services/chat/memoryBank.js'
import {
  applyMemoryArchive,
  buildMemoryArchive,
  parseMemoryArchive,
  type ImportMode,
  type MemoryArchive,
} from '../../services/chat/memoryArchive.js'
import {
  setAutoExtractMemory,
  setMemoryExtractEngine,
  setMemoryBankDimension,
  setMemoryBankEnabled,
  setMemoryBankLimit,
  setMemoryBankThreshold,
  setMemoryBankWeight,
  setSavedMemoryEnabled,
  useSettings,
} from '../../services/settings.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ParamControl } from './ParamControls.js'
import { Select } from '../base/Select.js'
import { Switch } from '../base/Switch.js'
import { Modal } from '../base/Modal.js'
import { IconEditOutline16, IconTrashOutline16 } from '../base/icons.js'
import { showToast } from '../base/toastState.js'
import { isLocalModel } from '../../services/local/catalog.js'
import { lastLocalModelSelection } from '../../services/local/store.js'
import styles from './MemorySettings.module.css'

const DIMENSIONS = [64, 128, 256, 384, 768]

const score = (value: number): string => value.toFixed(2)

/** 简单力导向布局，最多渲染 80 个节点，避免大图卡顿 */
const layoutGraph = (nodes: MemoryNode[], edges: MemoryEdge[]) => {
  const width = 640
  const height = 280
  const visible = nodes.slice(0, 80)
  const positions = new Map<string, { x: number; y: number }>()
  visible.forEach((node, index) => {
    const angle = (index / Math.max(1, visible.length)) * Math.PI * 2
    positions.set(node.id, {
      x: width / 2 + Math.cos(angle) * 200,
      y: height / 2 + Math.sin(angle) * 100,
    })
  })
  const pairs = edges.filter((edge) => positions.has(edge.sourceId) && positions.has(edge.targetId))
  for (let iteration = 0; iteration < 60; iteration += 1) {
    const ids = [...positions.keys()]
    for (let i = 0; i < ids.length; i += 1) {
      for (let j = i + 1; j < ids.length; j += 1) {
        const a = positions.get(ids[i])
        const b = positions.get(ids[j])
        if (!a || !b) {
          continue
        }
        const dx = a.x - b.x
        const dy = a.y - b.y
        const distance = Math.max(8, Math.hypot(dx, dy))
        const force = 6000 / (distance * distance)
        const ux = (dx / distance) * force
        const uy = (dy / distance) * force
        a.x += ux
        a.y += uy
        b.x -= ux
        b.y -= uy
      }
    }
    for (const edge of pairs) {
      const a = positions.get(edge.sourceId)
      const b = positions.get(edge.targetId)
      if (!a || !b) {
        continue
      }
      const dx = b.x - a.x
      const dy = b.y - a.y
      const distance = Math.max(1, Math.hypot(dx, dy))
      const force = (distance - 90) * 0.004 * (0.4 + edge.weight)
      const ux = (dx / distance) * force
      const uy = (dy / distance) * force
      a.x += ux
      a.y += uy
      b.x -= ux
      b.y -= uy
    }
    for (const point of positions.values()) {
      point.x += (width / 2 - point.x) * 0.003
      point.y += (height / 2 - point.y) * 0.003
      point.x = Math.min(width - 24, Math.max(24, point.x))
      point.y = Math.min(height - 24, Math.max(24, point.y))
    }
  }
  return { visible, positions }
}

const formatBytes = (bytes: number): string =>
  bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`

const MemoryGraph = ({
  nodes,
  edges,
  selectedId,
  onSelect,
}: {
  nodes: MemoryNode[]
  edges: MemoryEdge[]
  selectedId: string | null
  onSelect: (id: string | null) => void
}) => {
  const t = useTranslate()
  const { visible, positions } = useMemo(() => layoutGraph(nodes, edges), [nodes, edges])
  const visibleIds = new Set(visible.map((node) => node.id))
  const visibleEdges = edges.filter(
    (edge) => visibleIds.has(edge.sourceId) && visibleIds.has(edge.targetId)
  )
  const degree = new Map<string, number>()
  for (const edge of visibleEdges) {
    degree.set(edge.sourceId, (degree.get(edge.sourceId) ?? 0) + 1)
    degree.set(edge.targetId, (degree.get(edge.targetId) ?? 0) + 1)
  }
  return (
    <div className={styles.graphWrap}>
      <svg
        className={styles.graph}
        viewBox="0 0 640 280"
        role="img"
        aria-label={t('memoryGraphTitle')}
        onClick={() => onSelect(null)}
      >
        {visibleEdges.map((edge) => {
          const a = positions.get(edge.sourceId)
          const b = positions.get(edge.targetId)
          if (!a || !b) {
            return null
          }
          return (
            <line
              key={edge.id}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              stroke="currentColor"
              strokeOpacity={0.2 + edge.weight * 0.5}
              strokeWidth={0.6 + edge.weight * 1.8}
            />
          )
        })}
        {visible.map((node) => {
          const point = positions.get(node.id)
          if (!point) {
            return null
          }
          const selected = node.id === selectedId
          const radius = 5 + node.importance * 3
          const showLabel = selected || (degree.get(node.id) ?? 0) > 0 || visible.length <= 20
          return (
            <g
              key={node.id}
              className={styles.graphNode}
              onClick={(event) => {
                event.stopPropagation()
                onSelect(selected ? null : node.id)
              }}
            >
              <circle
                cx={point.x}
                cy={point.y}
                r={selected ? radius + 3 : radius}
                className={selected ? styles.graphNodeSelected : styles.graphNodeCircle}
              />
              {showLabel ? (
                <text
                  x={point.x}
                  y={point.y - radius - 4}
                  textAnchor="middle"
                  className={styles.graphLabel}
                >
                  {node.title.length > 12 ? `${node.title.slice(0, 12)}…` : node.title}
                </text>
              ) : null}
            </g>
          )
        })}
      </svg>
      {nodes.length > visible.length ? (
        <div className={styles.hint}>
          {t('memoryGraphShowing', { shown: visible.length, total: nodes.length })}
        </div>
      ) : null}
    </div>
  )
}

/** 记忆设置：长期记忆列表 + 网状记忆库（节点 / 连边 / 检索权重 / 搜索调试） */
export const MemorySettings = () => {
  const t = useTranslate()
  const settings = useSettings()
  const items = useSavedMemories((state) => state.items)
  const nodes = useMemoryBank((state) => state.nodes)
  const edges = useMemoryBank((state) => state.edges)

  const [newText, setNewText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editDraft, setEditDraft] = useState('')
  const [nodeTitle, setNodeTitle] = useState('')
  const [nodeContent, setNodeContent] = useState('')
  const [nodeTags, setNodeTags] = useState('')
  const [query, setQuery] = useState('')
  const [debug, setDebug] = useState<MemorySearchDebug | null>(null)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [pendingArchive, setPendingArchive] = useState<MemoryArchive | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const bankUsage = memoryBankStats(settings.memoryBankDimension)
  const selected = nodes.find((node) => node.id === selectedNode) ?? null

  const config = useMemo(
    () => ({
      dimension: settings.memoryBankDimension,
      limit: settings.memoryBankLimit,
      threshold: settings.memoryBankThreshold,
      keywordWeight: settings.memoryBankKeywordWeight,
      tagWeight: settings.memoryBankTagWeight,
      vectorWeight: settings.memoryBankVectorWeight,
      edgeWeight: settings.memoryBankEdgeWeight,
    }),
    [
      settings.memoryBankDimension,
      settings.memoryBankLimit,
      settings.memoryBankThreshold,
      settings.memoryBankKeywordWeight,
      settings.memoryBankTagWeight,
      settings.memoryBankVectorWeight,
      settings.memoryBankEdgeWeight,
    ]
  )

  const handleAdd = () => {
    if (addSavedMemory(newText)) {
      setNewText('')
    }
  }

  const handleAddNode = () => {
    if (
      addMemoryNode(
        {
          title: nodeTitle,
          content: nodeContent,
          tags: nodeTags.split(/[,，]/),
        },
        settings.memoryBankDimension
      )
    ) {
      setNodeTitle('')
      setNodeContent('')
      setNodeTags('')
    }
  }

  const runSearch = () => {
    setDebug(searchMemoryBank(query, config))
  }

  const exportMemories = () => {
    const archive = buildMemoryArchive()
    const blob = new Blob([JSON.stringify(archive, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `memory-archive-${Date.now()}.json`
    link.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  const importMemories = async (file: File) => {
    try {
      const parsed: unknown = JSON.parse(await file.text())
      const archive = parseMemoryArchive(parsed)
      if (!archive) {
        showToast({ key: 'memoryImportInvalid' })
        return
      }
      setPendingArchive(archive)
    } catch {
      showToast({ key: 'memoryImportInvalid' })
    }
  }

  return (
    <div className={styles.memory}>
      <div className={styles.groupTitle}>{t('memorySavedSection')}</div>

      <div className={styles.toggleRow}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memorySavedEnabledLabel')}</div>
          <div className={styles.desc}>{t('memorySavedEnabledDesc')}</div>
        </div>
        <Switch
          checked={settings.savedMemoryEnabled}
          onChange={setSavedMemoryEnabled}
          label={t('memorySavedEnabledLabel')}
        />
      </div>

      <div className={styles.toggleRow}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memoryAutoExtractLabel')}</div>
          <div className={styles.desc}>{t('memoryAutoExtractDesc')}</div>
        </div>
        <Switch
          checked={settings.autoExtractMemory}
          onChange={setAutoExtractMemory}
          label={t('memoryAutoExtractLabel')}
        />
      </div>

      <div className={styles.toggleRow}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memoryExtractEngineLabel')}</div>
          <div className={styles.desc}>
            {settings.memoryExtractEngine === 'local' &&
            !isLocalModel(settings.model) &&
            !lastLocalModelSelection()
              ? t('memoryExtractLocalMissing')
              : t('memoryExtractEngineDesc')}
          </div>
        </div>
        <Select
          value={settings.memoryExtractEngine}
          ariaLabel={t('memoryExtractEngineLabel')}
          options={[
            { value: 'auto', label: t('memoryExtractAuto') },
            { value: 'flash', label: t('memoryExtractFlash') },
            { value: 'local', label: t('memoryExtractLocal') },
          ]}
          onChange={(value) => setMemoryExtractEngine(value as 'auto' | 'flash' | 'local')}
        />
      </div>

      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={newText}
          placeholder={t('memoryAddPlaceholder')}
          onChange={(event) => setNewText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              handleAdd()
            }
          }}
        />
        <Button size="m" disabled={!newText.trim()} onClick={handleAdd}>
          {t('memoryAddButton')}
        </Button>
      </div>

      {items.length > 0 ? (
        <div className={styles.list}>
          {items.map((item) => {
            const editing = editingId === item.id
            return (
              <div
                key={item.id}
                className={clsx(styles.item, !item.enabled && styles.itemDisabled)}
              >
                {editing ? (
                  <div className={styles.editBox}>
                    <textarea
                      className={styles.textarea}
                      autoFocus
                      value={editDraft}
                      onChange={(event) => setEditDraft(event.target.value)}
                    />
                    <div className={styles.editActions}>
                      <Button size="s" variant="outlined" onClick={() => setEditingId(null)}>
                        {t('cancel')}
                      </Button>
                      <Button
                        size="s"
                        disabled={!editDraft.trim()}
                        onClick={() => {
                          if (updateSavedMemory(item.id, editDraft)) {
                            setEditingId(null)
                          }
                        }}
                      >
                        {t('save')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className={styles.itemContent}>{item.content}</div>
                    <div className={styles.actions}>
                      <Switch
                        checked={item.enabled}
                        onChange={() => toggleSavedMemory(item.id)}
                        label={item.content}
                      />
                      <IconButton
                        size="xs"
                        icon={<IconEditOutline16 />}
                        tooltip={t('memoryEditTooltip')}
                        onClick={() => {
                          setEditingId(item.id)
                          setEditDraft(item.content)
                        }}
                      />
                      <IconButton
                        size="xs"
                        icon={<IconTrashOutline16 />}
                        tooltip={t('memoryDeleteTooltip')}
                        onClick={() => deleteSavedMemory(item.id)}
                      />
                    </div>
                  </>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div className={styles.empty}>{t('memoryEmpty')}</div>
      )}

      {items.length > 0 ? (
        <div className={styles.clearRow}>
          <Button variant="dangerOutlined" size="s" onClick={clearSavedMemories}>
            {t('memoryClearAll')}
          </Button>
        </div>
      ) : null}

      <div className={styles.groupTitle}>{t('memoryBankSection')}</div>

      <div className={styles.archiveRow}>
        <Button variant="outlined" size="s" onClick={exportMemories}>
          {t('memoryExport')}
        </Button>
        <Button variant="outlined" size="s" onClick={() => fileRef.current?.click()}>
          {t('memoryImport')}
        </Button>
        <input
          ref={fileRef}
          className={styles.hiddenInput}
          type="file"
          accept=".json,application/json"
          onChange={(event) => {
            const file = event.target.files?.[0]
            event.target.value = ''
            if (file) {
              void importMemories(file)
            }
          }}
        />
        <span className={styles.hint}>{t('memoryArchiveHint')}</span>
      </div>

      <div className={styles.toggleRow}>
        <div className={styles.text}>
          <div className={styles.label}>{t('memoryBankEnabledLabel')}</div>
          <div className={styles.desc}>{t('memoryBankEnabledDesc')}</div>
        </div>
        <Switch
          checked={settings.memoryBankEnabled}
          onChange={setMemoryBankEnabled}
          label={t('memoryBankEnabledLabel')}
        />
      </div>

      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <div className={styles.label}>{t('memoryBankDimensionLabel')}</div>
          <Select
            ariaLabel={t('memoryBankDimensionLabel')}
            value={String(settings.memoryBankDimension)}
            options={DIMENSIONS.map((value) => ({ value: String(value), label: String(value) }))}
            onChange={(value) => setMemoryBankDimension(Number(value))}
          />
          <div className={styles.hint}>{t('memoryBankDimensionDesc')}</div>
          <div className={styles.dimensionUsage}>
            {t('memoryDimensionUsage', {
              dimension: bankUsage.dimension,
              count: bankUsage.nodes,
              size: formatBytes(bankUsage.vectorBytes),
            })}
          </div>
          <div className={styles.hint}>{t('memoryDimensionHint')}</div>
        </div>
        <div className={styles.field}>
          <div className={styles.label}>{t('memoryBankLimitLabel')}</div>
          <ParamControl
            label={t('memoryBankLimitLabel')}
            value={settings.memoryBankLimit}
            min={1}
            max={12}
            step={1}
            onChange={(value) => setMemoryBankLimit(value ?? 4)}
          />
        </div>
      </div>

      <div className={styles.fieldGrid}>
        <div className={styles.field}>
          <div className={styles.label}>{t('memoryBankThresholdLabel')}</div>
          <ParamControl
            label={t('memoryBankThresholdLabel')}
            value={settings.memoryBankThreshold}
            min={0}
            max={1}
            step={0.05}
            onChange={(value) => setMemoryBankThreshold(value ?? 0.15)}
          />
        </div>
      </div>

      <div className={styles.label}>{t('memoryBankWeightsLabel')}</div>
      <div className={styles.weights}>
        <ParamControl
          label={t('memoryBankKeywordWeight')}
          value={settings.memoryBankKeywordWeight}
          min={0}
          max={5}
          step={0.1}
          onChange={(value) => setMemoryBankWeight('keyword', value ?? 1)}
        />
        <ParamControl
          label={t('memoryBankTagWeight')}
          value={settings.memoryBankTagWeight}
          min={0}
          max={5}
          step={0.1}
          onChange={(value) => setMemoryBankWeight('tag', value ?? 0.5)}
        />
        <ParamControl
          label={t('memoryBankVectorWeight')}
          value={settings.memoryBankVectorWeight}
          min={0}
          max={5}
          step={0.1}
          onChange={(value) => setMemoryBankWeight('vector', value ?? 0.8)}
        />
        <ParamControl
          label={t('memoryBankEdgeWeight')}
          value={settings.memoryBankEdgeWeight}
          min={0}
          max={5}
          step={0.1}
          onChange={(value) => setMemoryBankWeight('edge', value ?? 0.4)}
        />
      </div>

      <div className={styles.addCard}>
        <input
          className={styles.input}
          value={nodeTitle}
          placeholder={t('memoryBankAddTitle')}
          onChange={(event) => setNodeTitle(event.target.value)}
        />
        <textarea
          className={styles.textarea}
          rows={3}
          value={nodeContent}
          placeholder={t('memoryBankAddContent')}
          onChange={(event) => setNodeContent(event.target.value)}
        />
        <div className={styles.addRow}>
          <input
            className={styles.input}
            value={nodeTags}
            placeholder={t('memoryBankAddTags')}
            onChange={(event) => setNodeTags(event.target.value)}
          />
          <Button size="m" disabled={!nodeContent.trim()} onClick={handleAddNode}>
            {t('memoryBankAddButton')}
          </Button>
        </div>
      </div>

      <div className={styles.meta}>
        {t('memoryBankNodes')}: {nodes.length} · {t('memoryBankEdges')}: {edges.length}
      </div>

      <div className={styles.groupTitle}>{t('memoryGraphTitle')}</div>
      {nodes.length > 0 ? (
        <>
          <MemoryGraph
            nodes={nodes}
            edges={edges}
            selectedId={selectedNode}
            onSelect={setSelectedNode}
          />
          {selected ? (
            <div className={styles.selectedNode}>
              <div className={styles.nodeHead}>
                <span className={styles.nodeTitle}>{selected.title}</span>
              </div>
              <div className={styles.itemContent}>{selected.content}</div>
              {selected.tags.length > 0 ? (
                <div className={styles.chips}>
                  {selected.tags.map((tag) => (
                    <span key={tag} className={styles.chip}>
                      {tag}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className={styles.hint}>{t('memoryGraphHint')}</div>
          )}
        </>
      ) : (
        <div className={styles.empty}>{t('memoryBankEmpty')}</div>
      )}

      {nodes.length > 0 ? (
        <div className={clsx(styles.list, styles.nodeList)}>
          {nodes.map((node) => {
            const nodeEdges = edges.filter(
              (edge) => edge.sourceId === node.id || edge.targetId === node.id
            )
            const degree = nodeEdges.length
            const neighbors = nodeEdges.slice(0, 3).flatMap((edge) => {
              const otherId = edge.sourceId === node.id ? edge.targetId : edge.sourceId
              const other = nodes.find((item) => item.id === otherId)
              return other ? [{ id: other.id, title: other.title, weight: edge.weight }] : []
            })
            return (
              <div key={node.id} className={styles.node}>
                <div className={styles.nodeHead}>
                  <span className={styles.nodeTitle}>{node.title}</span>
                  <span className={styles.meta}>
                    {t('memoryBankEdges')}: {degree}
                  </span>
                  <IconButton
                    size="xs"
                    icon={<IconTrashOutline16 />}
                    tooltip={t('memoryDeleteTooltip')}
                    onClick={() => deleteMemoryNode(node.id)}
                  />
                </div>
                <div className={styles.nodeContent}>{node.content}</div>
                {node.tags.length > 0 ? (
                  <div className={styles.chips}>
                    {node.tags.map((tag) => (
                      <span key={tag} className={styles.chip}>
                        {tag}
                      </span>
                    ))}
                  </div>
                ) : null}
                {neighbors.length > 0 ? (
                  <div className={styles.links}>
                    {neighbors.map((neighbor) => (
                      <span key={neighbor.id} className={styles.link}>
                        ↔ {neighbor.title} · {neighbor.weight.toFixed(2)}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            )
          })}
        </div>
      ) : (
        <div className={styles.empty}>{t('memoryBankEmpty')}</div>
      )}

      {nodes.length > 0 ? (
        <div className={styles.clearRow}>
          <Button variant="dangerOutlined" size="s" onClick={clearMemoryBank}>
            {t('memoryBankClear')}
          </Button>
        </div>
      ) : null}

      <div className={styles.groupTitle}>{t('memorySearchTitle')}</div>
      <div className={styles.addRow}>
        <input
          className={styles.input}
          value={query}
          placeholder={t('memorySearchPlaceholder')}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
              event.preventDefault()
              runSearch()
            }
          }}
        />
        <Button size="m" disabled={!query.trim()} onClick={runSearch}>
          {t('memorySearchButton')}
        </Button>
      </div>

      {debug ? (
        <div className={styles.debug}>
          <div className={styles.meta}>
            {t('memoryDebugScope', { nodes: debug.nodes, edges: debug.edges })}
          </div>
          <div className={styles.meta}>
            {t('memoryDebugMatches', {
              keyword: debug.keywordMatches,
              tag: debug.tagMatches,
              vector: debug.vectorMatches,
              edges: debug.edgesTraversed,
            })}
          </div>
          <div className={styles.meta}>
            {t('memoryDebugVectorInfo', {
              dimension: debug.config.dimension,
              tokens: debug.tokens.length,
              top: debug.candidates[0]?.total.toFixed(2) ?? '0.00',
            })}
          </div>
          {debug.candidates.length === 0 ? (
            <div className={styles.empty}>{t('memoryDebugEmpty')}</div>
          ) : (
            <div className={styles.debugTable}>
              <table>
                <thead>
                  <tr>
                    <th>{t('memoryDebugTitle')}</th>
                    <th>{t('memoryDebugKeyword')}</th>
                    <th>{t('memoryDebugTag')}</th>
                    <th>{t('memoryDebugVector')}</th>
                    <th>{t('memoryDebugEdge')}</th>
                    <th>{t('memoryDebugTotal')}</th>
                    <th>{t('memoryDebugPassed')}</th>
                  </tr>
                </thead>
                <tbody>
                  {debug.candidates.slice(0, 12).map((candidate) => (
                    <tr key={candidate.nodeId}>
                      <td className={styles.debugTitle}>{candidate.title}</td>
                      <td>{score(candidate.keyword)}</td>
                      <td>{score(candidate.tag)}</td>
                      <td>{score(candidate.vector)}</td>
                      <td>{score(candidate.edge)}</td>
                      <td>{score(candidate.total)}</td>
                      <td>{candidate.passed ? '✓' : '·'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ) : null}

      {pendingArchive ? (
        <Modal
          title={t('memoryImportConfirmTitle')}
          closable
          onClose={() => setPendingArchive(null)}
          footer={
            <div className={styles.importActions}>
              <Button variant="outlined" size="m" onClick={() => setPendingArchive(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="outlined"
                size="m"
                onClick={() => {
                  applyMemoryArchive(pendingArchive, 'merge' satisfies ImportMode)
                  setPendingArchive(null)
                  showToast({ key: 'memoryImported' })
                }}
              >
                {t('memoryImportMerge')}
              </Button>
              <Button
                variant="danger"
                size="m"
                onClick={() => {
                  applyMemoryArchive(pendingArchive, 'replace' satisfies ImportMode)
                  setPendingArchive(null)
                  showToast({ key: 'memoryImported' })
                }}
              >
                {t('memoryImportReplace')}
              </Button>
            </div>
          }
        >
          {t('memoryImportConfirmDesc', {
            saved: pendingArchive.savedMemories.length,
            nodes: pendingArchive.nodes.length,
            edges: pendingArchive.edges.length,
          })}
        </Modal>
      ) : null}
    </div>
  )
}
