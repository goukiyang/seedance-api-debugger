'use client';

import { useProductDialog } from '@/components/useProductDialog';

import { useEffect, useRef, useState } from 'react';
import { Copy, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import styles from './template-studio.module.css';

type ContextValue = { context?: string; revision: number; canEdit: boolean; canCopy: boolean; configured: boolean };

export default function VideoContextEditor({ draftId, onClose }: { draftId?: string; onClose(): void }) {
  const { confirm, productDialog } = useProductDialog();
  const [value, setValue] = useState<ContextValue | null>(null);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const backdropRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const url = `/api/template-studio/context${draftId ? `?draftId=${encodeURIComponent(draftId)}` : ''}`;
  useEffect(() => {
    const controller = new AbortController();
    void fetch(url, { cache: 'no-store', signal: controller.signal }).then(async response => {
      const data = await response.json();
      if (!response.ok) throw new Error(response.status < 500 ? data.error : '读取上下文失败，请关闭后重试');
      if (controller.signal.aborted) return;
      setValue(data); setText(data.context || '');
    }).catch(error => { if (!controller.signal.aborted) setMessage(error instanceof Error ? error.message : '读取失败'); });
    return () => controller.abort();
  }, [url]);
  async function save() {
    if (!value?.canEdit || busy) return;
    setBusy(true); setMessage('');
    try {
      const response = await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ context: text, revision: value.revision }) });
      const data = await response.json();
      if (!response.ok) throw new Error(response.status < 500 ? data.error : '保存失败，编辑仍保留，请重试');
      setValue(data); setMessage('已保存');
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败'); }
    finally { setBusy(false); }
  }
  async function close() {
    if (busy) return;
    if (value?.canEdit && text !== (value.context || '') && !(await confirm('上下文尚未保存，确定关闭？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    onClose();
  }
  useDialogDismiss({
    open: true,
    dialogRef,
    dismissSurfaceRef: backdropRef,
    onDismiss: close,
    dismissOnOutside: !busy,
    dismissOnEscape: !busy,
  });
  return <>{productDialog}{(<div ref={backdropRef} className={styles.dialogBackdrop}>
    <section ref={dialogRef} className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby="video-context-title">
      <div className={styles.sectionHeading}><h2 id="video-context-title">{draftId ? '模块上下文' : '通用上下文'}</h2><button type="button" className={styles.iconButton} aria-label="关闭" title="关闭" disabled={busy} onClick={close}><X size={16} /></button></div>
      <p className={styles.fieldHint}>{draftId ? '只用于当前模块。保存后影响后续文案，已有记录不变。' : '用于视频文案，不影响图片。仅管理员可修改。'}</p>
      {value?.canEdit ? <div className={styles.field}><label htmlFor="video-context-text">固定规则</label><textarea id="video-context-text" rows={12} maxLength={12000} value={text} onChange={event => setText(event.target.value)} /></div>
        : <p>{value ? (value.configured ? '固定规则已配置，将由后台应用；当前账号无权查看或修改。' : '尚未配置固定规则，当前账号无权修改。') : '正在读取…'}</p>}
      {message && <p role="status">{message}</p>}
      <div className={styles.dialogFooter}>
        {value?.canEdit && value.canCopy && <button type="button" className={styles.quietButton} onClick={() => void navigator.clipboard.writeText(text).then(() => setMessage('已复制上下文')).catch(() => setMessage('复制失败，请重试'))}><Copy size={15} />复制上下文</button>}
        {value?.canEdit && <button type="button" className={styles.primaryButton} disabled={busy || text === (value.context || '')} onClick={() => void save()}><Save size={15} />{busy ? '保存中' : '保存上下文'}</button>}
      </div>
    </section>
  </div>)}</>;
}
