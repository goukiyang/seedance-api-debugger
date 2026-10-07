'use client';

import { useProductDialog } from '@/components/useProductDialog';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';
import { GenerationCompletionSettings } from '@/components/GenerationCompletion';

import { useEffect, useRef } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import type { useStudioSettings } from './use-studio-settings';
import styles from './studio.module.css';

export function StudioGlobalSettingsDialog({ open, onClose, editor, ownerId, canEdit }: {
  open: boolean; onClose: () => void; editor: ReturnType<typeof useStudioSettings>; ownerId: string; canEdit: boolean;
}) {
  const { confirm, productDialog } = useProductDialog();
  const dialog = useRef<HTMLDialogElement>(null);
  const contextInput = useRef<HTMLTextAreaElement>(null);
  const saveLock = useRef(false);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = async () => {
    if (canEdit && editor.saving) return;
    if (canEdit && editor.dirty && !(await confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    onClose();
  };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  const reload = async () => {
    if (!canEdit || editor.loading || editor.saving) return;
    if (!editor.dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) void editor.controller.load(true);
  };
  const save = async () => {
    if (!canEdit || saveLock.current || editor.saving || editor.loading) return;
    saveLock.current = true;
    try {
      if (editor.settings?.context?.trim() && editor.draft && !editor.draft.context.trim()
        && !(await confirm('确定清空通用上下文？这会影响所有模板之后的新生成，模板自己的上下文会保留。', { title: '清空上下文', confirmLabel: '清空并保存', danger: true }))) return;
      if (await editor.controller.save()) onClose();
    } finally { saveLock.current = false; }
  };
  return <>{productDialog}{(<dialog ref={dialog} className={`${styles.dialog} ${styles.contextDialog}`}>
    <header className={styles.header}><h2>通用设置</h2><button type="button" aria-label="关闭设置" onClick={close}><X size={20} /></button></header>
    {open && <GenerationCompletionSettings key={ownerId} ownerId={ownerId} />}
    {canEdit && <>{editor.draft && <>
      <label className={styles.label} htmlFor="studio-context">通用上下文</label>
      <ContextClipboardActions value={editor.draft.context} textareaRef={contextInput} onPaste={value => { if (canEdit) editor.controller.editContext(value); }} maxLength={20000} disabled={!canEdit || editor.loading || editor.saving || !open} />
      <textarea ref={contextInput} id="studio-context" rows={12} maxLength={20000} disabled={!canEdit || editor.loading}
        value={editor.draft.context} onChange={event => { if (canEdit) editor.controller.editContext(event.target.value); }} />
      <p className={styles.label}>通用模型积分规则</p>
      {IMAGE_STUDIO_MODELS.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
        <input type="number" min={0} max={100000} step={1} disabled={!canEdit || editor.loading}
          placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={editor.draft?.prices[model] ?? ''}
          onChange={event => { if (canEdit) editor.controller.editPrice(model, event.target.value === '' ? null : Number(event.target.value)); }} />
      </label>)}
      <button type="button" className={styles.primary} disabled={!canEdit || !editor.dirty || editor.loading || editor.saving} onClick={save}><Save size={16} />{editor.saving ? '正在保存' : '保存设置'}</button>
    </>}
    <p role="status">{editor.status || '正在读取通用设置'}</p>
    {editor.error && <div role="alert" className={styles.error}>{editor.error}
      <button type="button" disabled={!canEdit || editor.loading || editor.saving} onClick={reload}><RefreshCw size={16} />重新读取</button>
    </div>}</>}
  </dialog>)}</>;
}
