'use client';

import { useProductDialog } from '@/components/useProductDialog';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';

import { useEffect, useRef } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import type { useStudioSettings } from './use-studio-settings';
import styles from './studio.module.css';

export function StudioGlobalSettingsDialog({ open, onClose, editor }: {
  open: boolean; onClose: () => void; editor: ReturnType<typeof useStudioSettings>;
}) {
  const { confirm, productDialog } = useProductDialog();
  const dialog = useRef<HTMLDialogElement>(null);
  const contextInput = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = async () => {
    if (editor.saving) return;
    if (editor.dirty && !(await confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    onClose();
  };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  const reload = async () => {
    if (!editor.dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) void editor.controller.load(true);
  };
  const save = async () => {
    if (editor.settings?.context?.trim() && editor.draft && !editor.draft.context.trim()
      && !(await confirm('确定清空通用上下文？这会影响所有模板之后的新生成，模板自己的上下文会保留。', { title: '清空上下文', confirmLabel: '清空并保存', danger: true }))) return;
    void editor.controller.save();
  };
  return <>{productDialog}{(<dialog ref={dialog} className={styles.dialog}>
    <header className={styles.header}><h2>通用上下文</h2><button type="button" aria-label="关闭设置" onClick={close}><X size={20} /></button></header>
    {editor.draft && <>
      <label className={styles.label} htmlFor="studio-context">通用上下文</label>
      <ContextClipboardActions value={editor.draft.context} textareaRef={contextInput} onPaste={editor.controller.editContext} maxLength={20000} disabled={editor.loading || editor.saving || !open} />
      <textarea ref={contextInput} id="studio-context" rows={12} maxLength={20000} disabled={editor.loading}
        value={editor.draft.context} onChange={event => editor.controller.editContext(event.target.value)} />
      <p className={styles.label}>通用模型积分规则</p>
      {IMAGE_STUDIO_MODELS.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
        <input type="number" min={0} max={100000} step={1} disabled={editor.loading}
          placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={editor.draft?.prices[model] ?? ''}
          onChange={event => editor.controller.editPrice(model, event.target.value === '' ? null : Number(event.target.value))} />
      </label>)}
      <button type="button" className={styles.primary} disabled={!editor.dirty || editor.loading || editor.saving} onClick={save}><Save size={16} />保存设置</button>
    </>}
    <p role="status">{editor.status || '正在读取通用设置'}</p>
    {editor.error && <div role="alert" className={styles.error}>{editor.error}
      <button type="button" disabled={editor.loading || editor.saving} onClick={reload}><RefreshCw size={16} />重新读取</button>
    </div>}
  </dialog>)}</>;
}
