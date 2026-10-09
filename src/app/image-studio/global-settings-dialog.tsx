'use client';

import { useProductDialog } from '@/components/useProductDialog';
import { ContextClipboardActions } from '@/components/ContextClipboardActions';
import { GenerationCompletionSettings } from '@/components/GenerationCompletion';

import { useEffect, useRef, useState, type ComponentProps } from 'react';
import { RefreshCw, Save, X } from 'lucide-react';
import { useDialogDismiss } from '@/components/useDialogDismiss';
import { IMAGE_STUDIO_MODELS, IMAGE_STUDIO_MODEL_LABELS, IMAGE_STUDIO_MODEL_QUALITY_OPTIONS,
  IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS, IMAGE_STUDIO_QUALITY_LABELS, defaultImageResolution, defaultImageStudioQuality,
  type ImageStudioModel } from '@/lib/image-studio/model-catalog';
import { MAX_REFERENCE_IMAGES } from '@/lib/image-studio/limits';
import { supportsStudioFourToOne } from '@/lib/image-generation/resolution';
import type { StudioTemplateDefaults } from '@/lib/image-studio/template-defaults';
import { RatioPicker } from './ratio-picker';
import { usePageExitRisk } from '@/lib/hooks/page-exit-guard';
import type { useStudioSettings } from './use-studio-settings';
import styles from './studio.module.css';

export function StudioGlobalSettingsDialog({ open, onClose, editor, ownerId, canEdit, ratios }: {
  open: boolean; onClose: () => void; editor: ReturnType<typeof useStudioSettings>; ownerId: string; canEdit: boolean;
  ratios: Pick<ComponentProps<typeof RatioPicker>, 'custom' | 'busy' | 'error' | 'onRetry' | 'onCustom'>;
}) {
  const { confirm, productDialog } = useProductDialog();
  const dialog = useRef<HTMLDialogElement>(null);
  const contextInput = useRef<HTMLTextAreaElement>(null);
  const saveLock = useRef(false);
  const [ratioEditing, setRatioEditing] = useState(false);
  const defaults = editor.draft?.templateDefaults;
  const supportsFourToOne = (model: ImageStudioModel) => editor.settings?.modelFourToOne?.[model] ?? supportsStudioFourToOne(model);
  const fourToOneAvailable = defaults ? supportsFourToOne(defaults.model) : false;
  const selectedModelReady = defaults
    ? editor.settings?.modelReady?.[defaults.model] ?? editor.settings?.providerReady
    : undefined;
  usePageExitRisk({ unsaved: ratioEditing ? ['图片默认比例'] : [],
    busy: open && ratios.busy ? ['图片比例正在保存'] : [], revision: String(ratioEditing) });
  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);
  const close = async () => {
    if (canEdit && (editor.saving || ratios.busy)) return;
    if (canEdit && (editor.dirty || ratioEditing) && !(await confirm('修改尚未保存。关闭后会保留当前草稿，确定关闭吗？', { title: '关闭编辑', confirmLabel: '关闭编辑' }))) return;
    onClose();
  };
  useDialogDismiss({ open, dialogRef: dialog, nativeDialog: true, onDismiss: close });
  const reload = async () => {
    if (!canEdit || editor.loading || editor.saving) return;
    if (!editor.dirty || (await confirm('重新读取会替换未保存的通用设置，是否继续？', { title: '重新读取', confirmLabel: '放弃修改并读取' }))) void editor.controller.load(true);
  };
  const save = async () => {
    if (!canEdit || saveLock.current || editor.saving || editor.loading || ratios.busy || ratioEditing) return;
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
    {canEdit && <>{editor.draft && defaults && <>
      <label className={styles.label} htmlFor="studio-context">通用上下文</label>
      <ContextClipboardActions value={editor.draft.context} textareaRef={contextInput} onPaste={value => { if (canEdit) editor.controller.editContext(value); }} maxLength={20000} disabled={!canEdit || editor.loading || editor.saving || !open} />
      <textarea ref={contextInput} id="studio-context" rows={12} maxLength={20000} disabled={!canEdit || editor.loading}
        value={editor.draft.context} onChange={event => { if (canEdit) editor.controller.editContext(event.target.value); }} />
      <section className={styles.auxiliarySection} aria-labelledby="studio-template-defaults-title">
        <div className={styles.imageSectionHeading}><strong id="studio-template-defaults-title">模板统一默认值</strong></div>
        <p className={styles.muted}>适用范围：新建模块</p>
        <div className={styles.referenceLimits}>
          <div className={styles.primaryRange} role="group" aria-label="默认主图张数范围"><span>主图</span>
            <select aria-label="主图最少张数" value={defaults.primaryMin} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ primaryMin: Number(event.target.value) })}>
              {Array.from({ length: defaults.primaryMax + 1 }, (_, value) => <option key={value} value={value}>{value}</option>)}
            </select><span aria-hidden="true">-</span>
            <select aria-label="主图最多张数" value={defaults.primaryMax} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ primaryMax: Number(event.target.value) })}>
              {Array.from({ length: MAX_REFERENCE_IMAGES - defaults.primaryMin + 1 }, (_, index) => {
                const value = defaults.primaryMin + index;
                return value > 0 ? <option key={value} value={value}>{value}</option> : null;
              })}
            </select><span>张</span>
          </div>
          {([
            ['styleMax', '风格上限'], ['referenceMax', '参考上限'], ['auxiliaryMax', '辅助总上限'],
          ] as const).map(([key, label]) => <label key={key}>{label}
            <select aria-label={`${label}张数`} value={defaults[key]} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ [key]: Number(event.target.value) } as Partial<StudioTemplateDefaults>)}>
              {Array.from({ length: MAX_REFERENCE_IMAGES + 1 }, (_, value) => <option key={value} value={value}>{value} 张</option>)}
            </select>
          </label>)}
        </div>
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField}><strong>生成模型</strong>
            <select value={defaults.model} disabled={!canEdit || editor.loading} onChange={event => {
              const model = event.target.value as ImageStudioModel;
              editor.controller.editTemplateDefaults({ model, quality: defaultImageStudioQuality(model), resolution: defaultImageResolution(model),
                ...(defaults.aspectRatio === '4:1' && !supportsFourToOne(model) ? { aspectRatio: 'auto' } : {}) });
            }}>
              {IMAGE_STUDIO_MODELS.map(model => {
                const ready = editor.settings?.modelReady?.[model] ?? editor.settings?.providerReady;
                return <option key={model} value={model}>{IMAGE_STUDIO_MODEL_LABELS[model]}{ready === false ? '（服务未就绪）' : ''}</option>;
              })}
            </select>
          </label>
          <label className={styles.compactField}><strong>图片质量</strong>
            <select value={defaults.quality} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ quality: event.target.value as typeof defaults.quality })}>
              {IMAGE_STUDIO_MODEL_QUALITY_OPTIONS[defaults.model].map(option => <option key={option} value={option}>{IMAGE_STUDIO_QUALITY_LABELS[option]}</option>)}
            </select>
          </label>
          <label className={styles.compactField}><strong>分辨率</strong>
            <select value={defaults.resolution} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ resolution: event.target.value as typeof defaults.resolution })}>
              {IMAGE_STUDIO_MODEL_RESOLUTION_OPTIONS[defaults.model].map(option => <option key={option} value={option}>{option}</option>)}
            </select>
          </label>
        </div>
        <div className={styles.modelQualityRow}>
          <label className={styles.compactField}><strong>生成张数</strong>
            <select value={defaults.count} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ count: Number(event.target.value) })}>
              {Array.from({ length: 8 }, (_, index) => index + 1).map(value => <option key={value} value={value}>{value}</option>)}
            </select>
          </label>
          <RatioPicker value={defaults.aspectRatio} onChange={aspectRatio => editor.controller.editTemplateDefaults({ aspectRatio })}
            model={defaults.model} resolution={defaults.resolution} fourToOneSupported={fourToOneAvailable}
            {...ratios} disabled={!canEdit || editor.loading || editor.saving || !open} onEditing={setRatioEditing} />
          <label className={styles.referenceToggle}>
            <input type="checkbox" checked={defaults.useFixedReferences} disabled={!canEdit || editor.loading}
              onChange={event => editor.controller.editTemplateDefaults({ useFixedReferences: event.target.checked })} />使用模板固定参考图
          </label>
        </div>
        {selectedModelReady === false && <p className={styles.muted}>所选模型的图片服务当前未就绪；这里仍可保存默认值，服务就绪后再使用。</p>}
      </section>
      <p className={styles.label}>通用模型积分规则</p>
      {IMAGE_STUDIO_MODELS.map(model => <label className={styles.label} key={model}>{IMAGE_STUDIO_MODEL_LABELS[model]} 每张积分
        <input type="number" min={0} max={100000} step={1} disabled={!canEdit || editor.loading}
          placeholder={model === 'gemini-3-pro-image-preview' ? '未设置' : '20'} value={editor.draft?.prices[model] ?? ''}
          onChange={event => { if (canEdit) editor.controller.editPrice(model, event.target.value === '' ? null : Number(event.target.value)); }} />
      </label>)}
      <button type="button" className={styles.primary} disabled={!canEdit || !editor.dirty || editor.loading || editor.saving || ratios.busy || ratioEditing} onClick={save}><Save size={16} />{editor.saving ? '正在保存' : '保存设置'}</button>
    </>}
    <p role="status">{editor.status || '正在读取通用设置'}</p>
    {editor.error && <div role="alert" className={styles.error}>{editor.error}
      <button type="button" disabled={!canEdit || editor.loading || editor.saving} onClick={reload}><RefreshCw size={16} />重新读取</button>
    </div>}</>}
  </dialog>)}</>;
}
