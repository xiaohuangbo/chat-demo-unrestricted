import { useEffect, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { showToast } from '../base/toastState.js'
import {
  clonePreset,
  createPreset,
  deletePreset,
  renamePreset,
  selectPreset,
  usePromptPresets,
  type PromptPresetKind,
} from '../../services/promptPresets.js'
import styles from './PromptPresetBar.module.css'

/**
 * 系统提示词 / 思维链的多套预设切换条。
 *
 * 只负责管理预设库与选中状态；内容仍由父组件写回 settings，
 * 因此会话级提示词、请求管线与恢复默认等逻辑保持原样。
 */
export const PromptPresetBar = ({
  kind,
  content,
  onApply,
}: {
  kind: PromptPresetKind
  content: string
  onApply: (value: string) => void
}) => {
  const t = useTranslate()
  const presets = usePromptPresets((state) => (kind === 'system' ? state.system : state.cot))
  const activeId = usePromptPresets((state) =>
    kind === 'system' ? state.systemActiveId : state.cotActiveId
  )
  const active = presets.find((item) => item.id === activeId) ?? null
  const [renaming, setRenaming] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    setConfirmDelete(false)
  }, [activeId])

  const nextName = () => `${t('promptPresetsNamePrefix')} ${presets.length + 1}`

  const create = () => {
    const item = createPreset(kind, nextName(), content)
    if (!item) {
      showToast({ key: 'promptPresetsLimit', type: 'error' })
      return
    }
    onApply(item.content)
    showToast({ key: 'promptPresetsCreated' })
  }

  const clone = () => {
    const name = active ? `${active.name} ${t('promptPresetsCloneSuffix')}` : nextName()
    const item = clonePreset(kind, content, name)
    if (!item) {
      showToast({ key: 'promptPresetsLimit', type: 'error' })
      return
    }
    onApply(item.content)
    showToast({ key: 'promptPresetsCloned' })
  }

  const choose = (id: string, value: string) => {
    selectPreset(kind, id)
    onApply(value)
  }

  const useAuto = () => {
    selectPreset(kind, null)
    onApply('')
  }

  const saveRename = () => {
    if (!active || !renaming) {
      return
    }
    const name = renaming.trim()
    if (!name) {
      return
    }
    renamePreset(kind, active.id, name)
    setRenaming(null)
  }

  const remove = () => {
    if (!active) {
      return
    }
    deletePreset(kind, active.id)
    onApply('')
    setConfirmDelete(false)
    showToast({ key: 'promptPresetsDeleted' })
  }

  const autoActive = kind === 'system' && !active && content.trim() === ''

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div className={styles.title}>
          {t(kind === 'system' ? 'promptPresetsSystemTitle' : 'promptPresetsCotTitle')}
        </div>
        <div className={styles.actions}>
          <Button size="s" variant="outlined" onClick={create}>
            {t('promptPresetsNew')}
          </Button>
          <Button size="s" variant="outlined" onClick={clone}>
            {t('promptPresetsClone')}
          </Button>
          <Button
            size="s"
            variant="outlined"
            disabled={!active}
            onClick={() => {
              if (active) {
                setRenaming(active.name)
              }
            }}
          >
            {t('promptPresetsRename')}
          </Button>
          {active ? (
            confirmDelete ? (
              <Button size="s" variant="dangerOutlined" onClick={remove}>
                {t('promptPresetsDeleteConfirm')}
              </Button>
            ) : (
              <Button size="s" variant="dangerOutlined" onClick={() => setConfirmDelete(true)}>
                {t('promptPresetsDelete')}
              </Button>
            )
          ) : null}
        </div>
      </div>
      <div className={styles.hint}>{t('promptPresetsHint')}</div>

      <div className={styles.chips}>
        {kind === 'system' ? (
          <button
            type="button"
            className={styles.chip}
            data-active={autoActive || undefined}
            onClick={useAuto}
          >
            {t('promptPresetsAuto')}
          </button>
        ) : null}
        {presets.map((item) => (
          <button
            key={item.id}
            type="button"
            className={styles.chip}
            data-active={item.id === activeId || undefined}
            title={item.name}
            onClick={() => choose(item.id, item.content)}
          >
            {item.name}
          </button>
        ))}
        {presets.length === 0 ? (
          <span className={styles.empty}>{t('promptPresetsEmpty')}</span>
        ) : null}
      </div>

      {renaming !== null ? (
        <div className={styles.renameRow}>
          <input
            className={styles.input}
            value={renaming}
            maxLength={40}
            aria-label={t('promptPresetsRename')}
            onChange={(event) => setRenaming(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveRename()
              }
              if (event.key === 'Escape') {
                setRenaming(null)
              }
            }}
          />
          <Button size="s" onClick={saveRename}>
            {t('save')}
          </Button>
          <Button size="s" variant="outlined" onClick={() => setRenaming(null)}>
            {t('cancel')}
          </Button>
        </div>
      ) : null}

      <div className={styles.status}>
        {active
          ? t('promptPresetsActive', { name: active.name })
          : content.trim() !== ''
            ? t('promptPresetsUnsaved')
            : kind === 'system'
              ? t('promptPresetsAutoHint')
              : ''}
      </div>
    </div>
  )
}
