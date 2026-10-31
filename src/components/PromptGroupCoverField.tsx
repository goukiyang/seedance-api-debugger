'use client';

import { ImageIcon, Plus, X } from 'lucide-react';
import styles from './PromptGroupCoverField.module.css';

// Shared with the original image-studio prompt-group editor; saving stays with each editor.
export function PromptGroupCoverField({ assetId, coverUrl, disabled, onChoose, onUpload, onRemove, buttonClassName }: {
  assetId?: string | null; coverUrl?: string | null; disabled?: boolean;
  onChoose: () => void; onUpload?: (file: File) => void; onRemove: () => void; buttonClassName?: string;
}) {
  return <div className={styles.field} tabIndex={disabled ? -1 : 0} role="group" aria-label="封面"
    onDragOver={event => { if (onUpload && !disabled) event.preventDefault(); }}
    onDrop={event => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && onUpload && !disabled) onUpload(file); }}
    onPaste={event => {
      const file = Array.from(event.clipboardData.files).find(item => item.type.startsWith('image/'));
      if (file && onUpload && !disabled) { event.preventDefault(); onUpload(file); }
    }}>
    <span className={styles.preview}>{coverUrl ? <img src={coverUrl} alt="提示词组封面" width={64} height={64} /> : <ImageIcon size={24} aria-hidden="true" />}</span>
    <button type="button" className={buttonClassName} onClick={onChoose} disabled={disabled}><Plus size={16} />{assetId ? '更换封面' : '选择封面'}</button>
    {assetId && <button type="button" className={buttonClassName} title="移除封面" aria-label="移除封面" disabled={disabled} onClick={onRemove}><X size={16} /></button>}
  </div>;
}
