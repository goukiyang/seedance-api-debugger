'use client';

import { useEffect, useRef } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS } from '@/lib/image-studio/model-catalog';
import type { useStudioSettings } from './use-studio-settings';
import styles from './studio.module.css';

export function StudioGlobalSettingsDialog({ open, onClose, editor }: {
  open: boolean; onClose: () => void; editor: ReturnType<typeof useStudioSettings>;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const backdropStart = useRef(false);
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = () => {
    if (editor.dirty && !window.confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？')) return;
    onClose();
  };
  const reload = () => {
    if (!editor.dirty || window.confirm('重新读取会替换未保存的通用设置，是否继续？')) void editor.controller.load(true);
  };
  const save = () => {
    if (editor.settings?.context?.trim() && editor.draft && !editor.draft.context.trim()
      && !window.confirm('确定清空通用上下文？这会影响所有模板之后的新生成，模板自己的上下文会保留。')) return;
    void editor.controller.save();
  };
  return <dialog ref={dialog} className={styles.dialog}
    onCancel={event => { event.preventDefault(); close(); }}
    onPointerDown={event => { backdropStart.current = event.target === event.currentTarget; }}
    onClick={event => { if (backdropStart.current && event.target === event.currentTarget) close(); backdropStart.current = false; }}>
    <header className={styles.header}><h2>通用上下文</h2><button type="button" aria-label="关闭设置" onClick={close}><X size={20} /></button></header>
    {editor.draft && <>
      <label className={styles.label} htmlFor="studio-context">通用上下文</label>
      <textarea id="studio-context" rows={12} maxLength={20000} disabled={editor.loading}
        value={editor.draft.context} onChange={event => editor.controller.editContext(event.target.value)} />
      <p className={styles.label}>通用模型积分规则</p>
      {IMAGE_STUDIO_MODELS.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
        <input type="number" min={0} max={100000} step={1} disabled={editor.loading}
          placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={editor.draft?.prices[model] ?? ''}
          onChange={event => editor.controller.editPrice(model, event.target.value === '' ? null : Number(event.target.value))} />
      </label>)}
      <button type="button" disabled={!editor.dirty || editor.loading || editor.saving} onClick={save}><Save size={16} />保存设置</button>
    </>}
    <p role="status">{editor.status || '正在读取通用设置'}</p>
    {editor.error && <div role="alert" className={styles.error}>{editor.error}
      <button type="button" disabled={editor.loading || editor.saving} onClick={reload}><RefreshCw size={16} />重新读取</button>
    </div>}
  </dialog>;
}
