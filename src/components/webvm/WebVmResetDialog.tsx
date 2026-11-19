import { useTranslate } from '../../i18n/index.js'
import { Button } from '../base/Button.js'
import { Modal } from '../base/Modal.js'
import styles from './WebVM.module.css'

/** 重置 WebVM：清空 IndexedDB 覆盖层并重启，二次确认 */
export const WebVmResetDialog = ({
  onClose,
  onConfirm,
}: {
  onClose: () => void
  onConfirm: () => void
}) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('webvmReset')}
      onClose={onClose}
      className={styles.confirm}
      footer={
        <div className={styles.confirmActions}>
          <Button variant="outlined" onClick={onClose}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={onConfirm}>
            {t('webvmReset')}
          </Button>
        </div>
      }
    >
      <div>{t('webvmResetConfirm')}</div>
      <div className={styles.confirmHint}>{t('webvmResetHint')}</div>
    </Modal>
  )
}
